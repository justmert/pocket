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
