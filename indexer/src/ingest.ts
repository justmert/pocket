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

/**
 * Events that matter for balance recovery, and how many address topics each
 * one carries after the event name. INDEXER.md 3.2.
 *
 * Layouts read from stellar-contracts@219c560,
 * packages/tokens/src/confidential/mod.rs:258-491:
 *
 *   register          ["register", account]
 *   deposit           ["deposit", from, to]
 *   merge             ["merge", account]
 *   withdraw          ["withdraw", from, to]
 *   transfer          ["transfer", from, to]
 *   spender_transfer  ["spender_transfer", spender, from, to]
 *   set_spender       ["set_spender", account, spender]
 *   revoke_spender    ["revoke_spender", account, spender]
 */
export const ATTRIBUTED_TOPICS: Readonly<Record<string, number>> = {
  register: 1,
  deposit: 2,
  merge: 1,
  withdraw: 2,
  transfer: 2,
  spender_transfer: 3,
  set_spender: 2,
  revoke_spender: 2,
};

export const IN_SCOPE = new Set(Object.keys(ATTRIBUTED_TOPICS));

/** An event whose topic layout is not the one this archive was written against. */
export class EventShapeError extends Error {
  override readonly name = "EventShapeError";
}

const ADDRESS = /^[GC][A-Z2-7]{55}$/;

/**
 * Which accounts an event belongs to.
 *
 * Attribution is a pure function of the TOPICS. Never the transaction source
 * account: a Transfer belongs to both parties, and the submitter may be neither
 * of them once fee abstraction is in play.
 *
 * The arity check is the point. Taking "every topic that looks like an address"
 * matches on shape and not on type, which means an upstream event that one day
 * carries a non-party address topic gets that stranger written into an account's
 * history, and an upstream event that drops one silently loses a party from
 * theirs. Both produce a wrong replayed balance and neither reports anything.
 * Only this contract can emit these events, so a mismatch is never an attacker
 * and always a library change: refuse it loudly at ingest rather than serve it
 * quietly at read.
 */
export function attributionOf(eventType: string, topics: unknown[]): string[] {
  const expected = ATTRIBUTED_TOPICS[eventType];
  if (expected === undefined) {
    throw new EventShapeError(`${eventType} is not an in-scope event type`);
  }
  const parties = topics.slice(1);
  if (parties.length !== expected) {
    throw new EventShapeError(
      `${eventType} should carry ${expected} address topic(s), got ${parties.length}`,
    );
  }
  if (!parties.every((t): t is string => typeof t === "string" && ADDRESS.test(t))) {
    throw new EventShapeError(`${eventType} carries a topic that is not an address`);
  }
  // A spender_transfer to yourself names the same account twice. One row.
  return [...new Set(parties)];
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

/**
 * Event types whose EVENT body cannot be replayed on its own.
 *
 * A recipient derives a candidate amount from the event, but the only thing
 * that proves the decryption was real is that it opens `c_transfer`, and
 * `c_transfer` travels in the invocation rather than the event. So for these
 * two types the archive stores the invocation payload as well. Without it a
 * wallet rebuilding from history must refuse every payment it ever received.
 */
const NEEDS_PAYLOAD = new Set(["transfer", "spender_transfer"]);

/**
 * The `data: Bytes` argument of the transaction that emitted an event.
 *
 * Horizon, not Soroban RPC: RPC drops transactions on the same retention clock
 * that drops the events, and the whole point of the archive is to outlive it.
 * Horizon full-history keeps envelopes indefinitely.
 *
 * Returns null rather than throwing on anything unexpected. A missing payload
 * costs the recipient the ability to replay that one transfer, which is exactly
 * where they were before; a throw would abort the ingest of a whole range and
 * leave the archive claiming less history than it has.
 */
export async function fetchInvocationPayload(
  horizonUrl: string,
  txHash: string,
): Promise<string | null> {
  try {
    const res = await fetch(`${horizonUrl}/transactions/${encodeURIComponent(txHash)}`);
    if (!res.ok) return null;
    const body = (await res.json()) as { envelope_xdr?: string };
    if (!body.envelope_xdr) return null;
    const env = xdr.TransactionEnvelope.fromXDR(body.envelope_xdr, "base64");
    const tx = env.switch().name === "envelopeTypeTxV0" ? env.v0().tx() : env.v1().tx();
    for (const op of tx.operations()) {
      if (op.body().switch().name !== "invokeHostFunction") continue;
      const fn = op.body().invokeHostFunctionOp().hostFunction();
      if (fn.switch().name !== "hostFunctionTypeInvokeContract") continue;
      const args = fn.invokeContract().args();
      // (from, to, data) for confidential_transfer;
      // (spender, from, to, data) for confidential_transfer_from. Taking the
      // LAST Bytes argument rather than a fixed index, so the two shapes and
      // any later argument are handled by the same line.
      for (let i = args.length - 1; i >= 0; i--) {
        const a = args[i]!;
        if (a.switch().name === "scvBytes") return a.bytes().toString("base64");
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function ingestRange(
  db: Database.Database,
  server: rpc.Server,
  contractId: string,
  fromLedger: number,
  toLedger: number,
  // Optional so every existing caller and test keeps working unchanged. Absent,
  // transfer payloads are simply not stored and the wallet behaves exactly as it
  // did before: it refuses to replay received transfers rather than guessing.
  horizonUrl?: string,
): Promise<IngestResult> {
  const insertEvent = db.prepare(
    `INSERT OR IGNORE INTO events
       (id, contract_id, ledger_seq, close_time, tx_hash, tx_application_order,
        event_index, event_type, topics_xdr, data_xdr, payload_xdr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

    // Continuation pages carry only a cursor, so the endLedger bound is not
    // re-sent and the RPC can return events past toLedger. Inserting them is
    // harmless (INSERT OR IGNORE, and their true ledger_seq is recorded), but
    // recordRange only claims up to toLedger, so stored data and claimed range
    // would disagree. Stop at the bound instead: that disagreement is exactly
    // what the completeness signal exists to prevent.
    if (page.events[0]!.ledger > toLedger) break;

    // Fetched BEFORE the transaction opens. better-sqlite3 transactions are
    // synchronous, so there is nowhere inside `write` to await a network call.
    //
    // One request per transfer, in parallel, and only for transfers: a page of
    // 200 deposits costs nothing extra. `fetchInvocationPayload` never throws,
    // so a Horizon that is down degrades to "no payloads stored" rather than
    // failing the range.
    const payloads = new Map<string, string | null>();
    if (horizonUrl) {
      const needing = page.events.filter((e) => {
        try {
          return NEEDS_PAYLOAD.has(scValToNative(e.topic[0] as xdr.ScVal) as string);
        } catch {
          return false;
        }
      });
      await Promise.all(
        needing.map(async (e) => {
          payloads.set(e.id, await fetchInvocationPayload(horizonUrl, e.txHash));
        }),
      );
    }

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
        // client can dedupe across the seam. It is also the only place the
        // canonical position is available, so it is parsed rather than guessed.
        const id = e.id;
        const position = eventPosition(id);
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
          // RPC does not expose these as separate fields, but its event id
          // encodes both: see `eventPosition`. The first value is the
          // OPERATION's position within the ledger (transaction application
          // order and operation index, packed as the TOID packs them) and the
          // second is the event's index within that operation. Storing the id's
          // trailing number in the first column and a literal 0 in the second
          // collapsed every operation's opening event onto one key, which the
          // keyset pagination in api.ts then read as a single row.
          position.operation,
          position.index,
          type,
          Buffer.concat(e.topic.map((t) => t.toXDR())).toString("base64"),
          e.value.toXDR("base64"),
          // NULL for everything that does not need one, and for a transfer whose
          // transaction could not be read. Null is the honest answer and the
          // wallet already knows what to do with it.
          payloads.get(id) ?? null,
        );

        // Deliberately NOT caught. An event we cannot attribute is an event
        // whose owner we would have to guess, and a guess here is a wrong
        // replayed balance. The transaction rolls back and recordRange below is
        // never reached, so the range stays unclaimed and the archive keeps
        // reporting it incomplete until an operator has looked.
        let accounts: string[];
        try {
          accounts = attributionOf(type, topics);
        } catch (cause) {
          throw new EventShapeError(
            `${cause instanceof Error ? cause.message : String(cause)} ` +
              `(event ${id} at ledger ${e.ledger})`,
          );
        }
        for (const account of accounts) insertAttribution.run(id, account);
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
 * Where an event sits inside its ledger, read from the RPC's own id.
 *
 * A Soroban event id is `<TOID>-<n>`. The TOID is Stellar's 64-bit position
 * marker: the ledger sequence in the high 32 bits, then the transaction's
 * application order and the operation's index within that transaction, packed
 * 20 and 12 bits wide. `n` counts events WITHIN one operation and RESTARTS AT
 * ZERO for every operation.
 *
 * The previous version of this returned `n` alone, described it as "an ordinal
 * within the ledger", and the caller stored it as `tx_application_order` with
 * `event_index` left at 0. Both halves of that are wrong, and the second hides
 * the first: because `n` restarts per operation, every first-event-of-an-
 * operation in a ledger was stored under the identical key. Measured on testnet
 * ledger 4021819, which carried seven distinct TOIDs (transaction orders 0, 1,
 * 2, 3 and 8, one of them at operation index 2) whose `n` all began at 0, so all
 * seven collapsed to (4021819, 0, 0).
 *
 * That is not a cosmetic ordering flaw. `accountEvents` pages with a keyset on
 * exactly this triple, so a page boundary landing on one of a collapsed group
 * excluded the whole group: the paged read returned ONE of them and stopped,
 * an unpaged read returned all of them, and every page still answered
 * `complete: true`. A wallet rebuilding its openings from the archive would be
 * handed a silently short history and told it was whole.
 *
 * Returned instead: the operation's position within the ledger (the TOID's low
 * 32 bits, which orders transactions and then operations exactly as the ledger
 * applied them) and the event's index within that operation. With `ledger_seq`
 * those are a strict total order in emission order, which is what INDEXER.md
 * 3.4 requires and what replay correctness depends on.
 */
export function eventPosition(id: string): { operation: number; index: number } {
  const [toid, n] = id.split("-");
  // A shape we do not recognise orders as zero rather than throwing, which is
  // the behaviour the previous version had for the same input.
  if (toid === undefined || n === undefined || !/^\d+$/.test(toid) || !/^\d+$/.test(n)) {
    return { operation: 0, index: 0 };
  }
  // BigInt and a mask, NOT `Number(toid) >> 12`. The low 32 bits reach
  // 0xFFFFF000 on the ledger-scoped marker the RPC emits alongside real
  // operations, and `>>` on a JS number is a SIGNED 32-bit operation, so that
  // value reads back as -1 and sorts before every genuine event in the ledger.
  return { operation: Number(BigInt(toid) & 0xffffffffn), index: Number(n) };
}
