import { describe, it, expect } from "vitest";
import { valueSeries, sumSeries, changePct, type ValuePoint } from "./portfolio";
import type { BalancePoint } from "./balance-history";
import type { PricePoint } from "./prices";

const XLM = 10_000_000n;

describe("valueSeries", () => {
  it("multiplies the balance in force by the price at that moment", () => {
    const history: BalancePoint[] = [
      { at: 2000, stroops: 100n * XLM },
      { at: 4000, stroops: 250n * XLM },
    ];
    const prices: PricePoint[] = [
      { at: 1000, price: 0.1 },
      { at: 3000, price: 0.2 },
      { at: 5000, price: 0.4 },
    ];
    // the trailing point carries the curve to now at the latest known price, so
    // the chart's right edge equals the headline figure. dropped here to assert
    // the sampled body on its own.
    expect(valueSeries(history, prices).slice(0, 3)).toEqual([
      // before the account was funded: a real zero, not a gap
      { at: 1000, value: 0 },
      { at: 3000, value: 20 }, // 100 XLM at 0.20
      { at: 5000, value: 100 }, // 250 XLM at 0.40
    ]);
  });

  it("draws zero for the stretch before the wallet existed", () => {
    // The whole point of charting real history rather than today's holdings
    // priced backwards: a month before funding is worth nothing, not worth
    // today's balance at last month's price.
    const history: BalancePoint[] = [{ at: 9000, stroops: 500n * XLM }];
    const prices: PricePoint[] = [
      { at: 1000, price: 1 },
      { at: 5000, price: 1 },
      { at: 9000, price: 1 },
    ];
    expect(valueSeries(history, prices).map((p) => p.value).slice(0, 3)).toEqual([0, 0, 500]);
  });

  it("has no value to report without a price series", () => {
    expect(valueSeries([{ at: 1, stroops: XLM }], [])).toEqual([]);
  });
});

describe("sumSeries", () => {
  it("adds assets onto one timeline", () => {
    const a: ValuePoint[] = [
      { at: 1, value: 10 },
      { at: 2, value: 20 },
    ];
    const b: ValuePoint[] = [
      { at: 1, value: 1 },
      { at: 2, value: 2 },
    ];
    expect(sumSeries([a, b])).toEqual([
      { at: 1, value: 11 },
      { at: 2, value: 22 },
    ]);
  });

  it("aligns from the newest end when one asset has a shorter history", () => {
    // Aligning from the START would put an old price under a recent balance and
    // silently mis-date the whole shorter series.
    const long: ValuePoint[] = [
      { at: 1, value: 100 },
      { at: 2, value: 200 },
      { at: 3, value: 300 },
    ];
    const short: ValuePoint[] = [{ at: 3, value: 7 }];
    expect(sumSeries([long, short])).toEqual([{ at: 3, value: 307 }]);
  });

  it("skips an asset with no series rather than treating it as zero", () => {
    const a: ValuePoint[] = [{ at: 1, value: 10 }];
    expect(sumSeries([a, []])).toEqual([{ at: 1, value: 10 }]);
  });

  it("returns nothing when nothing could be read", () => {
    // Not a flat zero line. "We could not read this" is not "you had nothing".
    expect(sumSeries([])).toEqual([]);
    expect(sumSeries([[], []])).toEqual([]);
  });
});

describe("changePct", () => {
  it("reports the move across the series", () => {
    expect(
      changePct([
        { at: 1, value: 200 },
        { at: 2, value: 250 },
      ]),
    ).toBeCloseTo(25);
    expect(
      changePct([
        { at: 1, value: 200 },
        { at: 2, value: 150 },
      ]),
    ).toBeCloseTo(-25);
  });

  it("declines to report a change from nothing", () => {
    // A wallet's first chart starts at the moment it was funded, so this is the
    // common case, not an edge one. Every gain from zero is infinite and
    // rendering that as a percentage would be theatre.
    expect(
      changePct([
        { at: 1, value: 0 },
        { at: 2, value: 500 },
      ]),
    ).toBeNull();
  });

  it("declines when there is not enough series to compare", () => {
    expect(changePct([])).toBeNull();
    expect(changePct([{ at: 1, value: 10 }])).toBeNull();
  });
});

describe("the curve's right edge", () => {
  it("ends at now, on the current balance and the latest known price", () => {
    // A candle can be a whole resolution old, so anything that happened since
    // would fall off the end and the chart would contradict the balance printed
    // directly above it.
    const history: BalancePoint[] = [{ at: 1000, stroops: 10n * XLM }];
    const prices: PricePoint[] = [
      { at: 1000, price: 2 },
      { at: 2000, price: 3 },
    ];
    const series = valueSeries(history, prices);
    expect(series.length).toBe(3);
    const edge = series[series.length - 1]!;
    expect(edge.at).toBeGreaterThan(2000);
    // current balance (10 XLM) at the latest close (3), which is exactly what
    // the headline figure is made of.
    expect(edge.value).toBe(30);
  });

  it("adds nothing when the newest candle is already in the future", () => {
    const history: BalancePoint[] = [{ at: 1000, stroops: XLM }];
    const prices: PricePoint[] = [{ at: Date.now() + 60_000, price: 1 }];
    expect(valueSeries(history, prices).length).toBe(1);
  });
});
