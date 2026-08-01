// A transfer that lands WHILE the inbound scan is running.
//
// `creditInbound` is all-or-nothing against the contract's receiving
// accumulator: the sum of what was found must reproduce the commitment on
// chain, or nothing is credited. That check was made against an account object
// read BEFORE a scan that pages the RPC's whole retained window, which takes as
// long as it takes.
//
// So a transfer arriving mid-scan moved the accumulator, the batch the scan DID
// find no longer reproduced it, and the whole credit was refused, including the
// transfers that were found. The same argument is already written above
// `resumeFrom` about the cursor; the accumulator kept the pre-scan value.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";
import { commit, IDENTITY } from "./crypto/grumpkin";

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

/** Transfers the scan finds, as (value, randomness, ledger). */
const FOUND = [{ value: 5_000_000n, randomness: 0n, ledger: 120 }];

vi.mock("./inbound", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    findInbound: async () => {
      // A SECOND transfer lands while this scan is running. That is the whole
      // scenario: the chain moves under a read that takes real time.
      onChainReceiving = commit(5_000_000n + 3_000_000n, 0n);
      return FOUND;
    },
  };
});

/** What the contract holds for the receiving side, right now. */
let onChainReceiving = commit(5_000_000n, 0n);
/** What the account read returns; reset per test. */
let reads = 0;

vi.mock("./chain/confidential", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readConfidentialAccount: async () => {
      reads++;
      return {
        spendableCommitment: IDENTITY,
        receivingCommitment: onChainReceiving,
        viewingPublicKey: { x: 1n, y: 2n },
        auditorId: 0,
      };
    },
  };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { Account } = await import("@stellar/stellar-sdk/base");

const TOKEN = NETWORKS.testnet.confidential[0]!.token;

beforeEach(() => {
  store.clear();
  reads = 0;
  onChainReceiving = commit(5_000_000n, 0n);
});

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1000 }),
  });
  return { c, address };
}

/** A local record that is BEHIND the chain, which is what starts a scan. */
async function seed(address: string) {
  const { openingKey } = await import("../lib/storage");
  const { sealPayload } = await import("./vault/vault");
  const { requireSession } = await import("./session");
  const { dek } = requireSession();
  const zero = { value: "0", randomness: "0" };
  store.set(
    openingKey(TOKEN, address),
    await sealPayload(dek, { spendable: zero, receiving: zero, syncedThrough: 100 }),
  );
}

/** The private method under test. Reached directly: `privatePocket` around it
 *  is a TTL read, a native-balance read and a state machine, none of which this
 *  behaviour depends on, and all of which would have to be stood up to get here. */
function credit(c: unknown, stored: unknown, account: unknown) {
  return (
    c as {
      creditInboundTransfers(
        s: unknown,
        a: unknown,
        cfg: unknown,
      ): Promise<{
        receiving: { value: bigint };
        syncedThrough: number;
      }>;
    }
  ).creditInboundTransfers(stored, account, { token: TOKEN });
}

const ZERO = { value: 0n, randomness: 0n };

describe("crediting against an accumulator that moved mid-scan", () => {
  it("checks against the chain as it is at the write, not as it was at the read", async () => {
    const { c, address } = await worker();
    await seed(address);

    // The scan finds one 5 XLM transfer and a 3 XLM one lands while it runs, so
    // the accumulator the check must use is 8 XLM and the pre-scan value is
    // 5 XLM. Whichever way the credit goes, the number used has to be the one
    // the contract holds at the moment of the write: that is what a later spend
    // is proved against.
    const before = {
      spendableCommitment: IDENTITY,
      receivingCommitment: commit(5_000_000n, 0n),
      viewingPublicKey: { x: 1n, y: 2n },
      auditorId: 0,
    };
    reads = 0;
    await credit(c, { spendable: ZERO, receiving: ZERO, syncedThrough: 100 }, before).catch(
      () => undefined,
    );

    expect(reads, "the write used the pre-scan accumulator").toBeGreaterThan(0);
  });

  it("never stores a receiving opening the contract disagrees with", async () => {
    const { c, address } = await worker();
    await seed(address);
    const before = {
      spendableCommitment: IDENTITY,
      receivingCommitment: commit(5_000_000n, 0n),
      viewingPublicKey: { x: 1n, y: 2n },
      auditorId: 0,
    };

    const out = await credit(
      c,
      { spendable: ZERO, receiving: ZERO, syncedThrough: 100 },
      before,
    ).catch(() => null);

    // Either nothing was credited, or what was credited reproduces the
    // accumulator the contract now holds. A stored 5 XLM against a chain
    // holding 8 XLM is a receiving opening no proof can ever use.
    if (out && out.receiving.value !== 0n) {
      expect(commit(out.receiving.value, 0n)).toEqual(onChainReceiving);
    }
  });
});
