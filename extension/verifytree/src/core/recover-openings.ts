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
  type ConfidentialEvent,
} from "./sync";
import { verifyAgainstChain } from "./private";
import type { ConfidentialAccount, Opening } from "./witness/types";

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
 * Decode one stored event into the shape the replay engine takes.
 *
 * The archive stores topics and data as base64 XDR, which is what the ledger
 * published, rather than a parsed form. That is deliberate: a parse is a
 * lossy, versioned interpretation, and an archive that stores its own reading
 * of history cannot be re-checked against the chain later.
 */
function decodeStored(e: StoredEvent): ConfidentialEvent | null {
  if (!isReplayEvent(e.event_type)) return null;
  // `topics_xdr` is the ledger's own topic ScVals CONCATENATED, which is what
  // `indexer/src/ingest.ts` writes: `Buffer.concat(e.topic.map(t => t.toXDR()))`.
  // It is NOT an ScVec, and reading it as one throws on every event in the
  // archive, because an ScVec's first four bytes are a length and a bare
  // concatenation's first four bytes are the first value's discriminant. That
  // is what this decoder did, so archive-backed recovery could not decode a
  // single event. Measured against the real stored bytes, not assumed.
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
  };
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

  const stored: StoredEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    // `events` throws IncompleteHistoryError unless ONE contiguous range
    // covers the whole request, so a gap is an error and never a short read.
    const page = await client.events(tokenId, account, { cursor, limit: 200 });
    stored.push(...page.events);
    if (!page.cursor || page.cursor === cursor) break;
    cursor = page.cursor;
  }

  const events = stored
    .map(decodeStored)
    .filter((e): e is ConfidentialEvent => e !== null);

  // An account that has ever RECEIVED a confidential transfer cannot be rebuilt
  // from events, and this is where a user finds that out. The contract passes
  // C_transfer in the invocation payload and does not publish it in the event,
  // so the event stream carries no way to confirm a decrypted amount is the one
  // that was actually committed. `replay` refuses rather than credit an
  // unverifiable amount, which is right, and the refusal has to be readable:
  // without this it reached the screen as "check your connection", sending
  // someone to retry a network problem that does not exist and will not clear.
  let state;
  try {
    state = replay(INITIAL_STATE, events, { vk, address: account });
  } catch (e) {
    if (e instanceof UnreplayableEventError) {
      throw new RecoveryUnavailableError(
        "This account has received a confidential transfer, and a received transfer cannot be " +
          "rebuilt from history: the contract does not publish the commitment that would prove " +
          "the amount is yours. Pocket will not credit an amount it cannot verify. Your funds " +
          "are safe on chain.",
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
