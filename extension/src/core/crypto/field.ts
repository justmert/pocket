// Field arithmetic for the confidential token protocol.
//
// Two moduli are in play and confusing them silently corrupts balances. They
// agree in their top 17 hex digits (30644e72e131a029b) and diverge only from the
// 18th, so a visual diff will not tell them apart. Hence two named types and no
// bare bigint arithmetic anywhere above this file.
//
//   r = BN254 scalar field  = Grumpkin COORDINATE field. Scalars live here:
//       sk, vk, dvk, sigma, salts, poseidon outputs, point coordinates.
//   q = BN254 base field    = Grumpkin SCALAR field = the group order.
//       Commitment BLINDINGS accumulate here, under the group law.
//
// Committed VALUES accumulate as exact integers and are reduced by neither.
// (SDK.md 4.1, 4.6; DESIGN.md 2.1, 2.2, 2.3)

/** BN254 scalar field. Noir's `Field`, the host's `Bn254Fr`. */
export const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;

/** Grumpkin group order. Blindings accumulate mod this, never mod R. */
export const Q = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

/** Every F_r element is already a valid Grumpkin scalar: r < q, so no reduction. */
export const R_LT_Q = R < Q;

/** Add two scalars in F_r. For sk/vk/sigma and anything Poseidon touches. */
export function addModR(a: bigint, b: bigint): bigint {
  return (((a + b) % R) + R) % R;
}

/**
 * Add two BLINDING factors, mod q. This is the one to reach for on merge and on
 * receiving-balance credit. Reducing mod r instead yields an opening off by
 * q - r that no longer matches the on-chain point, and for two full-size
 * blindings the integer sum crosses q about half the time.
 */
export function addModQ(a: bigint, b: bigint): bigint {
  return (((a + b) % Q) + Q) % Q;
}

/** True if `x` is a canonical F_r element. */
export function isCanonicalFr(x: bigint): boolean {
  return x >= 0n && x < R;
}

/** True if `x` is a canonical Grumpkin scalar. */
export function isCanonicalFq(x: bigint): boolean {
  return x >= 0n && x < Q;
}

/** 32-byte big-endian canonical encoding. Throws on a non-canonical input. */
export function toBytesBE(x: bigint, modulus: bigint = R): Uint8Array {
  if (x < 0n || x >= modulus) {
    throw new Error("value is not a canonical field element");
  }
  const out = new Uint8Array(32);
  let v = x;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** Read 32 big-endian bytes as a bigint. Does not range-check. */
export function fromBytesBE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (const b of bytes) v = (v << 8n) | BigInt(b);
  return v;
}

/** 4-byte little-endian, for the rejection counter inside HKDF's info. */
export function le4(n: number): Uint8Array {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error("le4 expects a uint32");
  }
  return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
}

/**
 * Clear the top 2 bits of a 32-byte big-endian buffer, giving a 254-bit
 * candidate. Mutates a copy, not the input. (DESIGN.md 2.2 step 2)
 */
export function maskTop2Bits(bytes: Uint8Array): Uint8Array {
  if (bytes.length !== 32) throw new Error("expected 32 bytes");
  const out = new Uint8Array(bytes);
  out[0] = (out[0] as number) & 0x3f;
  return out;
}
