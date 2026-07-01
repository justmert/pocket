// Witness assembly. SDK.md section 7.
//
// Ordering is not negotiable: a permutation of two same-typed inputs produces a
// well-formed vector that VERIFIES A DIFFERENT STATEMENT. DESIGN.md is
// authoritative for which inputs a circuit takes, the contract's assembly for
// their order, and the circuit's `main` signature for how many field slots each
// occupies. All three are pinned by tests.
//
// Values the CONTRACT supplies are mirrored exactly and never substituted:
// C_spend / C_a / sigma_a (chain state), Y / PVK / Y_op (account records),
// addr_f (instance storage), acct_f / op_i (recomputed on chain), K_aud_*
// (cross-contract lookup), and the public amount.
import type { Point } from "../crypto/grumpkin";

/** One account's confidential state, as the contract holds it. */
export interface ConfidentialAccount {
  spendingPublicKey: Point;
  viewingPublicKey: Point;
  spendableCommitment: Point;
  receivingCommitment: Point;
  auditorId: number;
}

/** The opening of a commitment: the pair that makes it spendable. */
export interface Opening {
  /** Amount, an exact integer. Reduced by neither modulus. */
  value: bigint;
  /** Blinding factor. Accumulates mod q, NEVER mod r. */
  randomness: bigint;
}

/** Keys the holder derives once per deployment. */
export interface HolderKeys {
  sk: bigint;
  vk: bigint;
  /** Y = sk*H */
  spendingPublicKey: Point;
  /** PVK = vk*H */
  viewingPublicKey: Point;
}

/** A built witness: private inputs plus the public vector, in contract order. */
export interface Witness {
  circuit: string;
  /** Ordered exactly as the contract assembles them. */
  publicInputs: bigint[];
  /** Everything the circuit takes that is not public. */
  privateInputs: Record<string, bigint>;
  /** Values the caller must publish alongside the proof. */
  payload: Record<string, bigint | Point>;
}

/** Flatten a point into its two field slots, in x, y order. */
export function pointSlots(p: Point): [bigint, bigint] {
  return [p.x, p.y];
}
