// Market price, from the Stellar DEX itself.
//
// Horizon's /trade_aggregations returns OHLC candles for an asset pair straight
// out of the ledger, so this is the price Stellar users actually traded at
// rather than a third party's index of it. No API key, no registration, and
// Horizon is already a host this project depends on: `horizonUrl` is in
// config.ts for both networks and indexer/ reads it for transfer payloads.
//
// Chosen over the alternatives on measurement, not preference (2026-08-03):
//   CoinGecko      keyless is 5-15 calls/min and unstable; a demo key is 30/min
//                  and 10k/month, and would have to ship inside the package.
//   StellarExpert  /asset/{id} carries seven daily points. Cannot draw 1M.
//   Reflector      24 hours of retention. Cannot draw anything past 1D.
//
// PRICE IS ALWAYS READ FROM MAINNET, whatever network the wallet is on. Testnet
// has no real market, so a testnet price would be noise from a handful of test
// trades. This is the same move the reference wallet makes pricing a testnet asset
// off mainnet `prior`. It is also why this module does NOT take the active
// network's horizonUrl: the two are different hosts with different jobs, and
// collapsing them would price a testnet balance off testnet's empty order book.
//
// PRIVACY: a request here names an ASSET, never an account and never an amount.
// It is made for the assets the build is configured with, not for what the user
// holds, so the request set is identical for every user of a given build. It
// still reveals the client IP to Horizon, which is true of every RPC call the
// wallet already makes.
import { deadlineSignal } from "./http";

/** Mainnet Horizon. Not configurable, because a price is only meaningful there. */
const MAINNET_HORIZON = "https://horizon.stellar.org";

/**
 * Mainnet USDC, the counter asset every price is quoted in.
 *
 * Circle's issuer. Quoting in USDC rather than in a fiat feed keeps the whole
 * price path on chain: XLM/USDC is the deepest pair on the Stellar DEX, and USDC
 * is worth a dollar by construction rather than by someone's assertion.
 */
const USDC = {
  code: "USDC",
  issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
};

/**
 * The ranges the chart offers, and how each is fetched.
 *
 * Every one fits in a SINGLE request. Horizon caps `limit` at 200 (201 answers
 * 400) and accepts exactly six resolutions, 1m/5m/15m/1h/1d/1w in milliseconds;
 * 30m and 2h answer 400. Both limits were checked against the live endpoint on
 * 2026-08-03 rather than read from a document. Points below are chosen to stay
 * under 200 while covering the window.
 */
export const RANGES = {
  "1D": { days: 1, resolution: 900_000, points: 96 },
  "1W": { days: 7, resolution: 3_600_000, points: 168 },
  "1M": { days: 30, resolution: 86_400_000, points: 30 },
  "6M": { days: 180, resolution: 86_400_000, points: 180 },
  "1Y": { days: 365, resolution: 604_800_000, points: 52 },
} as const;

export type RangeId = keyof typeof RANGES;

export interface PricePoint {
  /** Candle start, ms since epoch. */
  at: number;
  /** Close, in USDC. */
  price: number;
}

interface Aggregation {
  timestamp: string;
  close: string;
  counter_volume: string;
  base_volume: string;
}

/**
 * Which mainnet pair prices this asset.
 *
 * Keyed by the symbol the wallet displays. An asset with no entry has no market
 * we can read, and the caller draws no chart rather than inventing one: there is
 * no sensible default price and a wrong one is worse than none.
 */
const PRICED: Record<string, { base: Record<string, string> } | undefined> = {
  XLM: { base: { base_asset_type: "native" } },
  // USDC is the counter asset, so it prices itself at 1 and needs no request.
  USDC: undefined,
};

/** True when this asset is worth exactly one unit of the quote asset. */
export function isQuoteAsset(symbol: string): boolean {
  return symbol.toUpperCase() === "USDC";
}

/** Whether a chart can be drawn for this asset at all. */
export function isPriceable(symbol: string): boolean {
  return isQuoteAsset(symbol) || PRICED[symbol.toUpperCase()] !== undefined;
}

/**
 * Cached series, keyed by asset and range.
 *
 * A range switch refetches at most once per TTL. The popup is reopened often and
 * MV3 restarts the worker with it, so this survives no longer than the worker
 * does; that is fine, because the cost of a miss is one request.
 */
const TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; series: PricePoint[] }>();

/** For tests, which must not inherit a series from an earlier case. */
export function clearPriceCache(): void {
  cache.clear();
}

/**
 * The price series for one asset over one range, oldest first.
 *
 * Returns an EMPTY array when there is no market to read or the request fails.
 * Never throws, and never returns a partial series padded out to length: the
 * caller draws what is real or draws nothing, and "the feed is down" must not be
 * rendered as "your money was worth zero".
 */
export async function priceSeries(symbol: string, range: RangeId): Promise<PricePoint[]> {
  const spec = RANGES[range];
  if (isQuoteAsset(symbol)) {
    // A dollar asset needs no request. Synthesised at exactly 1, which is not a
    // fabricated price: it is the definition of the quote asset.
    const step = spec.resolution;
    const end = Math.floor(Date.now() / step) * step;
    return Array.from({ length: spec.points }, (_, i) => ({
      at: end - (spec.points - 1 - i) * step,
      price: 1,
    }));
  }

  const pair = PRICED[symbol.toUpperCase()];
  if (!pair) return [];

  const key = `${symbol}:${range}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.series;

  const params = new URLSearchParams({
    ...pair.base,
    counter_asset_type: "credit_alphanum4",
    counter_asset_code: USDC.code,
    counter_asset_issuer: USDC.issuer,
    resolution: String(spec.resolution),
    limit: String(spec.points),
    order: "desc",
  });

  try {
    const res = await fetch(`${MAINNET_HORIZON}/trade_aggregations?${params}`, {
      signal: deadlineSignal(),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { _embedded?: { records?: Aggregation[] } };
    const records = body._embedded?.records ?? [];
    const series: PricePoint[] = [];
    // Horizon answers newest first because `order=desc` is the only way to get
    // the MOST RECENT window; ascending would start at the pair's first ever
    // trade in 2015 and return 200 candles from a decade ago.
    for (let i = records.length - 1; i >= 0; i--) {
      const r = records[i]!;
      const at = Number(r.timestamp);
      const price = Number(r.close);
      // A candle we cannot read is dropped, not defaulted. A zero here would
      // draw a cliff to the axis and read as a crash that never happened.
      if (!Number.isFinite(at) || !Number.isFinite(price) || price <= 0) continue;
      series.push({ at, price });
    }
    cache.set(key, { at: Date.now(), series });
    return series;
  } catch {
    // Includes the deadline firing. A price is decoration on a wallet that works
    // without it, so a failure here is an absent chart, never a surfaced error.
    return [];
  }
}

export interface AssetMarket {
  /** Latest close, in USDC. Null when there is no market to read. */
  price: number | null;
  /** Change across the last 24h, as a percentage. Null when unknown. */
  change24h: number | null;
  /** Counter-asset volume over the last 24h, in USDC. Null when unknown. */
  volume24h: number | null;
}

/**
 * Spot, 24h change and 24h volume, from the same endpoint that draws the chart.
 *
 * One call serves both screens, which is a large part of why Horizon was chosen:
 * a separate market-data service would be a second host and a second thing to be
 * down. Note there is deliberately no liquidity figure. Horizon does not publish
 * one, and a row we cannot source is a row we do not draw.
 */
export async function assetMarket(symbol: string): Promise<AssetMarket> {
  if (isQuoteAsset(symbol)) return { price: 1, change24h: 0, volume24h: null };
  const pair = PRICED[symbol.toUpperCase()];
  if (!pair) return { price: null, change24h: null, volume24h: null };

  const params = new URLSearchParams({
    ...pair.base,
    counter_asset_type: "credit_alphanum4",
    counter_asset_code: USDC.code,
    counter_asset_issuer: USDC.issuer,
    resolution: String(86_400_000),
    limit: "2",
    order: "desc",
  });

  try {
    const res = await fetch(`${MAINNET_HORIZON}/trade_aggregations?${params}`, {
      signal: deadlineSignal(),
    });
    if (!res.ok) return { price: null, change24h: null, volume24h: null };
    const body = (await res.json()) as { _embedded?: { records?: Aggregation[] } };
    const [today, yesterday] = body._embedded?.records ?? [];
    if (!today) return { price: null, change24h: null, volume24h: null };

    const price = Number(today.close);
    const volume = Number(today.counter_volume);
    const prev = yesterday ? Number(yesterday.close) : NaN;
    return {
      price: Number.isFinite(price) && price > 0 ? price : null,
      // Each field is independently nullable. A missing previous candle costs
      // the change figure and nothing else; the price is still real.
      change24h:
        Number.isFinite(price) && Number.isFinite(prev) && prev > 0
          ? ((price - prev) / prev) * 100
          : null,
      volume24h: Number.isFinite(volume) ? volume : null,
    };
  } catch {
    return { price: null, change24h: null, volume24h: null };
  }
}
