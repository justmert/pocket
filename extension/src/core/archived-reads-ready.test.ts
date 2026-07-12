// An archived private pocket that reads as perfectly healthy.
//
// This deployment is soroban-rpc 27.1.1 / protocol 27, where an archived
// persistent entry is AUTO-RESTORED into the readWrite footprint instead of
// coming back as a `restorePreamble`. Measured on a real archived entry
// (`liveUntilLedgerSeq: 0`, lastModified 3086116 against latest 4019256): no
// preamble, a real result, and `transactionData` carrying
// `archivedSorobanEntries`, which `assembleTransaction` copies verbatim.
//
// So `readConfidentialAccount` returns a real account for a dormant pocket, the
// `state: "archived"` branch is unreachable, and the pocket reports `ready`
// with nothing said. That is not wrong -- it IS spendable -- and it is not the
// whole truth either: the next operation silently carries a restore and its
// fee. Both facts have to reach the user, and only one was.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";

const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) =>
        k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
    },
  },
});

/** What the TTL read reports. The account read always succeeds here. */
let ttlKind: "healthy" | "expiring" | "archived" | "absent";

vi.mock("./chain/ttl", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readAccountTtl: async () =>
      ttlKind === "healthy" || ttlKind === "expiring"
        ? { kind: ttlKind, expiresAt: new Date(Date.now() + 86_400_000), daysRemaining: 20 }
        : { kind: ttlKind },
  };
});

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  // The account exists and is funded; this test is about the confidential
  // entry's TTL, not about the classic balance.
  return {
    ...real,
    readNative: async () => ({
      raw: 100_000_000n,
      subEntryCount: 0,
      numSponsoring: 0,
      numSponsored: 0,
      sellingLiabilities: 0n,
    }),
  };
});

let onChain: { spendable: { x: bigint; y: bigint }; receiving: { x: bigint; y: bigint } };

vi.mock("./chain/confidential", () => ({
  // Auto-restore: a real answer for an archived entry, no preamble.
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

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { commit, IDENTITY } = await import("./crypto/grumpkin");
const { Account } = await import("@stellar/stellar-sdk/base");

const TOKEN = NETWORKS.testnet.confidential[0]!.token;

beforeEach(() => {
  store.clear();
  ttlKind = "healthy";
  onChain = { spendable: commit(40_000_000n, 7n), receiving: IDENTITY };
});

async function readyWallet() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLedgerEntries: async () => ({ entries: [] }),
  });
  // Local records that agree with the chain, so the pocket is genuinely ready.
  await (
    c as unknown as { writeOpenings: (a: string, t: string, s: unknown) => Promise<void> }
  ).writeOpenings(address, TOKEN, {
    spendable: { value: 40_000_000n, randomness: 7n },
    receiving: { value: 0n, randomness: 0n },
    syncedThrough: 0,
  });
  return c;
}

describe("a pocket whose entry archived but still answers", () => {
  it("stays READY, because it really is spendable", async () => {
    // Forcing a usable pocket into a dormant dead end would be the worse error:
    // under auto-restore the balances are correct and can be spent.
    ttlKind = "archived";
    const p = await (await readyWallet()).privatePocket();
    expect(p.state).toBe("ready");
    expect(p.spendable).toBe("4.0000000");
  });

  it("says the entry was restored, and that the next operation costs more", async () => {
    ttlKind = "archived";
    const p = await (await readyWallet()).privatePocket();
    expect(p.message).toMatch(/dormant/i);
    expect(p.message).toMatch(/fees|cost/i);
  });

  it("treats an EVICTED entry the same way, since the read proves it exists", async () => {
    // `getLedgerEntries` omits an evicted entry entirely, so the TTL read says
    // "absent". For an account whose confidential state just answered, absent
    // cannot mean unregistered; it means evicted, which is the archived case.
    ttlKind = "absent";
    const p = await (await readyWallet()).privatePocket();
    expect(p.state).toBe("ready");
    expect(p.message).toMatch(/dormant/i);
  });

  it("says nothing extra about a healthy pocket", async () => {
    // The notice must not become permanent furniture on every private screen.
    ttlKind = "healthy";
    const p = await (await readyWallet()).privatePocket();
    expect(p.state).toBe("ready");
    expect(p.message).toBeUndefined();
  });

  it("says nothing extra about one that is merely expiring", async () => {
    // Expiring already has its own warning, with a day count. Two notices about
    // the same clock would contradict each other on the wording.
    ttlKind = "expiring";
    const p = await (await readyWallet()).privatePocket();
    expect(p.message).toBeUndefined();
  });
});
