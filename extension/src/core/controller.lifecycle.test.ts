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
      remove: async (k: string) => void store.delete(k),
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
  (
    c as unknown as { pending: Map<string, unknown> }
  ).pending.set(handle, { xdr: tx.toXDR(), at: Date.now(), private: { resolve, follow } });
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

describe("an unresolved submission blocks the next one", () => {
  it("refuses to build a second payment while the first may still land", async () => {
    const { c } = await worker();
    store.set("pocket.inflight", {
      hash: "ab".repeat(32),
      maxTime: Math.floor(Date.now() / 1000) + 120,
    });
    await expect(
      c.buildPayment({ to: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6", amount: "1", assetId: "native" }),
    ).rejects.toThrow(/has not resolved yet/);
  });

  it("allows it again once the first can never be included", async () => {
    const { c } = await worker();
    store.set("pocket.inflight", { hash: "ab".repeat(32), maxTime: 1 });
    // Gets past the guard and fails later, on the unfunded account, which is
    // the honest next failure rather than the in-flight refusal.
    await expect(
      c.buildPayment({ to: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6", amount: "1", assetId: "native" }),
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
    (c as unknown as { privateReady: boolean }).privateReady = true;
    expect((await c.status()).privateEnabled).toBe(true);
    c.lock();
    // The home screen offers "Open private pocket" off this flag, and after a
    // lock it knows nothing about the account it last read.
    expect((await c.status()).privateEnabled).toBe(false);
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
