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
  const to = Math.min(opts.toLedger ?? bounds.to, bounds.to);
  const limit = Math.min(opts.limit ?? 200, 1000);

  const params: unknown[] = [contractId, account, from, to];
  let typeClause = "";
  if (opts.types?.length) {
    typeClause = ` AND e.event_type IN (${opts.types.map(() => "?").join(",")})`;
    params.push(...opts.types);
  }
  let cursorClause = "";
  if (opts.cursor) {
    // Keyset pagination on the canonical order, so a page boundary cannot skip
    // or repeat an event even if new ones arrive between pages.
    const [l, o, i] = opts.cursor.split(":").map(Number);
    cursorClause = ` AND (e.ledger_seq, e.tx_application_order, e.event_index) > (?, ?, ?)`;
    params.push(l ?? 0, o ?? 0, i ?? 0);
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
): { event: StoredEvent | null; complete: boolean } {
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
  return {
    event: row ?? null,
    // A checkpoint is only trustworthy if nothing since it could have been
    // missed, so completeness runs from the start of what we hold.
    complete: isComplete(db, contractId, bounds.from, Math.min(to, bounds.to)),
  };
}
