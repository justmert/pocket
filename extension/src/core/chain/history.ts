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
  /**
   * Horizon's own paging token for the last PUBLIC entry this cursor covers.
   *
   * Without it every call restarted at Horizon's newest page and skipped
   * forward to `(at, id)`, which the function's own comment described as
   * costing "some repeated reads on deep scrolls". The real cost was harder:
   * the skip is bounded by MAX_PAGES x PAGE = 1000 records, so once a cursor
   * sat past record 1000 every page was skipped, the call returned no entries,
   * and history older than that was unreachable at any speed. Activity simply
   * stopped, with nothing on screen saying it had been truncated.
   *
   * Optional because a cursor issued before this existed has no token, and
   * must keep working: absent, the walk starts at the newest page exactly as
   * it used to.
   */
  token?: string;
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
      const token = (o as { token?: unknown }).token;
      if (typeof at === "number" && Number.isFinite(at) && typeof id === "string") {
        return typeof token === "string" && token ? { at, id, token } : { at, id };
      }
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
  asset_issuer?: string;
  // path_payment (source side), which is what THIS account actually paid
  source_amount?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  // create_account
  account?: string;
  funder?: string;
  // account_merge: `account` above is the one being destroyed, `into` receives
  // its whole XLM balance.
  into?: string;
  starting_balance?: string;
  // invoke_host_function: a Soroban call. It carries NO top-level from/to/amount,
  // which is why every one of them used to fall off the end of `mapPayment` and
  // vanish from history. What it carries instead is the list below, and the
  // contract it invoked.
  address?: string;
  asset_balance_changes?: AssetBalanceChange[];
  // joined via ?join=transactions: the fee is a property of the transaction, not
  // the payment operation, so it rides along on the record. `source_account` is
  // who PAID it, which is the difference between our fee and a stranger's.
  transaction?: { fee_charged?: string; source_account?: string };
  /**
   * Whether the TRANSACTION this operation belonged to succeeded.
   *
   * Horizon puts this on every operation record and it is only ever false once
   * `include_failed=true` is asked for, which this module now does. A failed
   * transaction charged its fee and consumed a sequence number, so it is part
   * of the account's history whether or not it moved anything.
   */
  transaction_successful?: boolean;
}

/**
 * One movement of a classic asset caused by a contract call.
 *
 * Horizon reports these on `invoke_host_function` records, with the same asset
 * triple a payment carries. `type` is the SAC operation: a `transfer` has both
 * sides, a `burn` has only `from`, a `mint` only `to`. Read from a live testnet
 * record rather than from documentation:
 *
 *   { asset_type: "credit_alphanum4", asset_code: "USDC",
 *     asset_issuer: "GBBD47IF...", type: "transfer",
 *     from: "GB43MNLS...", to: "CDNG7HXA...", amount: "1.2345670" }
 */
interface AssetBalanceChange {
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
  type?: string;
  from?: string;
  to?: string;
  amount?: string;
}

/** Horizon's asset triple, as a display code. */
function assetCode(type?: string, code?: string): string {
  if (type === "native") return "XLM";
  return code ?? "?";
}

/**
 * The issuer half of the same triple, absent for native.
 *
 * Beside `assetCode` deliberately: a code without its issuer does not identify
 * an asset, and reading one without the other is how two different tokens came
 * to render as the same row.
 */
function assetIssuer(type?: string, issuer?: string): string | undefined {
  return type === "native" ? undefined : issuer;
}

/**
 * The network fee THIS account paid, in decimal XLM, when the join carried it.
 *
 * Only when this account was the transaction's source. The fee rode along on
 * every record through `base`, so a payment RECEIVED from someone else showed
 * that someone else's fee in a row labelled "Onchain fee", against money coming
 * in. The reader has no way to tell it is not theirs, and it is a figure about
 * a stranger's transaction appearing in their own history.
 */
function feeOf(r: PaymentRecord, me: string): string | undefined {
  if (r.transaction?.source_account !== me) return undefined;
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
  // A never-funded account does not exist on Horizon yet, so /payments answers
  // 404. That is "no history", not a read failure: reported as an error it made a
  // fresh wallet's Activity show "Your public history could not be read just now."
  // on the first screen a new user opens. balances() and trustlines() already
  // treat a 404 the same way (the account simply is not on the ledger yet).
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`horizon answered ${res.status}`);
  const body = (await res.json()) as { _embedded?: { records?: PaymentRecord[] } };
  return body._embedded?.records ?? [];
}

/**
 * One record into a history entry, or null when it is not this account's money
 * or not a kind we render (a counterparty's leg, an unknown op type, or a leg of
 * a confidential deposit/withdraw shown from the private side instead).
 */
function mapPayment(r: PaymentRecord, me: string, exclude: ReadonlySet<string>): HistoryEntry[] {
  const at = Date.parse(r.created_at);
  if (!Number.isFinite(at)) return [];
  const id = `${r.transaction_hash}:${r.id}`;
  // A FAILED transaction is included now (`include_failed=true` above), so
  // every entry carries whether it landed. Horizon reports `false` only for a
  // transaction that was included and reverted: it charged its fee and took the
  // sequence number, and it moved nothing. The row says so rather than sitting
  // in the list looking like a payment that went through.
  const failed = r.transaction_successful === false;
  const base = {
    id,
    pocket: "public" as const,
    at,
    hash: r.transaction_hash,
    fee: feeOf(r, me),
    ...(failed
      ? { failed: true, failureReason: "This transaction failed on the network. Nothing moved." }
      : {}),
  };

  if (r.type === "create_account") {
    // Only our own creation, which is our first funding. A create_account this
    // account merely funded belongs to the OTHER account.
    if (r.account !== me) return [];
    return [
      {
        ...base,
        kind: "create",
        direction: "in",
        code: "XLM",
        amount: r.starting_balance ?? null,
        counterparty: r.funder,
      },
    ];
  }

  // A Soroban call. Every in-app swap, yield move and CCTP leg is one of these,
  // and until this branch existed all four were absent from history entirely: a
  // user could swap 100 XLM, close the wallet, and Activity would say they had
  // never done anything. The value movements are real and Horizon reports them
  // on the same endpoint this function already walks, so the record was being
  // fetched and then dropped by the type check below it.
  //
  // One record can yield TWO entries, because that is what a swap is: the asset
  // that left and the asset that arrived are separate movements and collapsing
  // them into one would have to discard half. Both are true, and both are the
  // account's own money.
  if (r.type === "invoke_host_function") {
    const mine: {
      index: number;
      toMe: boolean;
      other?: string;
      code: string;
      issuer?: string;
      amount?: string;
    }[] = [];
    (r.asset_balance_changes ?? []).forEach((c, i) => {
      const toMe = c.to === me;
      const fromMe = c.from === me;
      if (!toMe && !fromMe) return;
      // The counterparty of a burn or a mint is absent by construction, so fall
      // back to the contract that was invoked. That is a real counterparty and
      // it is always present, which keeps a CCTP claim from rendering as
      // "Received from " with nothing after it.
      const other = (toMe ? c.from : c.to) ?? r.address;
      // The confidential wrappers' legs are the private pocket's story, told
      // from the private side. This is the first place the exclusion has ever
      // had anything to match: a classic payment names G-addresses on `to` and
      // `from`, and the excluded ids are contracts, so the check below could
      // never fire. A shield is an invocation whose balance change names the
      // wrapper, which is exactly this shape, so without this line shielding
      // would appear once in each pocket.
      if (other && exclude.has(other)) return;
      mine.push({
        index: i,
        toMe,
        other,
        code: assetCode(c.asset_type, c.asset_code),
        issuer: assetIssuer(c.asset_type, c.asset_issuer),
        ...(c.amount !== undefined ? { amount: c.amount } : {}),
      });
    });

    // A swap is recognised by its SHAPE, not by the contract it called: value of
    // one asset left and value of another arrived inside a single invocation.
    // That is derivable from what Horizon already returned, so it needs no list
    // of router addresses to keep in step with config, and it stays right for a
    // venue this wallet has never heard of.
    //
    // Two assets is the load-bearing half of the test. A call that took an asset
    // and returned the same asset is a round trip, not an exchange, and calling
    // it a swap would put a word on the screen the movements do not support.
    // Everything that fails this test stays send/receive, which is the most the
    // wallet can honestly say about a call it cannot identify.
    const swapped =
      mine.some((m) => !m.toMe) &&
      mine.some((m) => m.toMe) &&
      new Set(mine.map((m) => m.code)).size > 1;

    return mine.map((m) => ({
      ...base,
      // The op id is not unique when one record yields two entries, and the id
      // is what pagination and reconciliation key on.
      id: `${id}:${m.index}`,
      kind: swapped ? ("swap" as const) : m.toMe ? ("receive" as const) : ("send" as const),
      direction: m.toMe ? ("in" as const) : ("out" as const),
      code: m.code,
      issuer: m.issuer,
      amount: m.amount ?? null,
      counterparty: m.other,
    }));
  }

  if (
    r.type === "payment" ||
    r.type === "path_payment_strict_receive" ||
    r.type === "path_payment_strict_send"
  ) {
    const toMe = r.to === me;
    const fromMe = r.from === me;
    if (!toMe && !fromMe) return [];
    // The confidential deposit/withdraw legs are the private side's story. With
    // more than one confidential wrapper (XLM, USDC, ...), every wrapper's legs
    // are excluded, not just the first.
    if ((r.to && exclude.has(r.to)) || (r.from && exclude.has(r.from))) return [];

    // BOTH ends when this account is both, which for a path payment is a
    // classic-DEX swap: the account sends one asset and receives another in the
    // same operation. `toMe` was tested first and returned immediately, so the
    // row said only what arrived and the asset that LEFT was invisible. A swap
    // rendered as a gift.
    if (toMe && fromMe && r.type !== "payment") {
      return [
        {
          ...base,
          id: `${base.id}:in`,
          kind: "swap",
          direction: "in",
          code: assetCode(r.asset_type, r.asset_code),
          issuer: assetIssuer(r.asset_type, r.asset_issuer),
          amount: r.amount ?? null,
          counterparty: r.from,
        },
        {
          ...base,
          id: `${base.id}:out`,
          kind: "swap",
          direction: "out",
          code: assetCode(r.source_asset_type, r.source_asset_code),
          issuer: assetIssuer(r.source_asset_type, r.source_asset_issuer),
          amount: r.source_amount ?? null,
          counterparty: r.to,
        },
      ];
    }

    if (toMe) {
      return [
        {
          ...base,
          kind: "receive",
          direction: "in",
          code: assetCode(r.asset_type, r.asset_code),
          issuer: assetIssuer(r.asset_type, r.asset_issuer),
          amount: r.amount ?? null,
          counterparty: r.from,
        },
      ];
    }
    // Sent. For a path payment, what this account parted with is the SOURCE
    // asset and amount, not the destination's.
    const path = r.type !== "payment";
    return [
      {
        ...base,
        kind: "send",
        direction: "out",
        code: path
          ? assetCode(r.source_asset_type, r.source_asset_code)
          : assetCode(r.asset_type, r.asset_code),
        issuer: path
          ? assetIssuer(r.source_asset_type, r.source_asset_issuer)
          : assetIssuer(r.asset_type, r.asset_issuer),
        amount: (path ? r.source_amount : r.amount) ?? null,
        counterparty: r.to,
      },
    ];
  }

  // An ACCOUNT MERGE moves the whole XLM balance of one account into another and
  // deletes the source. Horizon serves it on the /payments endpoint like any
  // other movement, and this fell off the end and returned nothing, so the
  // largest single credit an account can receive left no row at all: the
  // balance jumped and Activity said nothing had happened.
  //
  // `into` is the recipient and `account` the one being destroyed. The amount is
  // NOT on the record (Horizon reports it as an effect), so it is left null
  // rather than invented; `null` is the shape every other unknown amount uses
  // and the row still says who and when.
  if (r.type === "account_merge") {
    if (r.into === me) {
      return [
        {
          ...base,
          kind: "receive",
          direction: "in",
          code: "XLM",
          amount: null,
          counterparty: r.account,
        },
      ];
    }
    if (r.account === me) {
      return [
        {
          ...base,
          kind: "send",
          direction: "out",
          code: "XLM",
          amount: null,
          counterparty: r.into,
        },
      ];
    }
    return [];
  }

  return [];
}

/**
 * Public history entries strictly older than `before`, newest first, up to
 * `limit`, plus whether more remain and where Horizon got to.
 *
 * RESUMES from `before.token` when the cursor carries one, rather than walking
 * from Horizon's newest page and skipping forward. The old comment here
 * described the cost of that skip as "some repeated reads on deep scrolls",
 * which understated it: the skip is bounded by MAX_PAGES x PAGE = 1000 records,
 * so a cursor past record 1000 skipped every page, returned nothing, and made
 * older history unreachable at any speed. The `(at, id)` cursor is still the
 * authority on what has been shown, so the token is only ever a starting point
 * and nothing can be skipped by trusting it.
 *
 * `tokenOf` maps each returned entry's id to the Horizon paging token of the
 * record it came from. The caller merges these entries with the private side
 * and may keep only some of them, so only the caller knows which token the next
 * cursor should carry.
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
}): Promise<{ entries: HistoryEntry[]; more: boolean; tokenOf: Record<string, string> }> {
  const { horizonUrl, account, excludeCounterparties, before, limit } = opts;
  const exclude = new Set(excludeCounterparties ?? []);
  // `include_failed=true`, because a failed transaction is a thing that
  // happened.
  //
  // Horizon defaults this to false, so the only history URL the wallet has
  // returned successful operations ONLY: a payment that was included and failed
  // charged its fee, consumed the sequence number, and then appeared nowhere in
  // Activity at all. Measured on a live account: the exact URL this line used
  // to build returned 50 records with 0 failed; the same URL with this flag
  // returned 50 records, all 50 of them failed.
  //
  // The wallet's whole answer to "did that go through" is this list, and an
  // absence read as "it never happened" is the one reading that invites the
  // resend. The rows are LABELLED as failed below; showing them unmarked would
  // be worse than hiding them.
  const base = `${horizonUrl}/accounts/${encodeURIComponent(account)}/payments?order=desc&limit=${PAGE}&join=transactions&include_failed=true`;
  const entries: HistoryEntry[] = [];
  const tokenOf: Record<string, string> = {};
  // Resume where the last page left off. Horizon's `cursor` is exclusive and
  // the records are in the same order the merge sorts by, so everything from
  // here is older than what has already been shown.
  let url = before?.token ? `${base}&cursor=${encodeURIComponent(before.token)}` : base;
  let more = false;

  for (let p = 0; p < MAX_PAGES; p++) {
    const records = await fetchPage(url);
    if (records.length === 0) break;

    for (const r of records) {
      // One record can carry more than one entry: a swap moves value out and in
      // within a single invocation, and both movements are this account's.
      const fromRecord = mapPayment(r, account, exclude).filter((e) =>
        beforeCursor(e.at, e.id, before),
      );
      if (fromRecord.length === 0) continue;
      // A RECORD is the unit, not an entry. The limit was checked between the
      // two halves of a swap, so a page boundary landing there kept the "out"
      // leg and dropped the "in": the next page resumes from the record's
      // paging token, which is now behind the cursor, so the dropped half is
      // never fetched again. One of a swap's two rows disappeared permanently,
      // and the balance no longer agreed with the list that explained it.
      //
      // Stopping BEFORE a record that will not fit keeps the page at or under
      // the limit and leaves the whole record for the next one.
      if (entries.length > 0 && entries.length + fromRecord.length > limit) {
        more = true;
        break;
      }
      for (const entry of fromRecord) {
        entries.push(entry);
        if (r.paging_token) tokenOf[entry.id] = r.paging_token;
      }
      // A single record wider than the whole page is served whole rather than
      // split, because splitting it is the defect above. The page then runs one
      // or two entries over the limit, which is a page-size question; losing
      // half a swap is a correctness one.
      if (entries.length >= limit) {
        more = true;
        break;
      }
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

  return { entries, more, tokenOf };
}
