// value(t) = balance_at(t) * price_at(t), summed across the assets in a pocket.
//
// The two inputs come from different places on purpose. Balance is read from the
// active network, because that is the only place the account exists. Price is
// read from mainnet, because testnet has no market. See balance-history.ts and
// prices.ts.
//
// Pure. No I/O and no state, so the arithmetic that decides what a user is told
// they are worth can be tested without a network.
import { balanceAt, type BalancePoint } from "./balance-history";
import { STROOPS_PER_UNIT } from "./balances";
import type { PricePoint } from "./prices";

export interface ValuePoint {
  at: number;
  /** In the quote asset (USDC), which is a dollar by construction. */
  value: number;
}

/**
 * One asset's value over the price series' own timestamps.
 *
 * Sampled ON the price points rather than on the balance changes, because the
 * price series is the regularly spaced one: a chart drawn on balance changes
 * would have one point for a quiet month and ninety for a busy day.
 *
 * The conversion to Number happens here and only here. Stroops are exact
 * integers and a price is not, so the moment they multiply the result is a
 * float; doing it once, at the boundary, keeps every balance upstream exact.
 * A double holds a stroop count far beyond any real balance without loss, so
 * nothing is rounded away on the way in.
 */
export function valueSeries(history: BalancePoint[], prices: PricePoint[]): ValuePoint[] {
  if (prices.length === 0) return [];
  const at = (t: number, price: number) => ({
    at: t,
    value: (Number(balanceAt(history, t)) / Number(STROOPS_PER_UNIT)) * price,
  });
  const points = prices.map((p) => at(p.at, p.price));

  // The curve has to end where the headline number is.
  //
  // Candles close on their own schedule, so the newest one can be up to a
  // resolution old: fifteen minutes on the 1D range, a week on 1Y. Anything that
  // happened since falls off the right-hand end. Fund an account and the chart
  // would show it still empty, disagreeing with the balance printed directly
  // above it, which is the one thing this UI is built not to do.
  //
  // So the series is carried to now at the latest price we actually have. The
  // balance is current and real; the price is the most recent close and is not
  // extrapolated. That is the same pair of facts the headline figure is made of,
  // which is why the two now agree by construction.
  const now = Date.now();
  const last = prices[prices.length - 1]!;
  if (now > last.at) points.push(at(now, last.price));
  return points;
}

/**
 * Several assets' value, summed onto one timeline.
 *
 * Series are aligned by INDEX from the newest end, not by timestamp: every
 * series for a given range is fetched at the same resolution and length, so
 * index i is the same moment in each. Aligning from the end rather than the
 * start matters when one asset has a shorter market history than another, which
 * would otherwise slide an old price under a recent balance.
 *
 * Returns an empty array when there is nothing real to add up. An empty chart is
 * drawn as no chart; it is never drawn as a flat zero, because "we could not
 * read this" and "you had nothing" are different facts.
 */
export function sumSeries(series: ValuePoint[][]): ValuePoint[] {
  const usable = series.filter((s) => s.length > 0);
  if (usable.length === 0) return [];
  const len = Math.min(...usable.map((s) => s.length));
  const out: ValuePoint[] = [];
  for (let i = 0; i < len; i++) {
    let total = 0;
    for (const s of usable) total += s[s.length - len + i]!.value;
    out.push({ at: usable[0]![usable[0]!.length - len + i]!.at, value: total });
  }
  return out;
}

/**
 * The change across a series, as a percentage.
 *
 * Null rather than zero when it cannot be computed. A series that starts at zero
 * has no percentage change to report: everything is an infinite gain from
 * nothing, and rendering that as a number would be arithmetic theatre. That case
 * is common and not exceptional, because a wallet's first chart starts at the
 * moment it was funded.
 */
export function changePct(series: ValuePoint[]): number | null {
  if (series.length < 2) return null;
  const first = series[0]!.value;
  const last = series[series.length - 1]!.value;
  if (first <= 0) return null;
  return ((last - first) / first) * 100;
}
