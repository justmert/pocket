// The archive's data model. INDEXER.md section 3.
//
// SQLite here because the archive must be runnable locally and in CI without
// provisioning anything. The schema is portable to Postgres unchanged; only the
// driver differs.
import Database from "better-sqlite3";

export const SCHEMA = `
-- One row per in-scope event. INDEXER.md 3.1 lists the required fields.
--
-- topics and data are stored as VERBATIM XDR (base64). That is the RECOMMENDED
-- payload because the wallet decodes it directly, and being the on-chain wire
-- form it survives field renames in the Rust bindings with no schema migration.
CREATE TABLE IF NOT EXISTS events (
  -- The event id: (ledger_seq, tx_hash, event_index). The SAME id whether
  -- served from RPC or from here, so a hybrid client can deduplicate across
  -- the seam.
  id                  TEXT PRIMARY KEY,
  contract_id         TEXT NOT NULL,
  ledger_seq          INTEGER NOT NULL,
  close_time          INTEGER NOT NULL,
  tx_hash             TEXT NOT NULL,
  -- Persisted as its own field, because tx_hash conveys NO ordering and the
  -- canonical total order depends on this.
  tx_application_order INTEGER NOT NULL,
  event_index         INTEGER NOT NULL,
  event_type          TEXT NOT NULL,
  topics_xdr          TEXT NOT NULL,
  data_xdr            TEXT NOT NULL,
  -- The invocation payload, for the events whose EVENT body is not enough to
  -- replay them. Base64 XDR of the "data: Bytes" argument, verbatim.
  --
  -- Only "transfer" and "spender_transfer" need it, and they need it badly: a
  -- recipient can derive a candidate amount from the event, but the only thing
  -- that proves the decryption was real is "commit(v, r) == c_transfer", and
  -- "c_transfer" is passed in the invocation and NOT published in the event.
  -- Without it a wallet rebuilding from history has to refuse every transfer it
  -- ever received, which is most wallets that have been used.
  --
  -- NULL for every other event type, and NULL for a transfer whose transaction
  -- could not be fetched. A NULL is honest: the wallet refuses that event
  -- exactly as it did before, rather than crediting an unverifiable amount.
  payload_xdr         TEXT
);

-- Attribution comes from event TOPICS, never from the transaction source
-- account. A Transfer belongs to BOTH the sender's and the recipient's history;
-- a SpenderTransfer to the owner's, recipient's and spender's. Hence a
-- many-to-many table rather than a column on events.
CREATE TABLE IF NOT EXISTS attribution (
  event_id   TEXT NOT NULL REFERENCES events(id),
  account    TEXT NOT NULL,
  PRIMARY KEY (event_id, account)
);

-- Contiguous ingested ranges per contract. A gap that can no longer be
-- backfilled is permanent, and affected ranges MUST then be reported
-- incomplete rather than silently served as complete.
CREATE TABLE IF NOT EXISTS ranges (
  contract_id TEXT NOT NULL,
  from_ledger INTEGER NOT NULL,
  to_ledger   INTEGER NOT NULL,
  PRIMARY KEY (contract_id, from_ledger)
);

-- The canonical total order: (ledger_seq, tx_application_order, event_index).
-- Replay is only correct in emission order.
CREATE INDEX IF NOT EXISTS events_order
  ON events (contract_id, ledger_seq, tx_application_order, event_index);

CREATE INDEX IF NOT EXISTS attribution_account
  ON attribution (account, event_id);
`;

export interface StoredEvent {
  id: string;
  contract_id: string;
  ledger_seq: number;
  close_time: number;
  tx_hash: string;
  tx_application_order: number;
  event_index: number;
  event_type: string;
  topics_xdr: string;
  data_xdr: string;
  /** Base64 XDR of the invocation payload. Only set for transfer events. */
  payload_xdr?: string | null;
}

export function open(path = "pocket-archive.db"): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // The archive is written by one ingest process PER contract (see .env.example),
  // so two writers share one file. WAL lets them; busy_timeout is what keeps the
  // second one from throwing SQLITE_BUSY the instant they overlap, waiting for the
  // brief write lock instead of crashing and leaning on a service restart.
  db.pragma("busy_timeout = 5000");
  db.exec(SCHEMA);
  // Every open, so an archive created before a column existed is brought up to
  // date without an operator having to know a migration was needed.
  migrate(db);
  return db;
}

/** Merge a newly ingested range into the contiguous set, coalescing neighbours. */
export function recordRange(
  db: Database.Database,
  contractId: string,
  from: number,
  to: number,
): void {
  const rows = db
    .prepare(`SELECT from_ledger, to_ledger FROM ranges WHERE contract_id = ? ORDER BY from_ledger`)
    .all(contractId) as { from_ledger: number; to_ledger: number }[];

  const merged: { from: number; to: number }[] = [];
  for (const r of [...rows.map((r) => ({ from: r.from_ledger, to: r.to_ledger })), { from, to }].sort(
    (a, b) => a.from - b.from,
  )) {
    const last = merged[merged.length - 1];
    // Adjacent counts as contiguous: [1,5] and [6,9] leave no gap.
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to);
    else merged.push({ ...r });
  }

  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM ranges WHERE contract_id = ?`).run(contractId);
    const ins = db.prepare(
      `INSERT INTO ranges (contract_id, from_ledger, to_ledger) VALUES (?, ?, ?)`,
    );
    for (const m of merged) ins.run(contractId, m.from, m.to);
  });
  tx();
}

/**
 * Is the whole requested range covered by ONE contiguous ingested range?
 *
 * This is the C3 completeness signal, and it is the difference between an
 * archive a wallet can trust and one it cannot. `complete: true` means gap-free
 * across the entire requested window, nothing weaker.
 */
export function isComplete(
  db: Database.Database,
  contractId: string,
  from: number,
  to: number,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM ranges WHERE contract_id = ? AND from_ledger <= ? AND to_ledger >= ? LIMIT 1`,
    )
    .get(contractId, from, to);
  return row !== undefined;
}

/** The highest ledger ingested contiguously from the earliest known point. */
export function ingestedThrough(db: Database.Database, contractId: string): number | null {
  const row = db
    .prepare(
      `SELECT to_ledger FROM ranges WHERE contract_id = ? ORDER BY from_ledger LIMIT 1`,
    )
    .get(contractId) as { to_ledger: number } | undefined;
  return row?.to_ledger ?? null;
}

/**
 * Bring an existing archive up to the current schema.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * a column added after an archive was created would be missing on every
 * deployment that predates it, and the failure would be a query error at read
 * time rather than at startup. Checked by name against the live table, so it is
 * safe to run on every open and on a fresh database.
 */
export function migrate(db: Database.Database): void {
  const columns = db.prepare(`PRAGMA table_info(events)`).all() as { name: string }[];
  if (!columns.some((c) => c.name === "payload_xdr")) {
    db.exec(`ALTER TABLE events ADD COLUMN payload_xdr TEXT`);
  }
}
