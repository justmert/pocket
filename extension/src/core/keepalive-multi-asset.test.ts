// Keeping TWO wrappers alive, which is what the wallet actually has.
//
// Every configured wrapper is its own confidential account with its own ledger
// entry and its own TTL. Bumping one does nothing for another, and the loop
// treated "we bumped something" as a fact about all of them: `lastKeepAlive`
// was a single timestamp assigned INSIDE the loop, and `recentlyActive` is
// tested at the top of every later iteration. So the first asset to need a bump
// suppressed every asset after it, for seven days.
//
// On the live deployment that is exactly the wrong way round. Measured at
// latestLedger 4018872: the XLM wrapper, which comes first, had ~22 days of
// headroom; the USDC wrapper, which comes second, had ~6.8. The one being
// silenced is the one about to archive.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";
// Static, not deferred: neither module is mocked here, and `onChain` below is
// initialised from IDENTITY at module scope.
import { commit, IDENTITY } from "./crypto/grumpkin";
import { addModQ } from "./crypto/field";

const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) =>
        k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) {
          // The in-flight record is written before the send and cleared on the
          // outcome, so by the end of a run it is gone. Recorded on the way
          // past, because its `kind` is what tells the popup whose transaction
          // this was.
          if (k === "pocket.inflight") inflightWrites.push(v as { kind?: string });
          store.set(k, v);
        }
      },
      remove: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
    },
  },
});

/** Every `pocket.inflight` record written during a run, in order. */
const inflightWrites: { kind?: string }[] = [];

/** Days of headroom per wrapper token, set per test. */
let headroom: Record<string, number> = {};

/** The account's spare XLM, in stroops. Plenty by default. */
let nativeStroops = 100_000_000n;
/** When true, the balance read fails, as an RPC outage makes it. */
let nativeUnreadable = false;

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readNative: async () => {
      if (nativeUnreadable) throw new Error("rpc down");
      return {
        raw: nativeStroops,
        subEntryCount: 0,
        numSponsoring: 0,
        numSponsored: 0,
        sellingLiabilities: 0n,
      };
    },
  };
});

vi.mock("./chain/ttl", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    // Only the ledger READ is faked. The planner, the loop and the per-token
    // bookkeeping are all the shipped ones.
    readAccountTtl: async (_s: unknown, token: string) => {
      const daysRemaining = headroom[token] ?? 90;
      return {
        // "expiring" is what `needsKeepAlive` keys on; anything else is not due.
        kind: daysRemaining <= 7 ? "expiring" : "healthy",
        expiresAt: new Date(Date.now() + daysRemaining * 86_400_000),
        daysRemaining,
      };
    },
  };
});

/**
 * The confidential account the post-merge write verifies itself against.
 *
 * The keep-alive now stages a `merge` resolution, because the contract's merge
 * is not a no-op: it folds receiving into spendable unconditionally, and
 * submitting it with nothing staged is what moved the chain out from under this
 * device's record. Staging means `persistVerified` reads the account back and
 * refuses a post-state the chain disagrees with, which is the point.
 *
 * Both accumulators are the identity here, matching the zero openings seeded
 * below: merging zero into zero leaves zero, so the check passes on the real
 * comparison rather than on a stubbed one.
 */
let onChain = { spendableCommitment: IDENTITY, receivingCommitment: IDENTITY };

vi.mock("./chain/confidential", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readConfidentialAccount: async () => ({
      ...onChain,
      viewingPublicKey: { x: 1n, y: 2n },
      auditorId: 0,
    }),
  };
});

/** Every wrapper this run actually submitted a bump for. */
const bumped: string[] = [];

vi.mock("./chain/keepalive", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const build = real.buildKeepAlive as (...a: unknown[]) => unknown;
  return {
    ...real,
    buildKeepAlive: (source: unknown, token: string, ...rest: unknown[]) => {
      bumped.push(token);
      return build(source, token, ...rest);
    },
  };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { Account } = await import("@stellar/stellar-sdk/base");

const LIST = NETWORKS.testnet.confidential;
const XLM = LIST[0]!.token;
const USDC = LIST[1]!.token;

beforeEach(() => {
  store.clear();
  bumped.length = 0;
  inflightWrites.length = 0;
  nativeStroops = 100_000_000n;
  nativeUnreadable = false;
  headroom = {};
  onChain = { spendableCommitment: IDENTITY, receivingCommitment: IDENTITY };
});

/**
 * Seed a local opening record for a wrapper, which a due keep-alive implies.
 *
 * `readAccountTtl` reads the CONFIDENTIAL ACCOUNT entry, so it only ever
 * reports "expiring" for an account that is registered on chain, and a
 * registered account this device can act for has openings. Without them the
 * loop now skips the bump, and rightly: the keep-alive submits a real `merge`,
 * which folds receiving into spendable unconditionally, so a device with no
 * local record to fold would be moving accumulators it cannot reconcile.
 *
 * Zeroes are the honest post-registration state and are enough here: this file
 * is about which wrappers get bumped, not about what the merge computes.
 */
async function seedOpenings(address: string) {
  const { openingKey } = await import("../lib/storage");
  const { sealPayload } = await import("./vault/vault");
  const { requireSession } = await import("./session");
  const { dek } = requireSession();
  const zero = { value: "0", randomness: "0" };
  for (const cfg of LIST) {
    store.set(
      openingKey(cfg.token, address),
      await sealPayload(dek, { spendable: zero, receiving: zero, syncedThrough: 0 }),
    );
  }
}

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    prepareTransaction: async (tx: unknown) => tx,
    sendTransaction: async () => ({ status: "PENDING" }),
    getTransaction: async () => ({ status: "SUCCESS", ledger: 9, applicationOrder: 1 }),
    getLedgerEntries: async () => ({ entries: [] }),
  });
  await seedOpenings(address);
  return c;
}

describe("two wrappers, two TTLs", () => {
  it("has more than one wrapper configured, or none of this is reachable", () => {
    // Guards the premise. If the list ever drops to one these tests pass
    // vacuously and the regression returns unnoticed.
    expect(LIST.length).toBeGreaterThan(1);
  });

  it("bumps BOTH when both are due, rather than stopping after the first", async () => {
    const c = await worker();
    headroom = { [XLM]: 5, [USDC]: 5 };

    await c.runKeepAlive();

    expect(bumped).toEqual([XLM, USDC]);
  });

  it("bumps the second even when the first was the one that needed it", async () => {
    // The live shape, and the failure it produced: bumping the comfortable
    // wrapper first marked the whole wallet "recently active", so the wrapper
    // with 6.8 days left was skipped for another seven.
    const c = await worker();
    headroom = { [XLM]: 5, [USDC]: 6 };

    await c.runKeepAlive();

    expect(bumped).toContain(USDC);
  });

  it("leaves an asset alone once its OWN entry has been bumped", async () => {
    // The suppression is right, it was just aimed at the wrong thing.
    const c = await worker();
    headroom = { [XLM]: 5, [USDC]: 5 };
    await c.runKeepAlive();
    bumped.length = 0;
    inflightWrites.length = 0;
    nativeStroops = 100_000_000n;
    nativeUnreadable = false;

    await c.runKeepAlive();
    expect(bumped).toEqual([]);
  });

  it("folds the received balance locally, matching what the merge did on chain", async () => {
    // The defect, with a NON-EMPTY receiving side, which is the only shape that
    // shows it. `storage::merge` is unconditional: spendable = spendable +
    // receiving, then receiving = identity, with no guard on receiving being
    // empty (storage.rs:539-547). keepalive.ts calls an empty merge "a no-op in
    // state terms", true only for the empty case, and nothing restricted the
    // bump to that case.
    //
    // Submitted unstaged, the chain folded and this device wrote nothing, so
    // the next read returned `diverged` and every spend was refused, by an
    // action the user never took and never saw.
    const c = new WalletController();
    await c.init();
    const { address } = await c.create("pw");
    (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
      getAccount: async () => new Account(address, "100"),
      prepareTransaction: async (tx: unknown) => tx,
      sendTransaction: async () => ({ status: "PENDING" }),
      getTransaction: async () => ({ status: "SUCCESS", ledger: 9, applicationOrder: 1 }),
      getLedgerEntries: async () => ({ entries: [] }),
    });

    const spendable = { value: 5_000_000n, randomness: 11n };
    const receiving = { value: 3_000_000n, randomness: 22n };
    const { openingKey } = await import("../lib/storage");
    const { sealPayload, openPayload } = await import("./vault/vault");
    const { requireSession } = await import("./session");
    const { dek } = requireSession();
    store.set(
      openingKey(XLM, address),
      await sealPayload(dek, {
        spendable: { value: "5000000", randomness: "11" },
        receiving: { value: "3000000", randomness: "22" },
        syncedThrough: 0,
      }),
    );
    // What the contract holds AFTER its merge: the two commitments added, and
    // the receiving side cleared. `persistVerified` compares against this, so a
    // wrong local fold is refused rather than written.
    onChain = {
      spendableCommitment: commit(
        spendable.value + receiving.value,
        addModQ(spendable.randomness, receiving.randomness),
      ),
      receivingCommitment: IDENTITY,
    };
    headroom = { [XLM]: 5 };

    await c.runKeepAlive();

    const sealed = store.get(openingKey(XLM, address)) as never;
    const after = await openPayload<{
      spendable: { value: string };
      receiving: { value: string };
    }>(dek, sealed);
    expect(after.spendable.value, "the received balance was not folded locally").toBe("8000000");
    expect(after.receiving.value, "the receiving side was not cleared locally").toBe("0");
  });

  it("stages the merge it submits, instead of moving the chain and writing nothing", async () => {
    // `storage::merge` is unconditional: spendable = spendable + receiving,
    // then receiving = identity, with no guard on receiving being empty
    // (storage.rs:539-547). keepalive.ts calls an empty merge "a no-op in state
    // terms", which is true only for the empty case, and nothing restricted the
    // bump to that case.
    //
    // So a background alarm against a pocket holding a received-but-unmerged
    // balance folded the accumulators on chain while this device wrote nothing,
    // and the next read returned `diverged`: every spend refused, by an action
    // the user never took and never saw. Every other private submission goes
    // through submitStaged with a resolution; this was the only one that did
    // not, and it was the only one nobody watches.
    const c = await worker();
    headroom = { [XLM]: 5, [USDC]: 5 };

    await c.runKeepAlive();

    // The consequence is written, not merely submitted: applyStaged ran and
    // left no staged record behind.
    expect(bumped).toEqual([XLM, USDC]);
    expect(store.has("pocket.staged"), "a staged merge was left unapplied").toBe(false);
    expect(store.has("pocket.inflight"), "the in-flight record was never cleared").toBe(false);
  });

  it("skips a wrapper this device has no openings for, rather than merging blind", async () => {
    // No local record means no post-state this device could verify, so a merge
    // here would produce exactly the divergence above with nothing to reconcile
    // against. Letting the entry archive is the lesser harm on this deployment:
    // protocol 27 auto-restores an archived persistent entry into the readWrite
    // footprint rather than failing the transaction.
    const c = new WalletController();
    await c.init();
    const { address } = await c.create("pw");
    (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
      getAccount: async () => new Account(address, "100"),
      prepareTransaction: async (tx: unknown) => tx,
      sendTransaction: async () => ({ status: "PENDING" }),
      getTransaction: async () => ({ status: "SUCCESS", ledger: 9, applicationOrder: 1 }),
      getLedgerEntries: async () => ({ entries: [] }),
    });
    headroom = { [XLM]: 5, [USDC]: 5 };

    await c.runKeepAlive();

    expect(bumped).toEqual([]);
  });

  it("skips only the wrapper that is missing, not the ones that are not", async () => {
    // One unreadable asset must not stop the bump every other asset may be due,
    // which is why the skip is a `continue` and not a throw.
    const c = new WalletController();
    await c.init();
    const { address } = await c.create("pw");
    (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
      getAccount: async () => new Account(address, "100"),
      prepareTransaction: async (tx: unknown) => tx,
      sendTransaction: async () => ({ status: "PENDING" }),
      getTransaction: async () => ({ status: "SUCCESS", ledger: 9, applicationOrder: 1 }),
      getLedgerEntries: async () => ({ entries: [] }),
    });
    const { openingKey } = await import("../lib/storage");
    const { sealPayload } = await import("./vault/vault");
    const { requireSession } = await import("./session");
    const zero = { value: "0", randomness: "0" };
    // Only the SECOND wrapper has a record.
    store.set(
      openingKey(USDC, address),
      await sealPayload(requireSession().dek, {
        spendable: zero,
        receiving: zero,
        syncedThrough: 0,
      }),
    );
    headroom = { [XLM]: 5, [USDC]: 5 };

    await c.runKeepAlive();

    expect(bumped).toEqual([USDC]);
  });

  it("reports the SOONEST asset's next check, not a flat week", async () => {
    // The loop computed a plan per asset and threw them all away. A wrapper
    // with days left was answered with "look again in a week".
    const c = await worker();
    headroom = { [XLM]: 60, [USDC]: 9 };

    const plan = await c.runKeepAlive();

    // The 9-day asset wants looking at with a week to spare, so ~2 days minus
    // up to a day of jitter: somewhere in (1, 2] days. The flat return was
    // `jitteredDelayMs(7)`, which lands in (6, 7], so the bound has to sit
    // between the two rather than merely under seven days.
    const DAY = 24 * 3600_000;
    expect(plan.nextCheckMs).toBeGreaterThan(0);
    expect(plan.nextCheckMs).toBeLessThanOrEqual(2 * DAY);
    expect(bumped).toEqual([]);
  });
});

/**
 * The in-flight record has to say WHOSE transaction it is.
 *
 * A keep-alive is sent on an alarm; the user pressed nothing. Stranded by
 * worker eviction its record put the full-screen "Unfinished transaction"
 * blocker in front of the whole wallet, reading exactly like a payment they had
 * made and lost track of, and there was nothing on the record to say otherwise.
 * `blockingInFlight` keys on this string.
 */
describe("what a keep-alive leaves on the in-flight record", () => {
  it("marks it as a keep-alive, not as a merge the user asked for", async () => {
    const c = await worker();
    headroom = { [XLM]: 5 };

    await c.runKeepAlive();

    expect(
      inflightWrites.length,
      "nothing was submitted, so there is nothing to check",
    ).toBeGreaterThan(0);
    for (const rec of inflightWrites) {
      expect(rec.kind, "a background bump is indistinguishable from a user's transaction").toBe(
        "keepalive",
      );
    }
  });
});

/**
 * A keep-alive costs money, and nothing checked whether the account had it.
 *
 * The bump is a real Soroban invocation: measured at 96,770 stroops on this
 * deployment. It is signed and paid for by an alarm with no screen in front of
 * it, and none of the wallet's eight balance guards sits on this path, because
 * every one of them belongs to a flow a user pressed a button in.
 */
describe("a keep-alive on an account with no spare XLM", () => {
  it("is skipped rather than submitted", async () => {
    const c = await worker();
    headroom = { [XLM]: 5, [USDC]: 5 };
    // One base reserve for the account itself, and a hundred stroops over it.
    nativeStroops = 10_000_100n;

    await c.runKeepAlive();

    expect(bumped, "signed a transaction the account cannot pay for").toEqual([]);
  });

  it("says why, rather than failing silently", async () => {
    const c = await worker();
    headroom = { [XLM]: 5 };
    nativeStroops = 10_000_100n;

    const plan = await c.runKeepAlive();
    expect(plan.notice ?? "").toMatch(/spare XLM/i);
  });

  it("does not refuse the bump when there IS spare", async () => {
    // The guard must not become the reason a healthy wallet stops keeping its
    // account alive.
    const c = await worker();
    headroom = { [XLM]: 5 };
    nativeStroops = 100_000_000n;
    nativeUnreadable = false;

    await c.runKeepAlive();
    expect(bumped).toContain(XLM);
  });

  it("bumps anyway when the balance cannot be read", async () => {
    // Refusing to keep an account alive because a balance read timed out is a
    // worse trade than letting the bump fail on its own terms, which is what
    // happened before the guard existed.
    const c = await worker();
    headroom = { [XLM]: 5 };
    nativeUnreadable = true;

    await c.runKeepAlive();
    expect(bumped).toContain(XLM);
  });
});

/**
 * A keep-alive must not take the sequence number of an envelope the user is
 * still looking at.
 *
 * `inFlight` covers what has been SENT. A built-and-staged envelope has not
 * been sent and already holds a sequence number, taken from the account when it
 * was built, while the user reads the confirm screen about it. A bump submitted
 * in that window consumes the number, and the Confirm they then press fails
 * with `txBadSeq` for a transaction they composed correctly, because of an
 * alarm they never saw. Proving a private operation can take over two minutes,
 * so the window is not narrow.
 */
describe("a keep-alive while something is staged", () => {
  it("waits, rather than consuming the sequence number", async () => {
    const c = await worker();
    headroom = { [XLM]: 5, [USDC]: 5 };
    // What a build leaves behind: a handle with an envelope and a timestamp.
    (c as unknown as { pending: Map<string, unknown> }).pending.set("deadbeef", {
      xdr: "AAAA",
      at: Date.now(),
      kind: "payment",
    });

    const plan = await c.runKeepAlive();

    expect(bumped, "bumped over an envelope the user is reviewing").toEqual([]);
    expect(plan.due).toBe(false);
    // Soon, not in a week: the review will be over in a minute or two.
    expect(plan.nextCheckMs).toBeLessThan(2 * 24 * 60 * 60 * 1000);
  });

  it("does not wait forever on a handle that has aged out", async () => {
    // An abandoned confirm must not hold the bump off for the rest of the
    // wallet's life. `prunePending` drops a handle past its envelope's own
    // deadline, and this runs after that.
    const c = await worker();
    headroom = { [XLM]: 5 };
    (c as unknown as { pending: Map<string, unknown> }).pending.set("stale", {
      xdr: "AAAA",
      at: Date.now() - 10 * 60_000,
      kind: "payment",
    });

    await c.runKeepAlive();
    expect(bumped).toContain(XLM);
  });
});

/**
 * A bump that did not land is tried again within the hour.
 *
 * `soonest` is the planner's answer for a healthy schedule, and on an asset
 * that is not yet urgent that is six or seven days: longer than the whole
 * margin `KEEPALIVE_THRESHOLD_DAYS` exists to give. So one failed submission,
 * for any reason at all, silently spent most of it, and the planner cannot know
 * it happened because only this loop sees the outcome.
 */
describe("a keep-alive that did not land", () => {
  it("comes back within the hour, not in a week", async () => {
    const c = await worker();
    headroom = { [XLM]: 5 };
    // What an RPC that will not queue it looks like from here.
    (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
      getAccount: async () => new Account((await c.status()).address!, "100"),
      prepareTransaction: async (tx: unknown) => tx,
      sendTransaction: async () => ({ status: "ERROR", errorResult: {} }),
      getTransaction: async () => ({ status: "NOT_FOUND" }),
      getLedgerEntries: async () => ({ entries: [] }),
    });

    const plan = await c.runKeepAlive();

    expect(plan.nextCheckMs, "a failed bump waited out the whole margin").toBeLessThanOrEqual(
      60 * 60 * 1000,
    );
    expect(plan.nextCheckMs, "and not a hot loop either").toBeGreaterThan(60_000);
  });

  it("keeps the ordinary schedule when the bump succeeded", async () => {
    // The control: a healthy run must not be dragged down to hourly polling.
    const c = await worker();
    headroom = { [XLM]: 5 };

    const plan = await c.runKeepAlive();
    expect(plan.nextCheckMs).toBeGreaterThan(24 * 60 * 60 * 1000);
  });
});

/**
 * The keep-alive's notice has to reach a screen.
 *
 * `KeepAlivePlan.notice` is documented as "what to tell the user" and its only
 * consumer was `background.ts`, which has no screen: the alarm runs whether or
 * not a popup exists, so the one place the sentence could be spoken never saw
 * it. The most useful thing it says is the newest: that the bump could not be
 * paid for.
 */
describe("what the keep-alive tells the user", () => {
  it("reaches the private pocket's own message", async () => {
    const c = await worker();
    headroom = { [XLM]: 5 };
    nativeStroops = 10_000_100n; // nothing spare

    const plan = await c.runKeepAlive();
    expect(plan.notice, "premise: the run produced something to say").toMatch(/spare XLM/i);

    const pocket = await c.privatePocket(XLM);
    expect(pocket.message ?? "", "the notice was written for a reader that cannot exist").toMatch(
      /spare XLM/i,
    );
  });

  it("stops saying it once the run has nothing to report", async () => {
    // A stale warning is its own defect: the user adds XLM, the next check
    // succeeds, and the sentence must go.
    const c = await worker();
    headroom = { [XLM]: 5 };
    nativeStroops = 10_000_100n;
    await c.runKeepAlive();

    nativeStroops = 100_000_000n;
    await c.runKeepAlive();

    const pocket = await c.privatePocket(XLM);
    expect(pocket.message ?? "").not.toMatch(/spare XLM/i);
  });
});
