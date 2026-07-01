// The protocol's Poseidon2 sponge. This is NOT a general-purpose hash and a
// stock Poseidon2 will fail every proof: width, rate, IV placement and padding
// are fixed by DESIGN.md 2.5, and the domain tag must be the first absorbed
// element.
//
// Ported from circuits/lib/src/lib.nr `sponge` / `poseidon_with_domain`, which
// SDK.md 4 names as the source of truth wherever the docs disagree. Verified
// against the committed conformance fixtures in ./testdata.
import { permute } from "@zkpassport/poseidon2";
import { R } from "./field";

/** IV multiplier: iv = input_length * 2^64, placed in the capacity slot. */
export const POSEIDON2_IV_BASE = 1n << 64n;

const RATE = 3;

// Noir's `Field` is arithmetic mod r. bigint is not, so every absorb reduces
// explicitly. permute() happens to reduce its inputs too, but relying on that
// would make our field semantics depend on a library's internals.
const add = (a: bigint, b: bigint): bigint => (a + b) % R;

/**
 * Sponge over `inputs`. State starts [0,0,0,iv]; each rate-sized block is ADDED
 * to the first three lanes, not overwritten, then permuted. Output is state[0].
 *
 * An empty input still applies one permutation, matching the on-chain sponge
 * which always permutes before squeezing.
 */
export function sponge(inputs: readonly bigint[]): bigint {
  const m = inputs.length;
  let state: bigint[] = [0n, 0n, 0n, (BigInt(m) * POSEIDON2_IV_BASE) % R];

  const full = Math.floor(m / RATE);
  for (let i = 0; i < full; i++) {
    state[0] = add(state[0] as bigint, inputs[i * RATE] as bigint);
    state[1] = add(state[1] as bigint, inputs[i * RATE + 1] as bigint);
    state[2] = add(state[2] as bigint, inputs[i * RATE + 2] as bigint);
    state = permute(state);
  }

  const remainder = m - full * RATE;
  if (remainder !== 0 || m === 0) {
    for (let i = 0; i < remainder; i++) {
      state[i] = add(state[i] as bigint, inputs[full * RATE + i] as bigint);
    }
    state = permute(state);
  }

  return state[0] as bigint;
}

/**
 * The single Poseidon2 entry point. Every derivation routes through here so the
 * domain tag is always absorbed first. Hashing raw, bypassing this, violates
 * the library contract.
 */
export function poseidonWithDomain(domain: bigint, inputs: readonly bigint[]): bigint {
  return sponge([domain, ...inputs]);
}

/**
 * Two-lane squeeze for the auditor channels. Lane 0 is ALWAYS an amount mask,
 * lane 1 is ALWAYS a balance / allowance / per-transfer-randomness mask.
 * Swapping them is the defect upstream audit finding N-07 fixed.
 */
export function spongeSqueeze2(domain: bigint, sX: bigint, sigma: bigint): [bigint, bigint] {
  const iv = (3n * POSEIDON2_IV_BASE) % R;
  const state = permute([domain % R, sX % R, sigma % R, iv]);
  return [state[0] as bigint, state[1] as bigint];
}

/** Guard for values crossing into the sponge. */
export function assertFr(x: bigint, what: string): bigint {
  if (x < 0n || x >= R) throw new Error(`${what} is not a canonical F_r element`);
  return x;
}
