// Ingestion. INDEXER.md section 4.
//
// Three obligations:
//   Freshness    the ingested-through ledger must stay within the source's
//                retention window, at or above the seam a hybrid client would
//                set. It need not track the chain head, because RPC serves the
//                recent tail. But if it falls below the seam a gap opens that
//                NEITHER source covers, and that gap is permanent.
//   Idempotency  at-least-once, deduplicated by event id.
//   Gaps         track contiguous ranges. A gap that can no longer be filled
//                MUST be reported incomplete, never silently served as whole.
import { rpc } from "@stellar/stellar-sdk";
import { scValToNative, xdr } from "@stellar/stellar-sdk/base";
import type Database from "better-sqlite3";
import { recordRange, type StoredEvent } from "./schema.ts";

/** Events that matter for balance recovery. INDEXER.md 3.2. */
export const IN_SCOPE = new Set([
  "register",
  "deposit",
  "merge",
  "withdraw",
  "transfer",
  "spender_transfer",
  "set_spender",
  "revoke_spender",
]);

/**
 * Which accounts an event belongs to.
 *
 * Attribution is a pure function of the TOPICS. Never the transaction source
 * account: a Transfer belongs to both parties, and the submitter may be neither
 * of them once fee abstraction is in play.
 */
export function attributionOf(eventType: string, topics: unknown[]): string[] {
  const addrs = topics
    .slice(1)
    .filter((t): t is string => typeof t === "string" && /^[GC][A-Z2-7]{55}$/.test(t));
  return [...new Set(addrs)];
}

export interface IngestResult {
  ingested: number;
  fromLedger: number;
  toLedger: number;
}

/**
 * Pull events for one contract over a ledger range and store them.
 *
 * Storage is verbatim XDR. Decoding for queries is a read-side concern, and
 * storing decoded fields would couple the archive to a binding version.
 */
export async function ingestRange(
  db: Database.Database,
  server: rpc.Server,
  contractId: string,
  fromLedger: number,
  toLedger: number,
): Promise<IngestResult> {
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events
       (id, contract_id, ledger_seq, close_time, tx_hash, tx_application_order,
        event_index, event_type, topics_xdr, data_xdr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertAttribution = db.prepare(
    `INSERT OR IGNORE INTO attribution (event_id, account) VALUES (?, ?)`,
  );

  let cursor: string | undefined;
  let ingested = 0;

  for (;;) {
    const filters = [{ type: "contract" as const, contractIds: [contractId] }];
    const page = await (cursor
      ? server.getEvents({ cursor, filters, limit: 200 })
      : server.getEvents({ startLedger: fromLedger, endLedger: toLedger, filters, limit: 200 }));

    if (page.events.length === 0) break;

    const write = db.transaction(() => {
      for (const e of page.events) {
        let type: string;
        try {
          type = scValToNative(e.topic[0] as xdr.ScVal) as string;
        } catch {
          continue;
        }
        if (!IN_SCOPE.has(type)) continue;

        // The event id must be identical to what RPC reports, so a hybrid
        // client can dedupe across the seam.
        const id = e.id;
        const topics = e.topic.map((t) => {
          try {
            return scValToNative(t);
          } catch {
            return null;
          }
        });

        insertEvent.run(
          id,
          contractId,
          e.ledger,
          Math.floor(new Date(e.ledgerClosedAt).getTime() / 1000),
          e.txHash,
          // RPC does not expose tx application order and event index as
          // separate fields. The event id's ordinal is monotonic in emission
          // order within a ledger, so (ledger_seq, ordinal) is exactly the
          // canonical sort key. Recorded in tx_application_order with
          // event_index left at 0 rather than duplicating it into both, so the
          // stored data does not imply a distinction we cannot observe.
          ordinalFromEventId(id),
          0,
          type,
          Buffer.concat(e.topic.map((t) => t.toXDR())).toString("base64"),
          e.value.toXDR("base64"),
        );

        for (const account of attributionOf(type, topics)) {
          insertAttribution.run(id, account);
        }
        ingested++;
      }
    });
    write();

    if (!page.cursor || page.events.length < 200) break;
    cursor = page.cursor;
  }

  recordRange(db, contractId, fromLedger, toLedger);
  return { ingested, fromLedger, toLedger };
}

/**
 * Soroban event ids look like "0000000123456789-0000000001": the ledger
 * sequence and an ordinal within it. The ordinal already reflects application
 * order, so it is the stable ordering key rather than something we invent.
 */
export function ordinalFromEventId(id: string): number {
  const parts = id.split("-");
  return parts.length === 2 ? Number(parts[1]) : 0;
}
