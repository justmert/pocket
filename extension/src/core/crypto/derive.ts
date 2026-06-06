// The derivations above sk. DESIGN.md section 4, verified against the committed
// conformance fixtures.
//
// Every one routes through poseidonWithDomain so the domain tag is absorbed
// first. Hashing raw, or reaching for a general-purpose Poseidon2, violates the
// library contract and fails every proof.
import { poseidonWithDomain, spongeSqueeze2 } from "./poseidon";
import { DOMAIN } from "./domain";
import { R } from "./field";
import { H, scalarMul, ecdh, type Point } from "./grumpkin";

// Every `encrypt*` below is a Noir `Field` addition, which is arithmetic mod r.
// bigint addition is not, so each one reduces explicitly. Omitting this passes
// for small operands and diverges the moment a full-size field element is
// involved, which is exactly what the encrypt_esc_dvk fixture caught.
const addFr = (a: bigint, b: bigint): bigint => (a + b) % R;

/** vk = Poseidon2(VIEWING_KEY, sk, addr_f). Bound to one deployment. */
export function vkFromSk(sk: bigint, addrF: bigint): bigint {
  return poseidonWithDomain(DOMAIN.VIEWING_KEY, [sk, addrF]);
}

/** Y = sk*H, the spending public key published on chain. */
export function spendingPublicKey(sk: bigint): Point {
  return scalarMul(sk, H);
}

/** PVK = vk*H, the recipient's long-term ECDH key for incoming transfers. */
export function publicViewingKey(vk: bigint): Point {
  return scalarMul(vk, H);
}

/** dvk_i = Poseidon2(DELEGATION_VIEWING_KEY, vk, op_i), per delegated spender. */
export function delegationViewingKey(vk: bigint, opI: bigint): bigint {
  return poseidonWithDomain(DOMAIN.DELEGATION_VIEWING_KEY, [vk, opI]);
}

/**
 * r_e = Poseidon2(EPHEMERAL_KEY, vk, sigma_E). MUST be derived, never sampled.
 *
 * A sampled r_e forecloses sender-side disclosure permanently and
 * retroactively: without it the wallet would have to retain (r_e, v_transfer)
 * for every outbound transfer forever, or lose the ability to prove what it
 * sent. Nothing on chain distinguishes a derived ephemeral from a sampled one,
 * so this cannot be fixed after the fact.
 */
export function ephemeralScalar(vk: bigint, sigmaE: bigint): bigint {
  return poseidonWithDomain(DOMAIN.EPHEMERAL_KEY, [vk, sigmaE]);
}

/** r' = Poseidon2(SPEND_RANDOMNESS, vk, sigma), the new spendable blinding. */
export function spendRandomness(vk: bigint, sigma: bigint): bigint {
  return poseidonWithDomain(DOMAIN.SPEND_RANDOMNESS, [vk, sigma]);
}

/** r_a = Poseidon2(ALLOWANCE_RANDOMNESS, dvk, sigma_a). */
export function allowanceRandomness(dvk: bigint, sigmaA: bigint): bigint {
  return poseidonWithDomain(DOMAIN.ALLOWANCE_RANDOMNESS, [dvk, sigmaA]);
}

/** r_transfer = Poseidon2(TRANSFER_BLINDING, s, sigma), s being the ECDH scalar. */
export function transferBlinding(s: bigint, sigma: bigint): bigint {
  return poseidonWithDomain(DOMAIN.TRANSFER_BLINDING, [s, sigma]);
}

/** v_tilde = v_transfer + Poseidon2(TRANSFER_AMOUNT, s, sigma). */
export function encryptAmount(vTransfer: bigint, s: bigint, sigma: bigint): bigint {
  return addFr(vTransfer, poseidonWithDomain(DOMAIN.TRANSFER_AMOUNT, [s, sigma]));
}

/** b_tilde = v_new + Poseidon2(ENCRYPTED_BALANCE, vk, sigma). The checkpoint. */
export function encryptBalance(vNew: bigint, vk: bigint, sigma: bigint): bigint {
  return addFr(vNew, poseidonWithDomain(DOMAIN.ENCRYPTED_BALANCE, [vk, sigma]));
}

/** a_tilde = v_a + Poseidon2(ENCRYPTED_ALLOWANCE, dvk, sigma_a). */
export function encryptAllowance(vA: bigint, dvk: bigint, sigmaA: bigint): bigint {
  return addFr(vA, poseidonWithDomain(DOMAIN.ENCRYPTED_ALLOWANCE, [dvk, sigmaA]));
}

/** escrowed_dvk = dvk + Poseidon2(ESCROWED_DELEGATION_VIEWING_KEY, s, op_i). */
export function encryptEscrowedDvk(dvk: bigint, s: bigint, opI: bigint): bigint {
  return addFr(dvk, poseidonWithDomain(DOMAIN.ESCROWED_DELEGATION_VIEWING_KEY, [s, opI]));
}

/**
 * The sender-auditor balance checkpoint, whose pad is the sponge's SECOND
 * squeeze. Lane 0 is reserved for amount masks, so a balance checkpoint never
 * shares a pad with an amount ciphertext. Taking lane 0 here is the defect
 * upstream audit finding N-07 fixed.
 */
export function encryptAuditorSenderBalance(vNew: bigint, sAsX: bigint, sigma: bigint): bigint {
  return addFr(vNew, spongeSqueeze2(DOMAIN.AUDITOR_SENDER, sAsX, sigma)[1]);
}

/** Recover the ECDH scalar from a point, for the recipient side. */
export function sharedScalar(scalar: bigint, p: Point): bigint {
  const s = ecdh(scalar, p);
  return poseidonWithDomain(DOMAIN.ECDH_SHARED_SECRET, [s.x, s.y]);
}
