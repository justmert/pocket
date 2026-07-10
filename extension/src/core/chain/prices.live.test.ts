// Prices, against real mainnet Horizon.
//
// Read-only: this submits nothing and spends nothing, unlike the rest of the
// live tier. It is still opt-in, because a Horizon outage must not be reported
// as a code failure.
import { describe, it, expect, beforeEach } from "vitest";
import {
  priceSeries,
  assetMarket,
  clearPriceCache,
  isPriceable,
  isQuoteAsset,
  RANGES,
  type RangeId,
} from "./prices";

beforeEach(() => clearPriceCache());

describe("price series", () => {
  it("reads a real XLM series at every range, oldest first", async () => {
    for (const range of Object.keys(RANGES) as RangeId[]) {
      const series = await priceSeries("XLM", range);
      expect(series.length, `${range} returned nothing`).toBeGreaterThan(1);
      expect(series.length, `${range} exceeded its own point budget`).toBeLessThanOrEqual(
        RANGES[range].points,
      );

      // Ascending, which the chart depends on and Horizon does not give: it is
      // asked for `order=desc` because that is the only way to get the most
      // recent window rather than 200 candles from 2015.
      for (let i = 1; i < series.length; i++) {
        expect(series[i]!.at, `${range} is not ascending at ${i}`).toBeGreaterThan(
          series[i - 1]!.at,
        );
      }

      // Every price is real. A dropped candle must leave a gap, never a zero,
      // because a zero draws a cliff to the axis and reads as a crash.
      for (const p of series) expect(p.price).toBeGreaterThan(0);

      // The newest candle is inside the window it claims to cover, with a day of
      // slack for a thin pair.
      const newest = series[series.length - 1]!.at;
      const windowMs = RANGES[range].days * 86_400_000;
      expect(Date.now() - newest).toBeLessThan(windowMs + 86_400_000);
    }
  });

  it("prices the quote asset at exactly one without a request", async () => {
    const series = await priceSeries("USDC", "1W");
    expect(series.length).toBe(RANGES["1W"].points);
    expect(new Set(series.map((p) => p.price))).toEqual(new Set([1]));
  });

  it("returns nothing for an asset with no market rather than guessing", async () => {
    expect(isPriceable("XLM")).toBe(true);
    expect(isPriceable("USDC")).toBe(true);
    expect(isPriceable("NOSUCHASSET")).toBe(false);
    expect(await priceSeries("NOSUCHASSET", "1W")).toEqual([]);
  });
});

describe("asset market", () => {
  it("reads spot, 24h change and 24h volume for XLM", async () => {
    const m = await assetMarket("XLM");
    expect(m.price).toBeGreaterThan(0);
    // Sanity bounds, not a price assertion: this test must not fail because the
    // market moved. It fails if the number is not a plausible XLM price at all,
    // which is what catches reading the wrong field or the wrong pair.
    expect(m.price!).toBeLessThan(100);
    expect(m.change24h).not.toBeNull();
    expect(Math.abs(m.change24h!)).toBeLessThan(100);
    expect(m.volume24h).toBeGreaterThan(0);
  });

  it("reports the quote asset as a dollar", async () => {
    expect(isQuoteAsset("USDC")).toBe(true);
    const m = await assetMarket("USDC");
    expect(m.price).toBe(1);
  });

  it("reports every field null for an unpriceable asset", async () => {
    expect(await assetMarket("NOSUCHASSET")).toEqual({
      price: null,
      change24h: null,
      volume24h: null,
    });
  });
});
