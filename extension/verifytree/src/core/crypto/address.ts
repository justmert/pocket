// Soroban address compressed into one F_r element.
//
//   address_to_field(a) = Poseidon2(ADDRESS, lo, hi)
//
// where the input is the 56-character ASCII strkey (SEP-23) and lo/hi read its
// LOWER and UPPER 28 bytes in LITTLE-endian order. Note the operand is the
// strkey STRING as ASCII, not the decoded 32-byte key.
//
// This is the one primitive with two independent implementations: the contract
// derives it on-chain (soroban-poseidon, storage.rs::address_to_field) and every
// client derives it again. The circuits only ever see the result as an opaque
// public input. That is why it carries a pinned conformance vector.
import { poseidonWithDomain } from "./poseidon";
import { DOMAIN } from "./domain";

const STRKEY_LEN = 56;

/** Read `bytes` as a little-endian integer. */
function fromBytesLE(bytes: Uint8Array): bigint {
  let v = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i] as number);
  return v;
}

/**
 * Compress a strkey to a field element. Accepts `G...` accounts and `C...`
 * contract ids; both version bytes are covered by the conformance vectors.
 */
export function addressToField(strkey: string): bigint {
  if (strkey.length !== STRKEY_LEN) {
    throw new Error(`strkey must be ${STRKEY_LEN} characters, got ${strkey.length}`);
  }
  const ascii = new TextEncoder().encode(strkey);
  if (ascii.length !== STRKEY_LEN) {
    throw new Error("strkey must be ASCII");
  }
  const lo = fromBytesLE(ascii.subarray(0, 28));
  const hi = fromBytesLE(ascii.subarray(28, 56));
  return poseidonWithDomain(DOMAIN.ADDRESS, [lo, hi]);
}
