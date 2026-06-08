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
import { credit, applyMerge, ZERO_OPENING } from "./private";
import { decryptIncomingTransfer } from "./witness/transfer";
import { encryptBalance, spendRandomness } from "./crypto/derive";
import { R } from "./crypto/field";
import { decodePoint, type Point } from "./crypto/grumpkin";
import type { Opening } from "./witness/types";

/** Canonical position. tx_hash conveys no ordering and must not be used for it. */
export interface EventPosition {
  ledger: number;
  txApplicationOrder: number;
  eventIndex: number;
}

export interface ConfidentialEvent extends EventPosition {
  /** (ledger, txHash, eventIndex). Same id whether served from RPC or archive. */
  id: string;
  type: "Register" | "Deposit" | "Merge" | "Withdraw" | "Transfer";
  /** The account this event is attributed to, from the TOPICS, never the tx source. */
  account: string;
  /** Type-specific fields, already decoded from XDR. */
  data: Record<string, string>;
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

/**
 * Apply one event.
 *
 * Checkpoint events (Withdraw, sender-side Transfer, SetSpender, RevokeSpender)
 * OVERWRITE the spendable side from the event's own (b_tilde, sigma) rather
 * than adjusting it, so a wallet that missed intervening events still converges
 * on the spendable side. The receiving side has no such self-healing, which is
 * exactly why its openings must never be treated as an evictable cache.
 */
export function applyEvent(
  state: ReplayState,
  event: ConfidentialEvent,
  keys: ReplayKeys,
): ReplayState {
  const next: ReplayState = { ...state, cursor: event };

  switch (event.type) {
    case "Register":
      return { ...INITIAL_STATE, cursor: event };

    case "Deposit": {
      // No proof, no encryption: the amount is public at this boundary. A
      // deposit commits with randomness 0 and credits the RECEIVING side, which
      // is why shielding needs a merge before the funds can be sent.
      const amount = BigInt(event.data.amount ?? "0");
      return { ...next, receiving: credit(state.receiving, { value: amount, randomness: 0n }) };
    }

    case "Merge": {
      const merged = applyMerge(state);
      return { ...next, ...merged };
    }

    case "Withdraw": {
      // A checkpoint. Recover the new spendable value from b_tilde, and the
      // blinding is deterministic in (vk, sigma).
      return { ...next, spendable: openCheckpoint(event, keys.vk) };
    }

    case "Transfer": {
      const isSender = event.data.from === keys.address;
      const isRecipient = event.data.to === keys.address;
      let out = next;

      // A self-transfer must be applied in BOTH roles. The two act on different
      // accumulators, so their order does not matter, but applying only one
      // loses the other's update.
      if (isSender) {
        out = { ...out, spendable: openCheckpoint(event, keys.vk) };
      }
      if (isRecipient) {
        const incoming = decryptIncomingTransfer(
          keys.vk,
          decodePoint(hexToBytes(event.data.r_e_point ?? "")),
          BigInt("0x" + (event.data.v_tilde ?? "0")),
          BigInt("0x" + (event.data.sigma ?? "0")),
          decodePoint(hexToBytes(event.data.c_transfer ?? "")),
        );
        // null means this transfer was not addressed to us. Crediting it anyway
        // would inflate the receiving accumulator by up to 2^253.
        if (incoming) out = { ...out, receiving: credit(out.receiving, incoming) };
      }
      return out;
    }
  }
}

/**
 * Recover the spendable opening from a checkpoint event.
 *
 * b_tilde = v_new + Poseidon2(delta_enc_bal, vk, sigma), and the blinding is
 * r' = Poseidon2(delta_spend_r, vk, sigma). Both come from vk and the published
 * salt, so one event lookup fully re-derives the opening.
 */
export function openCheckpoint(event: ConfidentialEvent, vk: bigint): Opening {
  const bTilde = BigInt("0x" + (event.data.b_tilde ?? "0"));
  const sigma = BigInt("0x" + (event.data.sigma ?? "0"));
  const mask = encryptBalance(0n, vk, sigma);
  return {
    value: (bTilde - mask + R) % R,
    randomness: spendRandomness(vk, sigma),
  };
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
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
