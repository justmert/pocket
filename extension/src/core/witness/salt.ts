// Salt generation.
//
// A fresh sigma MUST be sampled for every ATTEMPT, including a retry after a
// reverted or dropped transaction. This is a confidentiality requirement, not
// only an unlinkability one: the salt is the sole freshness input to every
// derived pad in an operation, the ephemeral scalar included, so reuse repeats
// the ephemeral key and every channel mask that depends on it.
//
// It must be SAMPLED, never derived. That is the opposite of r_e, and the two
// are easy to get backwards because both feed the same pads.
import { R, maskTop2Bits, fromBytesBE } from "../crypto/field";

/**
 * A uniform nonzero scalar in [1, r), by rejection sampling.
 *
 * Clears the top TWO bits, giving a 254-bit candidate, then rejects anything at
 * or above r. Clearing the whole top byte instead (as the reference demo does)
 * yields a 248-bit draw whose modulus test can never fire: not a break, but not
 * uniform over F_r either, and a divergence from the specified procedure.
 */
export function sampleSalt(): bigint {
  for (let i = 0; i < 64; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    const candidate = fromBytesBE(maskTop2Bits(bytes));
    if (candidate !== 0n && candidate < R) return candidate;
  }
  // Each attempt fails with probability under 2^-127, so this is unreachable.
  throw new Error("salt sampling exceeded its rejection bound");
}
