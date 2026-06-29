// The read API. INDEXER.md section 6.
//
// C2, C3 and C4 are normative; C1 is recommended and implemented here because
// it lets a dormant account with a long history skip transferring all of it.
//
// The completeness signal (C3) is the one that makes this trustworthy. Serving
// an incomplete range as complete would let a wallet reconstruct a plausible
// wrong balance, which is precisely the failure the whole design exists to
// catch. `complete: true` means gap-free across the ENTIRE requested window.
import type Database from "better-sqlite3";
import { isComplete, ingestedThrough, type StoredEvent } from "./schema.ts";

/** Checkpoint events carry a self-contained (b_tilde, sigma). INDEXER.md 3.2. */
export const CHECKPOINT_TYPES = ["withdraw", "transfer", "set_spender", "revoke_spender"];

export interface EventPage {
  /** The range actually covered, so `complete` is unambiguous. */
  from_ledger: number;
  to_ledger: number;
  events: StoredEvent[];
  cursor: string | null;
  /** C3. False whenever any part of the requested range may be missing. */
  complete: boolean;
}

/** C4. Lets a client bound its staleness and place the archive/RPC seam. */
export function health(db: Database.Database, contractId: string) {
  const latest = db
    .prepare(`SELECT MAX(ledger_seq) AS m FROM events WHERE contract_id = ?`)
    .get(contractId) as { m: number | null };
  const through = ingestedThrough(db, contractId);
  const closeTime = db
    .prepare(
      `SELECT close_time FROM events WHERE contract_id = ? ORDER BY ledger_seq DESC LIMIT 1`,
    )
    .get(contractId) as { close_time: number } | undefined;

  return {
    contract_id: contractId,
    latest_ledger: latest.m,
    ingested_through: through,
    lag_seconds: closeTime ? Math.max(0, Math.floor(Date.now() / 1000) - closeTime.close_time) : null,
  };
}

/**
 * C2. Ordered, paginated history for one account.
 *
 * Ordered by (ledger_seq, tx_application_order, event_index). Replay is only
 * correct in emission order: interleaved deposits, transfers and merges
 * reconstruct different state otherwise.
 *
 * `types` filters by event name and is applied AFTER attribution, never by
 * dropping events from storage.
 */
/** A cursor this archive did not issue. A caller error, not an empty range. */
export class BadCursorError extends Error {
  override readonly name = "BadCursorError";
}

export function accountEvents(
  db: Database.Database,
  contractId: string,
  account: string,
  opts: { fromLedger?: number; toLedger?: number; types?: string[]; cursor?: string; limit?: number } = {},
): EventPage {
  // Default the lower bound to the earliest ledger we hold, not to zero.
  // Defaulting to zero would make every unbounded query report incomplete
  // forever, since no archive holds the genesis ledger, and a permanently
  // false completeness signal is worse than none: clients learn to ignore it.
  const bounds = coveredRange(db, contractId);
  const from = opts.fromLedger ?? bounds.from;
  // Report the window that was REQUESTED, not the one we happen to hold.
  // Clamping to what we hold and then reporting `complete: true` about the
  // narrowed range is a true statement about a question nobody asked, and a
  // client reading `complete` alone inherits a silent gap. Answering the
  // actual question lets isComplete say false, which is the honest reply.
  const to = opts.toLedger ?? bounds.to;
  // Rows still come only from what we hold; there is nothing else to serve.
  const queryTo = Math.min(to, bounds.to);
  // `limit=0` served a complete page of nothing: a client paging through would
  // read "complete: true, events: []" and conclude it had the whole history.
  // Zero is not a page size, it is a request for no answer.
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 1000);
  // An inverted window cannot be complete, because it describes no ledgers at
  // all. Answering `complete: true` about it is a true statement about an empty
  // set and a false one about the history the caller asked for.
  if (to < from) {
    return { events: [], from_ledger: from, to_ledger: to, cursor: null, complete: false };
  }

  const params: unknown[] = [contractId, account, from, queryTo];
  let typeClause = "";
  if (opts.types?.length) {
    typeClause = ` AND e.event_type IN (${opts.types.map(() => "?").join(",")})`;
    params.push(...opts.types);
  }
  let cursorClause = "";
  if (opts.cursor) {
    // Keyset pagination on the canonical order, so a page boundary cannot skip
    // or repeat an event even if new ones arrive between pages.
    // A malformed cursor used to become NaN, and `?? 0` then turned it into
    // "start from the beginning" while the reply still said complete. A client
    // that mangled its cursor was answered about a different window than it
    // asked for and told the answer was whole. Refuse instead: a cursor is
    // ours, so a bad one is a caller error, not a range.
    const parts = opts.cursor.split(":");
    if (parts.length !== 3 || !parts.every((p) => /^\d+$/.test(p))) {
      throw new BadCursorError(`cursor is not one this archive issued: "${opts.cursor}"`);
    }
    const [l, o, i] = parts.map(Number) as [number, number, number];
    cursorClause = ` AND (e.ledger_seq, e.tx_application_order, e.event_index) > (?, ?, ?)`;
    params.push(l, o, i);
  }

  const rows = db
    .prepare(
      `SELECT e.* FROM events e
         JOIN attribution a ON a.event_id = e.id
        WHERE e.contract_id = ? AND a.account = ?
          AND e.ledger_seq >= ? AND e.ledger_seq <= ?
          ${typeClause}${cursorClause}
        ORDER BY e.ledger_seq, e.tx_application_order, e.event_index
        LIMIT ?`,
    )
    .all(...params, limit) as StoredEvent[];

  const last = rows[rows.length - 1];
  return {
    events: rows,
    from_ledger: from,
    to_ledger: to,
    cursor:
      rows.length === limit && last
        ? `${last.ledger_seq}:${last.tx_application_order}:${last.event_index}`
        : null,
    // Gap-free across the ENTIRE range reported above, nothing weaker.
    complete: isComplete(db, contractId, from, to),
  };
}

/** The contiguous window this archive can speak for. */
export function coveredRange(
  db: Database.Database,
  contractId: string,
): { from: number; to: number } {
  const row = db
    .prepare(
      `SELECT from_ledger, to_ledger FROM ranges WHERE contract_id = ? ORDER BY from_ledger LIMIT 1`,
    )
    .get(contractId) as { from_ledger: number; to_ledger: number } | undefined;
  // No ingestion yet: an empty window, so any query over it is incomplete.
  return row ? { from: row.from_ledger, to: row.to_ledger } : { from: 1, to: 0 };
}

/**
 * C1. The most recent checkpoint at or before a ledger.
 *
 * An optimisation, not a correctness requirement: each checkpoint carries a
 * self-contained (b_tilde, sigma) that fully re-derives the spendable opening,
 * so a client can always fall back to scanning C2 instead.
 */
export function latestCheckpoint(
  db: Database.Database,
  contractId: string,
  account: string,
  atLedger?: number,
): { event: StoredEvent | null; from_ledger: number; to_ledger: number; complete: boolean } {
  const to = atLedger ?? Number.MAX_SAFE_INTEGER;
  const row = db
    .prepare(
      `SELECT e.* FROM events e
         JOIN attribution a ON a.event_id = e.id
        WHERE e.contract_id = ? AND a.account = ?
          AND e.ledger_seq <= ?
          AND e.event_type IN (${CHECKPOINT_TYPES.map(() => "?").join(",")})
        ORDER BY e.ledger_seq DESC, e.tx_application_order DESC, e.event_index DESC
        LIMIT 1`,
    )
    .get(contractId, account, to, ...CHECKPOINT_TYPES) as StoredEvent | undefined;

  const bounds = coveredRange(db, contractId);
  // Do NOT clamp the caller's bound before testing. If they ask about a ledger
  // beyond our contiguous coverage, the honest answer is incomplete: events
  // between our coverage and their bound could exist and we would not know.
  const asked = atLedger ?? bounds.to;
  return {
    event: row ?? null,
    from_ledger: bounds.from,
    to_ledger: asked,
    // A checkpoint is only trustworthy if nothing since it could have been
    // missed, so completeness runs from the start of what we hold.
    complete: isComplete(db, contractId, bounds.from, asked),
  };
}
