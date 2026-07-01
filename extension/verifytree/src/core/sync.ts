// The sync engine. SDK.md section 10.2.
//
// The chain stores commitments, not openings. Only our wallet knows the (v, r)
// that makes a balance spendable, and it reconstructs that by replaying events.
//
// Three obligations, and an implementation MUST state which layer discharges
// each. Here: ordering and deduplication happen in this module, application is
// NOT idempotent, and dedup provably precedes it.
//
//   Ordering  events apply in emission order. A merge and a deposit in the same
//             ledger produce different state depending on which goes first.
//             Canonical order is (ledger, tx application order, event index).
//   Dedup     by event id. A hybrid RPC/archive source can deliver the same
//             event twice at its seam, and crediting rules accumulate, so a
//             duplicate inflates a balance.
//   Verify    re-commit and compare after every sync. Mandatory, not optional.
//
// THE WIRE FORMAT IS NOT OURS TO CHOOSE. Every name and every encoding below is
// what the deployed contract emits, checked against it rather than assumed:
//
//   Names     topic[0] is the snake_case of the event struct name, because
//             `#[contractevent]` derives it that way (soroban-sdk-macros
//             27.0.2, derive_event.rs:106, `to_snake_case()`). So `register`
//             and `spender_transfer`, never `Register` or `SpenderTransfer`.
//   Parties   the addresses are TOPICS, not body fields. A transfer publishes
//             ["transfer", from, to] and its body carries no `from` at all.
//   Values    the body is an ScMap of BytesN<32> / BytesN<64> field elements
//             and points, plus i128 amounts. Decoded (scValToNative) that is
//             Uint8Array and bigint, never a hex string.
//
// Verified against our own testnet deployment
// (CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6): a live read
// returns topic[0] values `register`, `deposit`, `merge`, `transfer`, a deposit
// body of `{amount: bigint}`, and a transfer body of eight 32- and 64-byte
// buffers with no `from`, no `to` and no `c_transfer`. sync.live.test.ts pins
// the names; indexer/src/ingest.ts stores the same ones.
//
// Nothing here defaults a missing field. A replayed balance that is quietly
// short by one unreadable event is indistinguishable from a correct one until
// the user cannot spend, so every read below either finds real data or throws.
import { credit, applyMerge, ZERO_OPENING } from "./private";
import { encryptBalance, spendRandomness } from "./crypto/derive";
import { fromBytesBE, isCanonicalFr, R } from "./crypto/field";
import type { Point } from "./crypto/grumpkin";
import type { Opening } from "./witness/types";

/**
 * The events that move a confidential accumulator, exactly as topic[0] spells
 * them. `spender_transfer`, `set_spender` and `revoke_spender` are included
 * because ignoring them silently leaves a stale spendable balance; see
 * applyEvent.
 */
export const REPLAY_EVENTS = [
  "register",
  "deposit",
  "merge",
  "withdraw",
  "transfer",
  "spender_transfer",
  "set_spender",
  "revoke_spender",
] as const;

export type ReplayEventType = (typeof REPLAY_EVENTS)[number];

export function isReplayEvent(name: string): name is ReplayEventType {
  return (REPLAY_EVENTS as readonly string[]).includes(name);
}

/** An event whose shape is not what the contract emits. Never recoverable by guessing. */
export class MalformedEventError extends Error {
  override readonly name = "MalformedEventError";
}

/**
 * A real, well-formed event whose effect on our accumulators cannot be derived
 * from event data alone.
 *
 * Raised rather than skipped. Skipping it would produce a receiving balance
 * that is short by exactly the amounts we could not read, and short is the
 * failure mode a user only discovers when a spend they believe is funded is
 * refused by the verifier.
 */
export class UnreplayableEventError extends Error {
  override readonly name = "UnreplayableEventError";
}

/** Canonical position. tx_hash conveys no ordering and must not be used for it. */
export interface EventPosition {
  ledger: number;
  txApplicationOrder: number;
  eventIndex: number;
}

export interface ConfidentialEvent extends EventPosition {
  /** (ledger, txHash, eventIndex). Same id whether served from RPC or archive. */
  id: string;
  type: ReplayEventType;
  /**
   * topic[1..], decoded, in the order the contract publishes them. These are
   * the parties, and they are the ONLY authority on who an event belongs to:
   * the transaction source may be neither of them once a spender or a fee
   * sponsor is involved.
   */
  topics: string[];
  /**
   * The event body after scValToNative: BytesN as Uint8Array, i128 as bigint.
   * Left as `unknown` on purpose, so every read has to prove the type it wants.
   */
  data: Record<string, unknown>;
}

export function comparePosition(a: EventPosition, b: EventPosition): number {
  return (
    a.ledger - b.ledger ||
    a.txApplicationOrder - b.txApplicationOrder ||
    a.eventIndex - b.eventIndex
  );
}

/** Sort into emission order and drop duplicates. Dedup precedes application. */
export function orderAndDedupe(events: ConfidentialEvent[]): ConfidentialEvent[] {
  const seen = new Set<string>();
  const out: ConfidentialEvent[] = [];
  for (const e of [...events].sort(comparePosition)) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

export interface ReplayState {
  spendable: Opening;
  receiving: Opening;
  /** Position of the last event applied. */
  cursor: EventPosition | null;
}

export const INITIAL_STATE: ReplayState = {
  spendable: ZERO_OPENING,
  receiving: ZERO_OPENING,
  cursor: null,
};

export interface ReplayKeys {
  /** Our viewing key for this deployment. */
  vk: bigint;
  /** Our own address, to tell sender-side from recipient-side events. */
  address: string;
}

/** A party to this event, by publish position. Absent means the event is not what it claims. */
function party(event: ConfidentialEvent, index: number, role: string): string {
  const value = event.topics[index];
  if (typeof value !== "string" || value === "") {
    throw new MalformedEventError(
      `${event.type} event ${event.id} has no ${role} topic at position ${index + 1}`,
    );
  }
  return value;
}

/** Fixed-width bytes from the body. Wrong width means the decoder disagrees with the contract. */
function bytesField(event: ConfidentialEvent, name: string, width: number): Uint8Array {
  const value = event.data[name];
  if (!(value instanceof Uint8Array)) {
    throw new MalformedEventError(
      `${event.type} event ${event.id} field ${name} is ${describe(value)}, expected ${width} bytes`,
    );
  }
  if (value.length !== width) {
    throw new MalformedEventError(
      `${event.type} event ${event.id} field ${name} is ${value.length} bytes, expected ${width}`,
    );
  }
  return value;
}

/**
 * A field element from the body.
 *
 * Canonicality is enforced here, not left to the contract. The host's
 * bn254_fr deserialiser silently REDUCES an out-of-range encoding, so two
 * different byte strings can denote one value; the contract rejects that at its
 * own boundary (error 3514) and so must anything reconstructing state from it.
 */
function scalarField(event: ConfidentialEvent, name: string): bigint {
  const x = fromBytesBE(bytesField(event, name, 32));
  if (!isCanonicalFr(x)) {
    throw new MalformedEventError(
      `${event.type} event ${event.id} field ${name} is not a canonical F_r element`,
    );
  }
  return x;
}

/** A public i128 amount from the body. Negative amounts are a contract invariant violation. */
function amountField(event: ConfidentialEvent, name: string): bigint {
  const value = event.data[name];
  if (typeof value !== "bigint") {
    throw new MalformedEventError(
      `${event.type} event ${event.id} field ${name} is ${describe(value)}, expected an i128`,
    );
  }
  if (value < 0n) {
    throw new MalformedEventError(
      `${event.type} event ${event.id} field ${name} is negative`,
    );
  }
  return value;
}

function describe(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  return typeof value;
}

/**
 * Apply one event.
 *
 * Checkpoint events (withdraw, sender-side transfer, set_spender,
 * revoke_spender) OVERWRITE the spendable side from the event's own
 * (b_tilde, sigma) rather than adjusting it, so a wallet that missed
 * intervening events still converges on the spendable side. The receiving side
 * has no such self-healing, which is exactly why its openings must never be
 * treated as an evictable cache.
 *
 * Every branch decides by TOPIC, never by attribution: an archive attributes a
 * transfer to both parties, so an event reaching us says nothing about which
 * side of it we are on.
 *
 * Pure and all-or-nothing: it throws before mutating, so a refused event never
 * leaves half an update behind.
 */
export function applyEvent(
  state: ReplayState,
  event: ConfidentialEvent,
  keys: ReplayKeys,
): ReplayState {
  const me = keys.address;
  const next: ReplayState = { ...state, cursor: event };

  switch (event.type) {
    case "register": {
      // topics: [account]
      if (party(event, 0, "account") !== me) return next;
      return { ...INITIAL_STATE, cursor: event };
    }

    case "deposit": {
      // topics: [from, to]. Crediting on `from` would inflate the balance of
      // anyone who has ever funded someone else's pocket, and the archive
      // attributes the event to both.
      party(event, 0, "from");
      if (party(event, 1, "to") !== me) return next;
      // No proof, no encryption: the amount is public at this boundary. A
      // deposit commits with randomness 0 and credits the RECEIVING side, which
      // is why shielding needs a merge before the funds can be sent.
      const amount = amountField(event, "amount");
      return { ...next, receiving: credit(state.receiving, { value: amount, randomness: 0n }) };
    }

    case "merge": {
      // topics: [account]
      if (party(event, 0, "account") !== me) return next;
      return { ...next, ...applyMerge(state) };
    }

    case "withdraw": {
      // topics: [from, to]. `to` receives ordinary tokens and holds no
      // confidential accumulator, so only the sender side moves.
      if (party(event, 0, "from") !== me) return next;
      return { ...next, spendable: openCheckpoint(event, keys.vk) };
    }

    case "transfer": {
      // topics: [from, to]
      const from = party(event, 0, "from");
      const to = party(event, 1, "to");
      // Refuse before applying anything, so a self-transfer cannot leave the
      // sender half applied.
      if (to === me) throw inboundUnreadable(event, "sigma");
      if (from !== me) return next;
      return { ...next, spendable: openCheckpoint(event, keys.vk) };
    }

    case "spender_transfer": {
      // topics: [spender, from, to]. confidential_transfer_from debits the
      // DELEGATION's allowance commitment, not the owner's spendable, so the
      // owner's accumulators are untouched and there is nothing to replay for
      // them. Only the recipient's receiving side moves.
      party(event, 0, "spender");
      party(event, 1, "from");
      if (party(event, 2, "to") === me) throw inboundUnreadable(event, "sigma_a");
      return next;
    }

    case "set_spender":
    case "revoke_spender": {
      // topics: [account, spender]. Both call set_spendable, so both are
      // checkpoints for the account: one escrows part of the spendable balance
      // into an allowance, the other folds what is left of it back.
      const account = party(event, 0, "account");
      party(event, 1, "spender");
      if (account !== me) return next;
      return { ...next, spendable: openCheckpoint(event, keys.vk) };
    }
  }

  // Unreachable by type, reachable at runtime: `type` comes off the wire. A
  // switch that fell through here would return undefined and let replay build a
  // balance out of an event it did not understand.
  throw new MalformedEventError(
    `event ${(event as ConfidentialEvent).id} has unknown type ${String((event as ConfidentialEvent).type)}`,
  );
}

/**
 * Why an inbound credit cannot be replayed from events in this build.
 *
 * Opening an inbound transfer needs the published commitment C_transfer: it is
 * the only proof that a decryption was real rather than a plausible field
 * element derived from somebody else's transfer. The contract passes C_transfer
 * in the invocation PAYLOAD and does NOT publish it in the event, so the event
 * stream alone is not enough. Confirmed on chain: a live transfer event body is
 * {b_tilde, b_tilde_aud_s, r_e_point, r_tilde_aud_r, sigma, v_tilde,
 * v_tilde_aud_r, v_tilde_aud_s} and no more.
 */
function inboundUnreadable(event: ConfidentialEvent, salt: string): UnreplayableEventError {
  return new UnreplayableEventError(
    `${event.type} event ${event.id} credits this account, but its commitment is not published ` +
      `in the event (it carries only r_e_point, v_tilde and ${salt}), so the amount cannot be ` +
      `confirmed as ours. Pocket will not credit an amount it cannot verify.`,
  );
}

/**
 * Recover the spendable opening from a checkpoint event.
 *
 * b_tilde = v_new + Poseidon2(delta_enc_bal, vk, sigma), and the blinding is
 * r' = Poseidon2(delta_spend_r, vk, sigma). Both come from vk and the published
 * salt, so one event lookup fully re-derives the opening.
 */
export function openCheckpoint(event: ConfidentialEvent, vk: bigint): Opening {
  const bTilde = scalarField(event, "b_tilde");
  const sigma = scalarField(event, "sigma");
  const mask = encryptBalance(0n, vk, sigma);
  return {
    value: (bTilde - mask + R) % R,
    randomness: spendRandomness(vk, sigma),
  };
}

/** Replay a batch. Orders and dedupes first, then applies in emission order. */
export function replay(
  state: ReplayState,
  events: ConfidentialEvent[],
  keys: ReplayKeys,
): ReplayState {
  return orderAndDedupe(events).reduce((s, e) => applyEvent(s, e, keys), state);
}

/** Point re-export so callers need not reach into crypto/. */
export type { Point };
