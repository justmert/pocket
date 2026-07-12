// Only text this wallet wrote may reach the diverged screen.
//
// `creditInboundTransfers` wraps its whole body in a catch that replaces any
// foreign message with an authored one, because the alternative is an RPC's
// "Request failed with status code 429" or chrome.storage's own quota wording
// appearing as the wallet's explanation of a private balance mismatch.
//
// The catch did not cover the half that matters. The credit's write runs inside
// `this.exclusive(...)`, and that call was `return`ed rather than `await`ed, so
// the promise was handed back before it settled and nothing thrown inside it
// ever passed through the catch at all. `writeOpenings`, `readOpenings` and
// `creditInbound` all throw from in there.
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

vi.mock("./confidential-ops", () => ({
  deriveConfidentialKeys: async () => ({ vk: 7n }),
}));

/** What the scan hands back, per test. */
let found: { id: string; ledger: number; opening: { value: bigint; randomness: bigint } }[] = [];

vi.mock("./inbound", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return { ...real, findInbound: async () => found };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { commit, IDENTITY } = await import("./crypto/grumpkin");

const TOKEN = NETWORKS.testnet.confidential[0]!.token;

beforeEach(() => {
  store.clear();
  found = [{ id: "e1", ledger: 500, opening: { value: 3n, randomness: 4n } }];
});

async function subject() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  const inner = c as unknown as {
    creditInboundTransfers: (s: unknown, a: unknown, c: { token: string }) => Promise<unknown>;
    opContext: (t: string) => Promise<unknown>;
    readOpenings: (a: string, t: string) => Promise<unknown>;
    lastInboundFailure: string | null;
  };
  // The one seam before the exclusive block that needs a ledger.
  inner.opContext = async () => ({});
  return { c, inner, address };
}

/** A local state that does NOT agree with the chain, so the credit path runs. */
const DIVERGED = {
  stored: {
    spendable: { value: 5n, randomness: 1n },
    receiving: { value: 0n, randomness: 0n },
    syncedThrough: 0,
  },
  account: {
    spendableCommitment: commit(99n, 7n),
    receivingCommitment: IDENTITY,
    auditorId: 0,
  },
};

describe("a failure inside the credit's own write", () => {
  it("is replaced with a sentence the wallet wrote", async () => {
    const { inner } = await subject();
    // Thrown from INSIDE the exclusive block, which is the case the missing
    // await let escape. chrome.storage's real quota message, verbatim.
    inner.readOpenings = async () => {
      throw new Error("Resource::kQuotaBytesPerItem quota exceeded");
    };

    const out = await inner.creditInboundTransfers(DIVERGED.stored, DIVERGED.account, {
      token: TOKEN,
    });

    // The pocket is left exactly as it was, and the reason is ours.
    expect(out).toEqual(DIVERGED.stored);
    expect(inner.lastInboundFailure).toMatch(/could not reach the ledger/i);
    expect(inner.lastInboundFailure).not.toMatch(/quota/i);
  });

  it("does not reject out of the call, which would reach the screen raw", async () => {
    // The observable shape of the bug: unawaited, the rejection escaped the
    // method entirely rather than being converted.
    const { inner } = await subject();
    inner.readOpenings = async () => {
      throw new Error("Request failed with status code 429");
    };

    await expect(
      inner.creditInboundTransfers(DIVERGED.stored, DIVERGED.account, { token: TOKEN }),
    ).resolves.toEqual(DIVERGED.stored);
  });

  it("still lets an InboundCreditError through, because we wrote that one", async () => {
    // The credit genuinely cannot reconcile: that message is authored here and
    // is the useful thing to say, so it must NOT be flattened.
    const { inner } = await subject();
    const out = await inner.creditInboundTransfers(DIVERGED.stored, DIVERGED.account, {
      token: TOKEN,
    });
    expect(out).toEqual(DIVERGED.stored);
    expect(inner.lastInboundFailure).toMatch(/do not add up/i);
  });
});
