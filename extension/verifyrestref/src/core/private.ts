// The holder wallet's private-pocket state and flows. SDK.md section 10.
//
// Two accumulators per account, not one:
//   spendable   what can be sent or withdrawn. Only the owner modifies it.
//   receiving   where deposits and incoming transfers land. Anyone adds to it.
//
// A spend proof references only `spendable`, so no third party can invalidate
// an in-flight proof. `merge` folds receiving into spendable: it needs auth, no
// proof, and is a single point addition, so it cannot be front-run either.
//
// The practical consequence, and it is easy to get wrong: a deposit lands in
// RECEIVING. Shielding is deposit-then-merge, two transactions. A user who
// shields 500 and immediately tries to send finds zero spendable unless the
// wallet chains the merge.
import { addModQ } from "./crypto/field";
import { commit, equals, IDENTITY, type Point } from "./crypto/grumpkin";
import type { Opening } from "./witness/types";

export type PrivatePocketState =
  | { kind: "unregistered" }
  /** Registered and healthy. */
  | {
      kind: "ready";
      spendable: Opening;
      receiving: Opening;
      auditorId: number;
      /** Ledger through which events have been applied and verified. */
      syncedThrough: number;
    }
  /**
   * Local openings do not re-commit to the on-chain commitments. MUST NOT be
   * spent from: a proof built on diverged state fails at the verifier with no
   * diagnostic, and silently resyncing would mask the indexer-integrity failure
   * the whole design relies on catching.
   */
  | { kind: "diverged"; which: "spendable" | "receiving"; syncedThrough: number }
  /**
   * The accumulated blinding landed outside what a proof can encode. Not lost,
   * and not the user's fault. Resolves at the next merge that folds in an
   * inbound transfer.
   */
  | { kind: "unspendable"; spendable: Opening; receiving: Opening };

/** An opening of the identity: what a freshly registered account holds. */
export const ZERO_OPENING: Opening = { value: 0n, randomness: 0n };

/**
 * Credit an inbound amount to the receiving side.
 *
 * Values accumulate as EXACT INTEGERS, reduced by neither modulus. Blindings
 * accumulate mod q. Getting the second one wrong produces an opening off by
 * q - r that no longer opens the on-chain point, and for two full-size
 * blindings the sum crosses q about half the time.
 */
export function credit(receiving: Opening, incoming: Opening): Opening {
  return {
    value: receiving.value + incoming.value,
    randomness: addModQ(receiving.randomness, incoming.randomness),
  };
}

/** Fold receiving into spendable and zero the receiving side, as `merge` does. */
export function applyMerge(state: { spendable: Opening; receiving: Opening }): {
  spendable: Opening;
  receiving: Opening;
} {
  return {
    spendable: credit(state.spendable, state.receiving),
    receiving: ZERO_OPENING,
  };
}

/**
 * Re-commit local openings and compare against the chain.
 *
 * SDK.md 10.6 requires this after EVERY sync and before constructing ANY proof.
 * A missed event, a duplicate, or a tampered archive then produces a detectable
 * mismatch rather than a plausible wrong balance. Integrity fails closed.
 */
export function verifyAgainstChain(
  local: { spendable: Opening; receiving: Opening },
  onChain: { spendableCommitment: Point; receivingCommitment: Point },
): { ok: true } | { ok: false; which: "spendable" | "receiving" } {
  const spend =
    local.spendable.value === 0n && local.spendable.randomness === 0n
      ? IDENTITY
      : commit(local.spendable.value, local.spendable.randomness);
  if (!equals(spend, onChain.spendableCommitment)) return { ok: false, which: "spendable" };

  const recv =
    local.receiving.value === 0n && local.receiving.randomness === 0n
      ? IDENTITY
      : commit(local.receiving.value, local.receiving.randomness);
  if (!equals(recv, onChain.receivingCommitment)) return { ok: false, which: "receiving" };

  return { ok: true };
}

/** What the UI shows. Spendable and receiving are named separately on purpose. */
export interface PocketBalances {
  /** Sendable right now. */
  spendable: bigint;
  /** Received but not yet merged. Needs one signature to become spendable. */
  receiving: bigint;
  /** True when a merge would make more funds sendable. */
  mergeAvailable: boolean;
}

export function balancesOf(state: PrivatePocketState): PocketBalances | null {
  if (state.kind !== "ready" && state.kind !== "unspendable") return null;
  return {
    spendable: state.spendable.value,
    receiving: state.receiving.value,
    mergeAvailable: state.receiving.value > 0n,
  };
}
