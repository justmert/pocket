// Input validation shared by every witness builder.
//
// SDK.md 4.2: "The SDK MUST reject a non-canonical value at its own boundary
// rather than relying on the contract's check." Deferring is not merely
// impolite: a client that produces non-canonical bytes has already lost
// byte-uniqueness in the local state that recovery reads from, and the
// diagnosis lands three layers from the cause.
import { R, isCanonicalFr } from "../crypto/field";
import { isOnCurve, type Point } from "../crypto/grumpkin";

/** SEP-41's non-negative i128 range, which every circuit enforces. */
export const MAX_AMOUNT = 1n << 127n;

/** A blinding that cannot be proved against, per SDK.md 10.7. */
export class UnspendableBlindingError extends Error {
  constructor() {
    super(
      "This balance is temporarily unspendable: its blinding factor landed outside the range " +
        "a proof can encode. It is not lost. The next merge that folds in an incoming " +
        "transfer will resolve it.",
    );
    this.name = "UnspendableBlindingError";
  }
}

export function assertFr(v: bigint, what: string): void {
  if (!isCanonicalFr(v)) {
    throw new Error(`${what} is not a canonical F_r element`);
  }
}

export function assertAmount(v: bigint, what: string): void {
  if (v < 0n || v >= MAX_AMOUNT) {
    throw new Error(`${what} is outside the permitted range [0, 2^127)`);
  }
}

export function assertPoint(p: Point, what: string): void {
  if (p.x === 0n && p.y === 0n) throw new Error(`${what} is the identity point`);
  if (!isOnCurve(p)) throw new Error(`${what} is not a valid Grumpkin point`);
}

/**
 * A blinding accumulates mod q, and q > r. One in [r, q) still produces the
 * correct on-chain commitment through our own `commit` (which reduces mod q),
 * so the consistency check passes and everything looks healthy. But the circuit
 * treats it as a Noir Field, i.e. mod r, giving a different point, so the
 * commitment constraint cannot be satisfied and proving fails opaquely.
 *
 * Probability is about 2^-127, so this will never fire in practice. It is a
 * conformance requirement, and the alternative is an unexplainable failure on a
 * state every other check calls healthy.
 */
export function assertSpendableBlinding(randomness: bigint): void {
  if (randomness >= R) throw new UnspendableBlindingError();
}
