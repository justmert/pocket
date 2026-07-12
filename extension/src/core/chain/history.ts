// Public-pocket transaction history, from Horizon.
//
// Horizon keeps the FULL payment history of an account (unlike Soroban RPC's
// seven-day event window), with a wall-clock `created_at` and a tx hash on every
// record, which is exactly what a history list needs. This reads the account's
// `/payments` stream and maps each record into the wallet's own `HistoryEntry`
// vocabulary. Amounts are Horizon's own decimal strings, passed through verbatim
// and never through a float.
//
// The confidential deposit/withdraw legs are deliberately EXCLUDED here when the
// counterparty is the confidential token contract: those moments are shown from
// the private side as `shield`/`unshield`, with their real (decrypted) amount,
// so showing the public leg too would double-count one movement.
import { deadlineSignal } from "./http";
import { formatAmount } from "./balances";
import type { HistoryEntry } from "../messages";

const PAGE = 50;
/** How far back a single call will walk Horizon before giving up on older pages. */
const MAX_PAGES = 20;

/**
 * The sort key both pockets are merged and paginated by: newest first, ties
 * broken by id. A private id and a public id never collide, and string order is
 * total and deterministic, which is all pagination needs.
 */
export interface HistoryCursor {
  at: number;
  id: string;
}

/** True when (at, id) sorts strictly OLDER than the cursor, in (at desc, id desc) order. */
export function beforeCursor(at: number, id: string, c: HistoryCursor | null): boolean {
  if (!c) return true;
  return at < c.at || (at === c.at && id < c.id);
}

/** Newest first: descending by `at`, then descending by `id`. */
export function byRecency(a: HistoryEntry, b: HistoryEntry): number {
  return b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

export function encodeCursor(c: HistoryCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64");
}

export function decodeCursor(s: string | undefined): HistoryCursor | null {
  if (!s) return null;
  try {
    const o = JSON.parse(Buffer.from(s, "base64").toString("utf8")) as unknown;
    if (o && typeof o === "object") {
      const at = (o as { at?: unknown }).at;
      const id = (o as { id?: unknown }).id;
      if (typeof at === "number" && Number.isFinite(at) && typeof id === "string")
        return { at, id };
    }
  } catch {
    /* a malformed cursor reads as "from the top" rather than an error. */
  }
  return null;
}

/** One Horizon payment-family record. Only the fields this module reads. */
interface PaymentRecord {
  id: string;
  paging_token?: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  // payment / path_payment (destination side)
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  // path_payment (source side), which is what THIS account actually paid
  source_amount?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  // create_account
  account?: string;
  funder?: string;
  starting_balance?: string;
  // joined via ?join=transactions: the fee is a property of the transaction, not
  // the payment operation, so it rides along on the record.
  transaction?: { fee_charged?: string };
}

/** Horizon's asset triple, as a display code. */
function assetCode(type?: string, code?: string): string {
  if (type === "native") return "XLM";
  return code ?? "?";
}

/** The transaction's network fee in decimal XLM, when the join carried it. */
function feeOf(r: PaymentRecord): string | undefined {
  const fc = r.transaction?.fee_charged;
  if (fc === undefined || fc === null) return undefined;
  try {
    return formatAmount(BigInt(fc));
  } catch {
    return undefined;
  }
}

async function fetchPage(url: string): Promise<PaymentRecord[]> {
  const res = await fetch(url, { signal: deadlineSignal() });
  if (!res.ok) throw new Error(`horizon answered ${res.status}`);
  const body = (await res.json()) as { _embedded?: { records?: PaymentRecord[] } };
  return body._embedded?.records ?? [];
}

/**
 * One record into a history entry, or null when it is not this account's money
 * or not a kind we render (a counterparty's leg, an unknown op type, or a leg of
 * a confidential deposit/withdraw shown from the private side instead).
 */
function mapPayment(
  r: PaymentRecord,
  me: string,
  exclude: ReadonlySet<string>,
): HistoryEntry | null {
  const at = Date.parse(r.created_at);
  if (!Number.isFinite(at)) return null;
  const id = `${r.transaction_hash}:${r.id}`;
  const base = { id, pocket: "public" as const, at, hash: r.transaction_hash, fee: feeOf(r) };

  if (r.type === "create_account") {
    // Only our own creation, which is our first funding. A create_account this
    // account merely funded belongs to the OTHER account.
    if (r.account !== me) return null;
    return {
      ...base,
      kind: "create",
      direction: "in",
      code: "XLM",
      amount: r.starting_balance ?? null,
      counterparty: r.funder,
    };
  }

  if (
    r.type === "payment" ||
    r.type === "path_payment_strict_receive" ||
    r.type === "path_payment_strict_send"
  ) {
    const toMe = r.to === me;
    const fromMe = r.from === me;
    if (!toMe && !fromMe) return null;
    // The confidential deposit/withdraw legs are the private side's story. With
    // more than one confidential wrapper (XLM, USDC, ...), every wrapper's legs
    // are excluded, not just the first.
    if ((r.to && exclude.has(r.to)) || (r.from && exclude.has(r.from))) return null;

    if (toMe) {
      return {
        ...base,
        kind: "receive",
        direction: "in",
        code: assetCode(r.asset_type, r.asset_code),
        amount: r.amount ?? null,
        counterparty: r.from,
      };
    }
    // Sent. For a path payment, what this account parted with is the SOURCE
    // asset and amount, not the destination's.
    const path = r.type !== "payment";
    return {
      ...base,
      kind: "send",
      direction: "out",
      code: path
        ? assetCode(r.source_asset_type, r.source_asset_code)
        : assetCode(r.asset_type, r.asset_code),
      amount: (path ? r.source_amount : r.amount) ?? null,
      counterparty: r.to,
    };
  }

  return null;
}

/**
 * Public history entries strictly older than `before`, newest first, up to
 * `limit`, plus whether more remain.
 *
 * Walks Horizon from the newest page and skips entries at or above the cursor.
 * That re-reads the pages above the cursor on each call rather than resuming
 * from a Horizon token, which keeps the merge with the private side simple (one
 * shared (at, id) cursor for both sources) at the cost of some repeated reads on
 * deep scrolls. Bounded by MAX_PAGES.
 */
export async function publicHistory(opts: {
  horizonUrl: string;
  account: string;
  /**
   * The confidential token contracts, whose payment legs are shown privately
   * instead. One per configured wrapper (XLM, USDC, ...).
   */
  excludeCounterparties?: string[];
  before: HistoryCursor | null;
  limit: number;
}): Promise<{ entries: HistoryEntry[]; more: boolean }> {
  const { horizonUrl, account, excludeCounterparties, before, limit } = opts;
  const exclude = new Set(excludeCounterparties ?? []);
  const base = `${horizonUrl}/accounts/${encodeURIComponent(account)}/payments?order=desc&limit=${PAGE}&join=transactions`;
  const entries: HistoryEntry[] = [];
  let url = base;
  let more = false;

  for (let p = 0; p < MAX_PAGES; p++) {
    const records = await fetchPage(url);
    if (records.length === 0) break;

    for (const r of records) {
      const entry = mapPayment(r, account, exclude);
      if (!entry) continue;
      if (!beforeCursor(entry.at, entry.id, before)) continue;
      if (entries.length >= limit) {
        more = true;
        break;
      }
      entries.push(entry);
    }
    if (more) break;
    if (records.length < PAGE) break; // Horizon exhausted.
    const token = records[records.length - 1]!.paging_token;
    if (!token) break;
    if (p === MAX_PAGES - 1) {
      more = true; // stopped at the page cap, not at the end.
      break;
    }
    url = `${base}&cursor=${encodeURIComponent(token)}`;
  }

  return { entries, more };
}
