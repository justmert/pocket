// Rebuilding confidential balances from the event history.
//
// This is the answer to the question the README poses and could not previously
// answer: your seed recovers your KEYS, not your MONEY. The chain stores
// commitments; only the openings make them spendable, and only this device
// ever held them. Replaying the events that produced them is the one way back.
//
// Soroban RPC keeps events for 120,960 ledgers, about seven days, so
// `core/inbound.ts` covers the recent window without any extra infrastructure.
// Past that the events are gone from RPC and the durable archive is the only
// source. That is what `indexer/` is for and why the wallet REFUSES to sync
// when a configured archive is unreachable: falling back to recent-history-only
// would advance the cursor past a gap, and the openings behind that gap would
// be unrecoverable rather than merely delayed.
import { xdr, scValToNative } from "@stellar/stellar-sdk/base";
import jsXdr from "@stellar/js-xdr";
import { ArchiveClient } from "./chain/archive";
import type { StoredEvent } from "./chain/archive-types";
import {
  replay,
  INITIAL_STATE,
  isReplayEvent,
  UnreplayableEventError,
  MalformedEventError,
  type ConfidentialEvent,
} from "./sync";
import { verifyAgainstChain } from "./private";
import { decodeEnvelope } from "./witness/payload";
import { decodePoint } from "./crypto/grumpkin";
import type { ConfidentialAccount, Opening } from "./witness/types";
import type { Point } from "./crypto/grumpkin";

export class RecoveryUnavailableError extends Error {
  override readonly name = "RecoveryUnavailableError";
}

export class RecoveryMismatchError extends Error {
  override readonly name = "RecoveryMismatchError";
}

/**
 * Read a run of ScVals that were written one after another with no envelope.
 *
 * There is no length to read, so the only way to know how many there are is to
 * decode until the buffer is spent. `XdrReader` is the same reader the SDK uses
 * internally for exactly this.
 */
function readConcatenated(base64: string): xdr.ScVal[] {
  const reader = new jsXdr.XdrReader(Buffer.from(base64, "base64"));
  const out: xdr.ScVal[] = [];
  // The SDK's generated declaration says `read(io: Buffer)`. It is wrong: every
  // caller inside js-xdr passes an XdrReader, and a Buffer has no `readInt32BE`
  // cursor for it to advance. Verified at runtime against real stored topics
  // before writing this, not inferred from the types.
  while (!reader.eof) out.push(xdr.ScVal.read(reader as unknown as Buffer));
  return out;
}

/**
 * The transfer commitment out of a stored invocation payload.
 *
 * This is the number that makes a received payment replayable. The event body
 * carries `r_e_point`, `v_tilde` and `sigma`, which are enough to DERIVE a
 * candidate amount and blinding, and nothing that can check the candidate is
 * real. `c_transfer` is that check, it rides in the invocation, and the archive
 * stores the invocation for exactly these two event types.
 *
 * Returns undefined rather than throwing on anything malformed. A payload we
 * cannot read leaves the event in the state it was in before the archive stored
 * payloads at all: the replay refuses it, which is safe. Throwing here would let
 * one unreadable row fail a whole recovery.
 */
function payloadOf(e: StoredEvent): { cTransfer: Point } | undefined {
  if (!e.payload_xdr) return undefined;
  try {
    const { payload } = decodeEnvelope(Uint8Array.from(Buffer.from(e.payload_xdr, "base64")));
    const raw = payload.c_transfer;
    if (!raw) return undefined;
    return { cTransfer: decodePoint(raw) };
  } catch {
    return undefined;
  }
}

/**
 * Decode one stored event into the shape the replay engine takes.
 *
 * The archive stores topics and data as base64 XDR, which is what the ledger
 * published, rather than a parsed form. That is deliberate: a parse is a
 * lossy, versioned interpretation, and an archive that stores its own reading
 * of history cannot be re-checked against the chain later.
 */
export function decodeStored(e: StoredEvent): ConfidentialEvent | null {
  if (!isReplayEvent(e.event_type)) return null;
  // `topics_xdr` is the ledger's own topic ScVals CONCATENATED, which is what
  // `indexer/src/ingest.ts` writes: `Buffer.concat(e.topic.map(t => t.toXDR()))`.
  // It is NOT an ScVec, and reading it as one throws on every event in the
  // archive, because an ScVec's first four bytes are a length and a bare
  // concatenation's first four bytes are the first value's discriminant. That
  // is what this decoder did, so archive-backed recovery could not decode a
  // single event. Measured against the real stored bytes, not assumed.
  // The archive is outside the trust boundary and these are its bytes, so the
  // decode is guarded. Unguarded, a truncated or corrupt `topics_xdr` or
  // `data_xdr` threw the SDK's own `TypeError: XDR Read Error` straight out of
  // `recoverOpenings`, and `describeError` has no name for that, so a rebuild
  // stopped on an archive fault and told the user to check their connection.
  //
  // THROWN, never skipped. Returning null here would drop the event from the
  // replay and produce a balance short by exactly what could not be read, which
  // is the failure `UnreplayableEventError` is documented to avoid: short is the
  // shape a user only discovers when a spend they believe is funded is refused.
  // `MalformedEventError` is the class sync.ts already defines for "an event
  // whose shape is not what the contract emits", and `recoverOpenings`
  // translates it into a sentence naming the archive as the fault.
  try {
    const topicVals = readConcatenated(e.topics_xdr);
    // topic[0] is the event name; the parties follow.
    const topics = topicVals
      .slice(1)
      .map((t) => scValToNative(t) as unknown)
      .map((v) => (typeof v === "string" ? v : ""));
    return {
      id: e.id,
      type: e.event_type,
      ledger: e.ledger_seq,
      txApplicationOrder: e.tx_application_order,
      eventIndex: e.event_index,
      topics,
      data: scValToNative(xdr.ScVal.fromXDR(e.data_xdr, "base64")) as Record<string, unknown>,
      payload: payloadOf(e),
    };
  } catch (cause) {
    // The id is named for a reader of a log, not for the screen: the message is
    // replaced by an authored one before it can reach a user.
    throw new MalformedEventError(
      `event ${e.id} could not be decoded: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/**
 * Rebuild this account's openings by replaying its whole history.
 *
 * Refuses rather than guesses, in three places: no archive configured, an
 * archive that cannot serve a gap-free window, and a replayed result that does
 * not reproduce the commitments the contract holds. The last one is the
 * important one. It means a malicious or broken archive cannot hand back a
 * wrong balance and have it accepted: integrity fails CLOSED, because the
 * chain is the authority and the archive is only a witness to it.
 */
export async function recoverOpenings(
  archiveUrl: string | undefined,
  tokenId: string,
  account: string,
  vk: bigint,
  onChain: ConfidentialAccount,
): Promise<{ spendable: Opening; receiving: Opening; syncedThrough: number }> {
  if (!archiveUrl) {
    throw new RecoveryUnavailableError(
      "Rebuilding your private balances needs a durable event history, and no archive is " +
        "configured for this network. Your funds are safe on chain.",
    );
  }

  const client = new ArchiveClient(archiveUrl);
  // Throws ArchiveUnavailableError if it cannot be reached, which is the
  // refusal we want rather than a silent partial sync.
  const health = await client.health(tokenId);

  // `allEvents` throws IncompleteHistoryError unless ONE contiguous range covers
  // the whole request, so a gap is an error and never a short read, and it pages
  // under a budget so an archive that never stops handing out cursors cannot
  // spin this loop forever. That mattered here more than anywhere: this runs
  // inside the dispatcher's ACTIVITY set, so a spin would hold the idle lock
  // open indefinitely with the vault key in memory.
  const stored: StoredEvent[] = await client.allEvents(tokenId, account);

  // Inside the same guard as `replay` below: `decodeStored` now throws
  // MalformedEventError for archive bytes it cannot read, and that refusal has
  // to be translated exactly like a replay refusal rather than escaping raw.
  let events: ConfidentialEvent[];
  let state;
  try {
    events = stored.map(decodeStored).filter((e): e is ConfidentialEvent => e !== null);

  // A received transfer replays only when the archive kept the INVOCATION
  // payload alongside the event: the event carries enough to derive a candidate
  // amount and nothing to check it against, and the check is `commit(v, r) ==
  // C_transfer`, which the contract passes in the invocation without publishing
  // it in the event.
  //
  // So this is reached by an archive that predates payload storage, or one whose
  // Horizon lookup failed for that transaction. `replay` refuses rather than
  // credit an unverifiable amount, which is right, and the refusal has to be
  // readable: without this it reached the screen as "check your connection",
  // sending someone to retry a network problem that does not exist.
    state = replay(INITIAL_STATE, events, { vk, address: account });
  } catch (e) {
    if (e instanceof UnreplayableEventError) {
      throw new RecoveryUnavailableError(
        "The archive is missing the transaction details for a payment this account received, " +
          "so Pocket cannot confirm the amount is yours and will not credit one it cannot " +
          "verify. Your funds are safe on chain. An archive that has re-indexed this contract " +
          "since it started keeping transaction details can rebuild this account.",
      );
    }
    // Its sibling, four lines away in sync.ts, and it escaped this translation
    // while the argument above applies to it word for word: the rebuild stopped,
    // and the reason reached the screen as "Something went wrong. Try again, and
    // check your connection." for a fault no retry can affect.
    //
    // Translated rather than allowlisted, and the difference matters. A
    // `MalformedEventError` message names the event id, the field and a byte
    // length, all read from the archive's own response, and `describeError` is
    // an allowlist precisely so an outside string cannot reach the screen
    // verbatim. So the class stays off that list and this replaces it with a
    // sentence the wallet wrote, which is the same shape the line above takes.
    if (e instanceof MalformedEventError) {
      throw new RecoveryUnavailableError(
        "The archive returned an event Pocket could not read, so it stopped rather than " +
          "rebuild a balance from history it does not understand. Your funds are safe on " +
          "chain. This is a fault in the archive, not in this wallet, and retrying will not " +
          "change it until that archive re-indexes the contract.",
      );
    }
    throw e;
  }
  const rebuilt = {
    spendable: state.spendable,
    receiving: state.receiving,
    // The archive reports how far it has ingested. Null means it holds nothing
    // for this contract, which the health check above should already have
    // refused, so treat it as zero rather than trusting a partial replay.
    syncedThrough: health.ingested_through ?? 0,
  };

  // The whole recovery rests on this. A replay that does not reproduce what
  // the contract holds is wrong, and storing it would leave a balance that
  // looks right and cannot be spent.
  const check = verifyAgainstChain(rebuilt, onChain);
  if (!check.ok) {
    throw new RecoveryMismatchError(
      `The rebuilt ${check.which} balance does not match what the contract holds, so Pocket ` +
        `will not use it. Your funds are safe on chain. This means the history it was given ` +
        `is incomplete or wrong.`,
    );
  }
  return rebuilt;
}
