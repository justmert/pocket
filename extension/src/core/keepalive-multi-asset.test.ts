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
  headroom = {};
});

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

    await c.runKeepAlive();
    expect(bumped).toEqual([]);
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
