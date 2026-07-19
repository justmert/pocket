// A total missing one of its parts is worse than no total at all.
//
// `valueSeries` says exactly that on the UNREADABLE error it defines, and then
// broke the rule one branch earlier. An unreadable BALANCE history threw and
// abandoned the whole chart, which is right. An unreadable PRICE series
// returned `[]`, which `sumSeries` filtered out, so the asset silently left the
// total.
//
// That is not survivable, because the asymmetry lands on the money. XLM and
// USDC prices come from the SAME mainnet endpoint, but USDC never makes a
// request: `priceSeries` short-circuits on `isQuoteAsset` and synthesises a
// full-length series at exactly 1. So the only asset whose price can fail is
// usually most of the balance, and when it failed the wallet showed the
// USDC-only figure as the whole account, with the chart agreeing.
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

/** Which asset codes have a readable price series this test. */
let priced = new Set<string>(["XLM", "USDC"]);

vi.mock("./chain/prices", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    // The module exports `priceSeries`; controller.ts aliases it to
    // `readPriceSeries` on import, so the MOCK has to name the export.
    priceSeries: async (code: string) =>
      priced.has(code)
        ? [
            { at: 1_000, price: 0.1 },
            { at: 2_000, price: 0.2 },
          ]
        : [],
  };
});

vi.mock("./chain/balance-history", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    balanceHistory: async () => [
      { at: 1_000, stroops: 100_0000000n },
      { at: 2_000, stroops: 100_0000000n },
    ],
  };
});

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readNative: async () => ({
      raw: 1_000_000_000n,
      subEntryCount: 1,
      numSponsoring: 0,
      numSponsored: 0,
      sellingLiabilities: 0n,
    }),
    readTrustline: async (
      _s: unknown,
      _a: string,
      asset: { getCode(): string; getIssuer(): string },
    ) => ({
      id: `${asset.getCode()}:${asset.getIssuer()}`,
      code: asset.getCode(),
      issuer: asset.getIssuer(),
      limit: 10n ** 18n,
      raw: 50_0000000n,
      sellingLiabilities: 0n,
      authorized: true,
    }),
  };
});

const KNOWN_CODE = "USDC";
const KNOWN_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

vi.stubGlobal("fetch", async () => ({
  ok: true,
  status: 200,
  json: async () => ({
    balances: [
      { asset_type: "native", balance: "100.0000000" },
      {
        asset_type: "credit_alphanum4",
        asset_code: KNOWN_CODE,
        asset_issuer: KNOWN_ISSUER,
        balance: "50.0000000",
        limit: "10000",
      },
    ],
  }),
}));

const { WalletController } = await import("./controller");

beforeEach(() => {
  store.clear();
  priced = new Set(["XLM", "USDC"]);
});

async function worker() {
  const c = new WalletController();
  await c.init();
  await c.create("pw");
  return c;
}

describe("the public value chart", () => {
  it("draws when every held asset can be priced", async () => {
    // The control. Without it every assertion below is satisfied by a chart
    // that never draws at all.
    const c = await worker();
    const chart = await c.valueSeries("1M");
    expect(chart.points.length).toBeGreaterThan(0);
  });

  it("withholds the whole total when one asset's price is unreadable", async () => {
    // Not "draws the rest". The one that fails here is XLM, which is usually
    // most of the money, and the remainder was presented as the whole account.
    const c = await worker();
    priced = new Set(["USDC"]);

    const chart = await c.valueSeries("1M");
    expect(chart.points, "a partial total was drawn as if it were complete").toEqual([]);
    expect(chart.changePct).toBeNull();
  });

  it("withholds it the same way when the OTHER asset is the unreadable one", async () => {
    // The rule is about completeness, not about which asset happens to fail.
    const c = await worker();
    priced = new Set(["XLM"]);

    expect((await c.valueSeries("1M")).points).toEqual([]);
  });

  it("returns an empty chart rather than throwing", async () => {
    // A chart is decoration on a wallet that works without it, so this must not
    // become an error banner over someone's balance. Withheld, not failed.
    const c = await worker();
    priced = new Set<string>();

    await expect(c.valueSeries("1M")).resolves.toEqual({ points: [], changePct: null });
  });
});
