// Confidential spending key derivation. SDK.md 5.
//
//   sk = RS( HKDF-SHA-512( IKM  = root,
//                          salt = "openzeppelin/confidential-token/v1/sk",
//                          info = be32(addr_f) || be32(acct_f) || le4(j) ) )
//
// The derivation is normative because two clients given the same backup
// material must land on the same account: `register` is single-use, so a
// disagreement is unrepairable. We do NOT get to substitute a different KDF.
//
// Byte-order trap: the two field elements are BIG-endian while the rejection
// counter is LITTLE-endian, inside the same info buffer. le4(0) is symmetric so
// a bug only shows on a rejected first draw, which happens ~24% of the time.
import { R, toBytesBE, fromBytesBE, le4, maskTop2Bits } from "../crypto/field";
import { poseidonWithDomain } from "../crypto/poseidon";
import { DOMAIN } from "../crypto/domain";

/** Appears twice: as the HKDF salt, and as the head of the signed message. */
export const SK_LABEL = "openzeppelin/confidential-token/v1/sk";

/** Guards a runaway loop. Each rejection is ~24% likely, so 64 is astronomically safe. */
const MAX_REJECTIONS = 64;

export interface SkDerivation {
  /** The spending key, a canonical F_r scalar in [1, r). */
  sk: bigint;
  /** vk = Poseidon2(VIEWING_KEY, sk, addr_f). Bound to this deployment. */
  vk: bigint;
  /** How many candidates were rejected before this one. Useful in tests. */
  rejections: number;
}

async function hkdfSha512(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  lengthBytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-512", salt: salt as BufferSource, info: info as BufferSource },
    key,
    lengthBytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Derive `sk` and `vk` from a root.
 *
 * `root` is either the 64-byte SEP-0053 signature (an address controlled by an
 * ed25519 key) or a raw 32-byte value (a contract address, or a signer with no
 * SEP-0053 path). Its bytes are the IKM verbatim, whatever the length.
 *
 * `addrF` binds the confidential token contract, `acctF` the registering
 * address. Binding acctF is what stops one sk being reused across two addresses,
 * which would publish an identical Y and PVK under both and link them.
 */
export async function deriveSk(
  root: Uint8Array,
  addrF: bigint,
  acctF: bigint,
): Promise<SkDerivation> {
  const salt = new TextEncoder().encode(SK_LABEL);
  const addrBytes = toBytesBE(addrF);
  const acctBytes = toBytesBE(acctF);

  for (let j = 0; j < MAX_REJECTIONS; j++) {
    const info = new Uint8Array(68);
    info.set(addrBytes, 0);
    info.set(acctBytes, 32);
    info.set(le4(j), 64);

    const okm = await hkdfSha512(root, salt, info, 32);
    const candidate = fromBytesBE(maskTop2Bits(okm));

    // Three acceptance conditions, all of which bump j on failure.
    if (candidate >= R) continue;
    if (candidate === 0n) continue;
    const vk = poseidonWithDomain(DOMAIN.VIEWING_KEY, [candidate, addrF]);
    // Registration constraint R5 requires vk != 0. Probability ~2^-254, so this
    // will never fire, but omitting it is formally non-conformant and no test
    // would ever notice.
    if (vk === 0n) continue;

    return { sk: candidate, vk, rejections: j };
  }
  throw new Error("sk derivation exceeded the rejection bound");
}
