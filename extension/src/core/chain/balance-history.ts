// What this account's balance actually was, over time.
//
// The chart plots value(t) = balance_at(t) * price_at(t). That is deliberately
// NOT what the reference wallet draws: it computes holdings_now * price(t),
// which redraws the past as though you always held what you hold today, so
// deposits and withdrawals are invisible and only price moves the line.
//
// The difference is visible in a real capture. An Umbra 1M chart sits flat near
// zero for most of the month, steps up sharply, then flattens. Scaling a price
// curve by a constant cannot produce a step, so that shape can only come from a
// real balance history. The step is the deposit.
//
// Read from the ACTIVE network's Horizon, because that is the only place this
// account exists. Price comes from mainnet (see prices.ts). The two hosts have
// different jobs and must not be collapsed into one.
import { deadlineSignal } from "./http";
import { STROOPS_PER_UNIT } from "./balances";

/** How far back a series is allowed to walk before we admit we cannot draw it. */
const MAX_PAGES = 10;
const PAGE = 200;

/** A balance change, at a moment. Deltas are signed stroops. */
interface Delta {
  at: number;
  delta: bigint;
}

/** The balance in force from `at` until the next point. A step function. */
export interface BalancePoint {
  at: number;
  stroops: bigint;
}

interface EffectRecord {
  type: string;
  account?: string;
  created_at: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  starting_balance?: string;
  bought_amount?: string;
  bought_asset_type?: string;
  bought_asset_code?: string;
  bought_asset_issuer?: string;
  sold_amount?: string;
  sold_asset_type?: string;
  sold_asset_code?: string;
  sold_asset_issuer?: string;
}

interface TxRecord {
  created_at: string;
  fee_charged: string;
  source_account: string;
}

/** Horizon writes 7dp decimal strings. Parsed exactly; never through a float. */
function stroops(text: string | undefined): bigint {
  if (!text) return 0n;
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text.trim());
  if (!m) return 0n;
  const [, sign, whole, frac = ""] = m;
  const raw =
    BigInt(whole as string) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, "0").slice(0, 7) || "0");
  return sign === "-" ? -raw : raw;
}

/** Horizon's asset triple, in the wallet's own canonical form. */
function assetIdOf(type?: string, code?: string, issuer?: string): string | null {
  if (type === "native") return "native";
  if (!code || !issuer) return null;
  return `${code}:${issuer}`;
}

async function page<T>(url: string): Promise<T[]> {
  const res = await fetch(url, { signal: deadlineSignal() });
  if (!res.ok) throw new Error(`horizon answered ${res.status}`);
  const body = (await res.json()) as { _embedded?: { records?: T[] } };
  return body._embedded?.records ?? [];
}

/**
 * Every signed balance change for one asset, newest first, back to `since`.
 *
 * Only the effects that actually move a balance are read. Horizon publishes
 * dozens of effect types and most touch no balance at all, so this is an
 * allowlist: an effect nobody classified must not be silently treated as zero.
 *
 * FEES ARE READ SEPARATELY AND THIS IS NOT OPTIONAL. Horizon emits no fee
 * effect: verified against the live endpoint, 200 network-wide effects contained
 * no fee-ish type at all. Replaying effects alone therefore drifts from the real
 * balance by every fee the account ever paid, and the drift is invisible because
 * the curve still looks plausible. Fees only touch native XLM, so the second
 * request is made only for that asset.
 */
async function deltasFor(
  horizonUrl: string,
  account: string,
  assetId: string,
  since: number,
): Promise<{ deltas: Delta[]; createdAt: number | null } | null> {
  const deltas: Delta[] = [];
  // When the account's own creation falls inside the window, the balance before
  // it is known exactly: zero. That turns into a free reconciliation below.
  let createdAt: number | null = null;
  let url = `${horizonUrl}/accounts/${account}/effects?order=desc&limit=${PAGE}`;

  for (let p = 0; p < MAX_PAGES; p++) {
    const records = await page<EffectRecord>(url);
    if (records.length === 0) break;
    let reachedStart = false;

    for (const e of records) {
      const at = Date.parse(e.created_at);
      if (!Number.isFinite(at)) continue;
      if (at < since) {
        reachedStart = true;
        break;
      }
      // /accounts/{id}/effects can include effects belonging to a counterparty
      // on the same operation, and crediting those to this account would invent
      // money. The `account` field names whose balance moved.
      if (e.account && e.account !== account) continue;

      // The account being created. Friendbot and every createAccount operation
      // produce THIS and no account_credited, so leaving it out made the single
      // most important moment in any wallet's chart invisible: its first
      // funding. Caught by the live test against a fresh testnet account, which
      // is the only place it shows up.
      if (e.type === "account_created") {
        if (assetId !== "native") continue;
        deltas.push({ at, delta: stroops(e.starting_balance) });
        createdAt = at;
        continue;
      }

      if (e.type === "account_credited" || e.type === "account_debited") {
        if (assetIdOf(e.asset_type, e.asset_code, e.asset_issuer) !== assetId) continue;
        const amount = stroops(e.amount);
        deltas.push({ at, delta: e.type === "account_credited" ? amount : -amount });
        continue;
      }

      if (e.type === "trade" || e.type === "liquidity_pool_trade") {
        // A trade moves both sides. Each is checked independently because one
        // leg may be the asset being charted and the other may not.
        if (
          assetIdOf(e.bought_asset_type, e.bought_asset_code, e.bought_asset_issuer) === assetId
        ) {
          deltas.push({ at, delta: stroops(e.bought_amount) });
        }
        if (assetIdOf(e.sold_asset_type, e.sold_asset_code, e.sold_asset_issuer) === assetId) {
          deltas.push({ at, delta: -stroops(e.sold_amount) });
        }
        continue;
      }
    }

    if (reachedStart || records.length < PAGE) break;
    if (p === MAX_PAGES - 1) {
      // Deeper than we are willing to walk. Returning what we have would draw a
      // curve that is confidently wrong before its first point, so the caller is
      // told the range cannot be drawn instead.
      return null;
    }
    const last = records[records.length - 1] as EffectRecord & { paging_token?: string };
    if (!last.paging_token) return null;
    url = `${horizonUrl}/accounts/${account}/effects?order=desc&limit=${PAGE}&cursor=${last.paging_token}`;
  }

  if (assetId !== "native") return { deltas, createdAt };

  // Fees, which no effect reports.
  //
  // `include_failed=true`, because a FAILED transaction still charges its fee
  // and still moves the native balance. Horizon omits failed transactions by
  // default, so the walk reconstructed a balance that never subtracted them and
  // drifted from the ledger by the sum of every failure. On a real account with
  // any failed transaction the reconstruction cannot close, `balanceHistory`
  // returns null, and `valueSeries` withholds the whole chart: 1M, 6M and 1Y
  // simply do not draw.
  let txUrl = `${horizonUrl}/accounts/${account}/transactions?order=desc&include_failed=true&limit=${PAGE}`;
  for (let p = 0; p < MAX_PAGES; p++) {
    const records = await page<TxRecord & { paging_token?: string }>(txUrl);
    if (records.length === 0) break;
    let reachedStart = false;
    for (const t of records) {
      const at = Date.parse(t.created_at);
      if (!Number.isFinite(at)) continue;
      if (at < since) {
        reachedStart = true;
        break;
      }
      // Only what THIS account paid. The list includes transactions it merely
      // took part in, and charging it someone else's fee would bend the curve
      // down for activity it never funded.
      if (t.source_account !== account) continue;
      deltas.push({ at, delta: -BigInt(t.fee_charged || "0") });
    }
    if (reachedStart || records.length < PAGE) break;
    if (p === MAX_PAGES - 1) return null;
    const last = records[records.length - 1]!;
    if (!last.paging_token) return null;
    txUrl = `${horizonUrl}/accounts/${account}/transactions?order=desc&limit=${PAGE}&cursor=${last.paging_token}`;
  }

  return { deltas, createdAt };
}

/**
 * This account's balance for one asset, as a step function over `since..now`.
 *
 * Anchored on the CURRENT balance and walked backward, so the newest point is
 * exact by construction rather than by summing a decade of history correctly.
 * Every step back subtracts the change that produced it.
 *
 * Returns null when the history cannot be reconstructed. The caller draws
 * nothing: a chart is decoration, and a wrong one is worse than none.
 */
export async function balanceHistory(opts: {
  horizonUrl: string;
  account: string;
  assetId: string;
  currentStroops: bigint;
  since: number;
}): Promise<BalancePoint[] | null> {
  const { horizonUrl, account, assetId, currentStroops, since } = opts;
  let read: { deltas: Delta[]; createdAt: number | null } | null;
  try {
    read = await deltasFor(horizonUrl, account, assetId, since);
  } catch {
    return null;
  }
  if (read === null) return null;
  const { deltas, createdAt } = read;

  deltas.sort((a, b) => b.at - a.at); // newest first

  const points: BalancePoint[] = [{ at: Date.now(), stroops: currentStroops }];
  let running = currentStroops;
  for (const d of deltas) {
    // `running` is the balance IN FORCE from this change until the next one, so
    // it is stamped at this change's own time BEFORE stepping back over it.
    //
    // The order of these two lines is the whole defect this fixes. Subtracting
    // first stamped the balance from BEFORE the change at the moment of the
    // change, and `balanceAt` reads a point's `at` as the START of the interval
    // that value governs, so every segment of the curve showed the previous
    // segment's balance. A wallet funded on Monday and idle since read as empty
    // all week and jumped to its real value only at the right-hand edge.
    points.push({ at: d.at, stroops: running });
    running -= d.delta;
  }

  // A balance cannot be negative. If the walk produces one, some change was
  // missed and every earlier point is wrong, so nothing is drawn. This is the
  // same fail-closed rule the opening store follows: a reconstruction that does
  // not reconcile is refused rather than shown.
  //
  // `running` is checked alongside the points because it is no longer one of
  // them: it is now the balance before the OLDEST change, which the loop above
  // stamps nowhere. Without this the walk could end below zero unnoticed on any
  // account whose creation predates the window.
  if (running < 0n || points.some((p) => p.stroops < 0n)) return null;

  // THE RECONCILIATION. When the account's creation is inside the window, the
  // balance immediately before it is known exactly, and it is zero. Walking all
  // the way back has to arrive there.
  //
  // This is what keeps the effect allowlist above honest. Horizon publishes
  // dozens of effect types and this module classifies a handful; a
  // balance-affecting type nobody thought of would otherwise leave a curve that
  // is wrong and still looks entirely plausible. That is not hypothetical:
  // `account_created` was missing from the first version of this file, which
  // made every wallet's first funding invisible, and only a live test against a
  // fresh account found it. Costs one comparison and no request.
  if (createdAt !== null && running !== 0n) return null;

  // THE LEFT EDGE. `running` is now the balance the account held before the
  // oldest change in the window, which is the balance it held when the window
  // opened. Nothing stamps it, and `balanceAt` reads anything before its first
  // point as a real zero, so without this an account that simply held a balance
  // and did nothing drew a flat zero across the whole range and then stepped up
  // at the right-hand edge. That is the commonest shape a wallet has, and the
  // zero is the one reading the module says elsewhere it must never invent.
  //
  // Skipped when the account was CREATED inside the window: there the zero
  // before the first point is true, the account did not exist, and the creation
  // itself is already a delta carrying the opening balance.
  if (createdAt === null) points.push({ at: since, stroops: running });

  points.reverse(); // oldest first
  return points;
}

/**
 * The balance in force at `t`, given a step function.
 *
 * Before the first point the account held nothing, which is a real zero and is
 * drawn as one: a wallet that did not exist two months ago was worth nothing two
 * months ago. That is different from a zero caused by a failed price feed, which
 * draws no curve at all.
 */
export function balanceAt(points: BalancePoint[], t: number): bigint {
  if (points.length === 0 || t < points[0]!.at) return 0n;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (points[mid]!.at <= t) lo = mid;
    else hi = mid - 1;
  }
  return points[lo]!.stroops;
}
