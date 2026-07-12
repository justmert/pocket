// Lifecycle, interruption and concurrency, exercised rather than reasoned about.
//
// The scenarios here are the ones MV3 makes routine rather than exotic: the
// service worker is evicted after 30 seconds of inactivity, a fetch that takes
// longer than 30 seconds kills it outright, and any single request is capped at
// five minutes. Confirmation polling alone runs to fifteen seconds, so "the
// worker died between submit and the write that records what the submission
// did" is a normal Tuesday, and every test below is a version of it.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";

const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) => {
        if (k === null) return Object.fromEntries(store);
        return store.has(k) ? { [k]: store.get(k) } : {};
      },
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string | string[]) => {
        // chrome.storage.local.remove accepts one key OR an array. A mock that
        // only handles the string form silently drops a multi-key erase.
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
    },
  },
});

// The chain seam. Every test drives these directly, so nothing here reaches the
// network and the timing is ours to control.
let onChain: { spendable: { x: bigint; y: bigint }; receiving: { x: bigint; y: bigint } };
let sendResult: (tx: unknown) => { status: string };
let getTx: (hash: string) => Promise<unknown>;
let mergeBuilt: () => unknown;

vi.mock("./chain/confidential", () => ({
  readConfidentialAccount: async () => ({
    spendingPublicKey: { x: 1n, y: 2n },
    viewingPublicKey: { x: 3n, y: 4n },
    spendableCommitment: onChain.spendable,
    receivingCommitment: onChain.receiving,
    auditorId: 0,
  }),
  readAuditorKey: async () => ({ x: 5n, y: 6n }),
  ConfidentialReadError: class extends Error {},
}));

vi.mock("./confidential-ops", () => ({
  buildMerge: async () => mergeBuilt(),
}));

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { commit, IDENTITY } = await import("./crypto/grumpkin");
const { Account, TransactionBuilder, Operation, Asset, BASE_FEE } = await import(
  "@stellar/stellar-sdk/base"
);

const PASSPHRASE = NETWORKS.testnet.passphrase;
const TOKEN = NETWORKS.testnet.confidential[0]!.token;

/**
 * A real, XDR-round-trippable envelope from this account.
 *
 * The operation is irrelevant to what is under test: confirmPrivateOp checks
 * the source and the envelope type, and everything after that is submission and
 * bookkeeping.
 */
function envelope(address: string, seq: string) {
  return new TransactionBuilder(new Account(address, seq), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.payment({ destination: address, asset: Asset.native(), amount: "1" }))
    .setTimeout(180)
    .build();
}

/** A controller wired to a fake ledger, standing in for one service worker. */
async function worker(password = "pw", create = true) {
  const c = new WalletController();
  await c.init();
  const address = create
    ? (await c.create(password)).address
    : ((await c.unlock(password)).address as string);

  const server = {
    getAccount: async () => new Account(address, "100"),
    prepareTransaction: async (tx: unknown) => tx,
    sendTransaction: async (tx: unknown) => sendResult(tx),
    getTransaction: (hash: string) => getTx(hash),
    getLedgerEntries: async () => ({ entries: [] }),
  };
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", server);
  return { c, address };
}

function stage(
  c: InstanceType<typeof WalletController>,
  tx: { hash: () => Buffer; toXDR: () => string },
  resolve: unknown,
  follow = false,
) {
  const handle = tx.hash().toString("hex");
  (c as unknown as { pending: Map<string, unknown> }).pending.set(handle, {
    xdr: tx.toXDR(),
    at: Date.now(),
    private: { resolve, follow },
  });
  return handle;
}

const openings = (c: InstanceType<typeof WalletController>, address: string) =>
  (
    c as unknown as {
      readOpenings: (a: string, t: string) => Promise<unknown>;
    }
  ).readOpenings(address, TOKEN);

beforeEach(() => {
  store.clear();
  onChain = { spendable: IDENTITY, receiving: IDENTITY };
  sendResult = () => ({ status: "PENDING" });
  getTx = async () => ({ status: "SUCCESS", ledger: 7, applicationOrder: 1 });
  mergeBuilt = () => {
    throw new Error("no merge expected in this test");
  };
});

describe("shield is two transactions, and the second one can fail", () => {
  it("records the deposit before attempting the merge, so a failed merge leaves a spendable state", async () => {
    const { c, address } = await worker();
    const deposit = envelope(address, "100");
    const amount = 5_000_000n; // 0.5 XLM in stroops

    // The deposit lands. The merge is rejected outright by the RPC, which is
    // the realistic failure: a fee bump, a sequence collision, a bad footprint.
    const mergeTx = envelope(address, "101");
    mergeBuilt = () => mergeTx;
    const depositHash = deposit.hash().toString("hex");
    sendResult = (tx) =>
      (tx as { hash: () => Buffer }).hash().toString("hex") === depositHash
        ? { status: "PENDING" }
        : { status: "ERROR", errorResult: undefined };

    // The chain after the deposit: receiving holds the deposited amount,
    // unblinded, and spendable is untouched.
    onChain = { spendable: IDENTITY, receiving: commit(amount, 0n) };

    const handle = stage(c, deposit, { kind: "credit", amount: amount.toString() }, true);
    await expect(c.confirmPrivateOp(handle)).rejects.toThrow(/receiving balance/);

    // The point of the test. Before the fix nothing was written here, the local
    // record was short by exactly the deposit, privatePocket() reported
    // "diverged", and this build has no replay path: the funds were spendable
    // only on chain, and never again from this device.
    expect(await openings(c, address)).toEqual({
      spendable: { value: 0n, randomness: 0n },
      receiving: { value: amount, randomness: 0n },
      syncedThrough: 0,
    });
  });

  it("writes the merged state when both transactions land", async () => {
    const { c, address } = await worker();
    const deposit = envelope(address, "100");
    const amount = 3_000_000n;
    mergeBuilt = () => envelope(address, "101");

    // Deposit first, then the merge folds it in. The fake ledger moves with it.
    let landed = 0;
    getTx = async () => {
      landed++;
      onChain =
        landed === 1
          ? { spendable: IDENTITY, receiving: commit(amount, 0n) }
          : { spendable: commit(amount, 0n), receiving: IDENTITY };
      return { status: "SUCCESS", ledger: 7 + landed, applicationOrder: 1 };
    };

    const handle = stage(c, deposit, { kind: "credit", amount: amount.toString() }, true);
    const r = await c.confirmPrivateOp(handle);
    expect(r.followed).toBeTruthy();
    expect(await openings(c, address)).toEqual({
      spendable: { value: amount, randomness: 0n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 0,
    });
  });
});

describe("the worker dies between submit and the write", () => {
  it("recovers the opening a transfer produced, from a fresh worker", async () => {
    const { c, address } = await worker();
    const tx = envelope(address, "100");
    const after = {
      kind: "openings",
      spendable: ["4000000", "99"],
      receiving: ["0", "0"],
      syncedThrough: 3,
    };

    // Submitted, and then the worker is evicted mid-poll. Nothing resolves.
    getTx = () => new Promise(() => undefined);
    const handle = stage(c, tx, after);
    void c.confirmPrivateOp(handle).catch(() => undefined);
    await vi.waitFor(() => expect(store.has("pocket.inflight")).toBe(true));
    // The consequence is on disk before the network was ever touched.
    expect(store.has("pocket.staged")).toBe(true);

    // A new worker. The in-memory pending map is gone with the old one, which
    // is exactly what made this unrecoverable before.
    const fresh = await worker("pw", false);
    expect(await openings(fresh.c, address)).toBeNull();

    onChain = { spendable: commit(4_000_000n, 99n), receiving: IDENTITY };
    getTx = async () => ({ status: "SUCCESS", ledger: 12, applicationOrder: 1 });

    const outcome = await fresh.c.reconcileInFlight();
    expect(outcome?.kind).toBe("succeeded");
    expect(await openings(fresh.c, address)).toEqual({
      spendable: { value: 4_000_000n, randomness: 99n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 3,
    });
    expect(store.has("pocket.inflight")).toBe(false);
    expect(store.has("pocket.staged")).toBe(false);
  });

  it("discards the staged consequence when the transaction did not land", async () => {
    const { c, address } = await worker();
    const tx = envelope(address, "100");
    getTx = () => new Promise(() => undefined);
    const handle = stage(c, tx, {
      kind: "openings",
      spendable: ["4000000", "99"],
      receiving: ["0", "0"],
      syncedThrough: 3,
    });
    void c.confirmPrivateOp(handle).catch(() => undefined);
    await vi.waitFor(() => expect(store.has("pocket.staged")).toBe(true));

    const fresh = await worker("pw", false);
    getTx = async () => ({ status: "FAILED", ledger: 12, resultXdr: {} });
    const outcome = await fresh.c.reconcileInFlight();

    expect(outcome?.kind).toBe("failed");
    // Nothing happened on chain, so nothing may be written locally. Applying a
    // post-state for a transaction that failed is how a wallet invents a
    // balance it does not have.
    expect(await openings(fresh.c, address)).toBeNull();
    expect(store.has("pocket.staged")).toBe(false);
    expect(store.has("pocket.inflight")).toBe(false);
  });

  it("refuses to store an opening the chain does not agree with", async () => {
    const { c, address } = await worker();
    const tx = envelope(address, "100");
    getTx = () => new Promise(() => undefined);
    const handle = stage(c, tx, {
      kind: "openings",
      spendable: ["4000000", "99"],
      receiving: ["0", "0"],
      syncedThrough: 3,
    });
    void c.confirmPrivateOp(handle).catch(() => undefined);
    await vi.waitFor(() => expect(store.has("pocket.staged")).toBe(true));

    const fresh = await worker("pw", false);
    // The contract holds something else entirely.
    onChain = { spendable: commit(1n, 1n), receiving: IDENTITY };
    getTx = async () => ({ status: "SUCCESS", ledger: 12, applicationOrder: 1 });

    await expect(fresh.c.reconcileInFlight()).rejects.toThrow(/does not/);
    expect(await openings(fresh.c, address)).toBeNull();
    // Left in place: the user is brought back here rather than told all is well.
    expect(store.has("pocket.inflight")).toBe(true);
  });
});

describe("an RPC that never answers is not evidence the transaction expired", () => {
  // `pollToTerminal` reports "pending" for two different facts: the ledger said
  // NOT_FOUND, and no poll ever got through. Only the first is evidence.
  //
  // `reconcileInFlight` used to rewrite either one to "expired" once maxTime
  // had passed, and "expired" routes to `discardStaged`, which deletes the
  // staged post-state. So an outage spanning a three-minute timeBounds window
  // deleted the openings of an operation that may well have succeeded, on the
  // strength of an envelope being un-includable from now on, which says
  // nothing about whether it was included before.
  const stranded = async () => {
    const { c, address } = await worker();
    getTx = () => new Promise(() => undefined);
    const handle = stage(c, envelope(address, "100"), {
      kind: "spend",
      spendable: ["40000000", "5"],
    });
    void c.confirmPrivateOp(handle).catch(() => undefined);
    await vi.waitFor(() => expect(store.has("pocket.inflight")).toBe(true));
    // Rewind maxTime so the envelope is past it however the poll goes.
    const rec = store.get("pocket.inflight") as { hash: string; maxTime: number };
    store.set("pocket.inflight", { ...rec, maxTime: Math.floor(Date.now() / 1000) - 10 });
    return worker("pw", false);
  };

  it("keeps an unresolved submission unresolved when no poll got through", async () => {
    const fresh = await stranded();
    getTx = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };

    const outcome = await fresh.c.reconcileInFlight();
    expect(outcome?.kind).toBe("pending");
    // Both survive, so the next poll that gets through can still settle it.
    expect(store.has("pocket.staged")).toBe(true);
    expect(store.has("pocket.inflight")).toBe(true);
  });

  it("does expire it once the ledger has actually said it does not have it", async () => {
    // The behaviour the rewrite exists for is intact: an answered NOT_FOUND
    // past maxTime is genuinely un-includable, and leaving it pending would
    // wedge the unfinished-transaction screen in front of the wallet forever.
    const fresh = await stranded();
    getTx = async () => ({ status: "NOT_FOUND" });

    const outcome = await fresh.c.reconcileInFlight();
    expect(outcome?.kind).toBe("expired");
    expect(store.has("pocket.staged")).toBe(false);
    expect(store.has("pocket.inflight")).toBe(false);
  });
});

describe("the consequence of a landed operation outlives a failed write", () => {
  // The two settlement moments, which are not the same moment.
  //
  // The ledger says SUCCESS, and `submitAndConfirm` used to clear the in-flight
  // record right there. The openings write happens one line later, in the
  // caller. Between those two lines the wallet is holding the only copy of an
  // opening in a staged record, and the only thing that ever reads that record
  // is keyed on the in-flight hash that was just deleted. So a chain read that
  // failed in that gap, or a post-state the chain disagreed with, left a landed
  // confidential operation with its opening unwritten, unreachable, and on a
  // build with no archive unrecoverable: money visible on chain and permanently
  // unspendable.
  it("keeps the in-flight record when the post-state does not verify", async () => {
    const { c, address } = await worker();
    await (
      c as unknown as { writeOpenings: (a: string, t: string, s: unknown) => Promise<void> }
    ).writeOpenings(address, TOKEN, {
      spendable: { value: 10n, randomness: 3n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 0,
    });

    // Landed on chain, and the contract holds something this device cannot
    // account for. `applyStaged` must refuse, and refusing must not orphan.
    onChain = { spendable: commit(1n, 1n), receiving: IDENTITY };
    getTx = async () => ({ status: "SUCCESS", ledger: 12, applicationOrder: 1 });

    const handle = stage(c, envelope(address, "100"), {
      kind: "spend",
      spendable: ["40000000", "5"],
    });
    await expect(c.confirmPrivateOp(handle)).rejects.toThrow(/does not match/);

    // BOTH survive. The staged record is the opening; the in-flight record is
    // the only pointer to it.
    expect(store.has("pocket.staged")).toBe(true);
    expect(store.has("pocket.inflight")).toBe(true);

    // And it really is recoverable: the pointer leads a fresh worker back.
    const fresh = await worker("pw", false);
    onChain = { spendable: commit(40_000_000n, 5n), receiving: IDENTITY };
    const outcome = await fresh.c.reconcileInFlight();
    expect(outcome?.kind).toBe("succeeded");
    expect(await openings(fresh.c, address)).toEqual({
      spendable: { value: 40_000_000n, randomness: 5n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 0,
    });
    expect(store.has("pocket.inflight")).toBe(false);
    expect(store.has("pocket.staged")).toBe(false);
  });

  it("clears the record once the consequence is written, and not before", async () => {
    // The other half: a successful write must still close the slot, or the
    // unfinished-transaction screen sits in front of the wallet forever.
    const { c, address } = await worker();
    onChain = { spendable: commit(40_000_000n, 5n), receiving: IDENTITY };
    getTx = async () => ({ status: "SUCCESS", ledger: 12, applicationOrder: 1 });

    const handle = stage(c, envelope(address, "100"), {
      kind: "spend",
      spendable: ["40000000", "5"],
    });
    await c.confirmPrivateOp(handle);

    expect(await openings(c, address)).toEqual({
      spendable: { value: 40_000_000n, randomness: 5n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 0,
    });
    expect(store.has("pocket.inflight")).toBe(false);
    expect(store.has("pocket.staged")).toBe(false);
  });

  it("still settles a plain payment on the ledger's answer alone", async () => {
    // Nothing local to write, so nothing to wait for. A payment that clung to
    // its record would block the next send behind a transaction that is done.
    const { c, address } = await worker();
    getTx = async () => ({ status: "SUCCESS", ledger: 12, applicationOrder: 1 });
    const r = await (
      c as unknown as { signAndSubmit: (t: unknown) => Promise<{ kind: string }> }
    ).signAndSubmit(envelope(address, "100"));
    expect(r.kind).toBe("succeeded");
    expect(store.has("pocket.inflight")).toBe(false);
  });
});

describe("a payment arriving while the proof is being built", () => {
  // Proving takes tens of seconds. Somebody paying this account inside that
  // window is ordinary, it needs no permission and nothing refuses it, and the
  // contract moves the RECEIVING commitment without the sender touching it
  // (`storage.rs:711-712` for `confidential_transfer`, `627` for `withdraw`,
  // neither writes the sender's `receiving_commitment`).
  //
  // Transfer and unshield used to stage an ABSOLUTE post-state carrying
  // `receiving` as it was at build time, so that ordinary event made the wallet
  // refuse to record an operation that had SUCCEEDED on chain, and it refused
  // identically on every retry. The pocket sat `diverged` with the money spent.
  const local = {
    write: (c: InstanceType<typeof WalletController>, address: string, state: unknown) =>
      (
        c as unknown as {
          writeOpenings: (a: string, t: string, s: unknown) => Promise<void>;
        }
      ).writeOpenings(address, TOKEN, state),
  };

  it("records a landed transfer against the credit, not against a stale snapshot", async () => {
    const { c, address } = await worker();

    // Four XLM spendable, one already received and credited.
    await local.write(c, address, {
      spendable: { value: 40_000_000n, randomness: 11n },
      receiving: { value: 10_000_000n, randomness: 22n },
      syncedThrough: 500,
    });

    // The transfer is built here, spending one XLM. `newSpendable` comes out of
    // the proof, so it is the one part of the post-state that must be absolute.
    const spendable = { value: 30_000_000n, randomness: 77n };

    // ...and while it proves, 1.5 XLM arrives and the inbound scan credits it.
    const receiving = { value: 25_000_000n, randomness: 33n };
    await local.write(c, address, {
      spendable: { value: 40_000_000n, randomness: 11n },
      receiving,
      syncedThrough: 600,
    });

    // The contract holds the post-transfer spendable AND the new receiving.
    onChain = {
      spendable: commit(spendable.value, spendable.randomness),
      receiving: commit(receiving.value, receiving.randomness),
    };

    const handle = stage(c, envelope(address, "100"), {
      kind: "spend",
      spendable: ["30000000", "77"],
    });
    await c.confirmPrivateOp(handle);

    // The spend is recorded and the credit survived it. The cursor survived
    // too: staging the build-time value would have rolled it back over the
    // very credit that advanced it, and a cursor that goes backwards re-reads
    // an event that is already in the opening.
    expect(await openings(c, address)).toEqual({ spendable, receiving, syncedThrough: 600 });
    expect(store.has("pocket.staged")).toBe(false);
  });

  it("still refuses when the spendable side is the part that disagrees", async () => {
    // The guard is not weakened by any of the above: what the operation DOES
    // claim is still checked against the chain, and a wrong claim is refused.
    const { c, address } = await worker();
    await local.write(c, address, {
      spendable: { value: 40_000_000n, randomness: 11n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 500,
    });
    onChain = { spendable: commit(1n, 1n), receiving: IDENTITY };

    const handle = stage(c, envelope(address, "100"), {
      kind: "spend",
      spendable: ["30000000", "77"],
    });
    await expect(c.confirmPrivateOp(handle)).rejects.toThrow(/does not match/);
    // Nothing written, and the record kept so the user is brought back to it.
    expect(await openings(c, address)).toEqual({
      spendable: { value: 40_000_000n, randomness: 11n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 500,
    });
  });
});

describe("an unresolved submission blocks the next one", () => {
  it("refuses to build a second payment while the first may still land", async () => {
    const { c } = await worker();
    store.set("pocket.inflight", {
      hash: "ab".repeat(32),
      maxTime: Math.floor(Date.now() / 1000) + 120,
    });
    await expect(
      c.buildPayment({
        to: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
        amount: "1",
        assetId: "native",
      }),
    ).rejects.toThrow(/has not resolved yet/);
  });

  it("allows it again once the first can never be included", async () => {
    const { c } = await worker();
    store.set("pocket.inflight", { hash: "ab".repeat(32), maxTime: 1 });
    // Gets past the guard and fails later, on the unfunded account, which is
    // the honest next failure rather than the in-flight refusal.
    await expect(
      c.buildPayment({
        to: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
        amount: "1",
        assetId: "native",
      }),
    ).rejects.not.toThrow(/has not resolved yet/);
  });

  it("clears an in-flight record that can no longer be included", async () => {
    const { c } = await worker();
    store.set("pocket.inflight", { hash: "cd".repeat(32), maxTime: 1 });
    getTx = async () => ({ status: "NOT_FOUND" });

    const outcome = await c.reconcileInFlight();
    // Left as "pending" this record was unclearable, and the screen that
    // renders it sits in front of the whole wallet on every popup mount.
    expect(outcome?.kind).toBe("expired");
    expect(store.has("pocket.inflight")).toBe(false);
  }, 10_000);
});

describe("concurrency", () => {
  it("serialises overlapping submissions instead of interleaving them", async () => {
    const { c, address } = await worker();
    const order: string[] = [];
    getTx = async () => {
      order.push("poll");
      await new Promise((r) => setTimeout(r, 5));
      return { status: "SUCCESS", ledger: 7, applicationOrder: 1 };
    };
    sendResult = () => {
      order.push("send");
      return { status: "PENDING" };
    };

    const a = stage(c, envelope(address, "100"), { kind: "merge" });
    const b = stage(c, envelope(address, "101"), { kind: "merge" });
    // Both resolve to a merge of an empty state, which the identity commitment
    // agrees with, so both writes verify.
    await Promise.allSettled([c.confirmPrivateOp(a), c.confirmPrivateOp(b)]);

    // Interleaved, this reads send,send,poll,poll and one of the two in-flight
    // records is erased by the other's terminal outcome.
    expect(order).toEqual(["send", "poll", "send", "poll"]);
  });

  it("does not consume a proved private operation through the public confirm path", async () => {
    const { c, address } = await worker();
    const handle = stage(c, envelope(address, "100"), { kind: "merge" });
    await expect(c.confirmPayment(handle)).rejects.toThrow(/no longer pending/);
    // Still there. It cost a few hundred milliseconds of proving; a misrouted
    // message must not throw that away.
    expect((c as unknown as { pending: Map<string, unknown> }).pending.has(handle)).toBe(true);
  });
});

describe("state that must not outlive its session", () => {
  it("stops reporting a private pocket once locked", async () => {
    const { c } = await worker();
    // Readiness is now per confidential asset (a Set of wrapper tokens), so
    // "ready" means at least one token is in it.
    (c as unknown as { readyAssets: Set<string> }).readyAssets.add("CXLMWRAPPER");
    expect((await c.status()).privateEnabled).toBe(true);
    await c.lock();
    // The home screen offers "Open private pocket" off this flag, and after a
    // lock it knows nothing about the account it last read.
    expect((await c.status()).privateEnabled).toBe(false);
  });

  it("is locked from the moment lock() is CALLED, not when it settles", async () => {
    // `lock()` awaits a dynamic import to clear dApp grants, so it suspends.
    // Everything in memory has to be gone before that suspension: a status read
    // that lands in the window would otherwise be answered by a wallet that has
    // been locked and does not know it yet. Deliberately NOT awaited, because
    // the await is what would hide the bug.
    const { c } = await worker();
    (c as unknown as { readyAssets: Set<string> }).readyAssets.add("CXLMWRAPPER");
    expect((await c.status()).privateEnabled).toBe(true);

    const locking = c.lock();
    // Same microtask the caller gets back control in.
    expect(
      (c as unknown as { readyAssets: Set<string> }).readyAssets.size,
      "the private flag survived into lock()'s suspension",
    ).toBe(0);
    expect((await c.status()).privateEnabled).toBe(false);
    await locking;
  });

  it("drops the staged consequence when the wallet is erased", async () => {
    const { c } = await worker();
    store.set("pocket.staged", { v: 1, iv: "x", ct: "y" });
    await c.reset("pw");
    // Sealed under a DEK that no longer exists. Left behind, the next wallet
    // finds an undecryptable blob where its own staged record should be.
    expect(store.has("pocket.staged")).toBe(false);
  });
});
