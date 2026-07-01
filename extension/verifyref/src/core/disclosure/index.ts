// Selective disclosure.
//
// An entirely OFF-CHAIN layer. The contract is untouched; proving and verifying
// both happen client-side with the chain as a read-only source of truth.
// Disclosure circuits MUST NOT be registered with the on-chain verifier set.
//
// The property that makes it safe to hand a proof to a counterparty: it is
// bound to (their key, their nonce), so it is useless to anyone else AND
// useless to the same party for a different request. A leaked or archived proof
// reveals nothing.
//
// Say "single-use, recipient-bound". NEVER say "revocable": no revocation
// mechanism exists anywhere in the specification. What we have is
// non-transferability and non-replayability, which is the right answer to
// non-revocable view keys but is a different claim.
import { DOMAIN } from "../crypto/domain";
import { poseidonWithDomain } from "../crypto/poseidon";
import { ephemeralScalar } from "../crypto/derive";
import { scalarMul, equals, H, type Point } from "../crypto/grumpkin";
import { R } from "../crypto/field";

export type DisclosureKind = "recipient" | "sender";

/**
 * The proof bundle handed to a counterparty. Never published on chain.
 *
 * `eventRef` is a REFERENCE, not the event's contents. The verifier MUST
 * resolve it from the chain and take every event-derived and account-derived
 * public input from there, never from the bundle. Skipping that voids the
 * binding entirely: a bundle carrying its own "facts" proves nothing.
 */
export interface DisclosureBundle {
  kind: DisclosureKind;
  eventRef: { ledger: number; txHash: string; eventIndex: number };
  proof: Uint8Array;
  rDisc: Point;
  vDisc: bigint;
}

/** What a counterparty publishes to receive disclosures. */
export interface DisclosureRequest {
  recipientKey: Point;
  /** One-time, for THIS request. Reuse would make a proof replayable. */
  nonce: bigint;
}

/** The three ways verification can fail. A single boolean is not conformant. */
export type VerificationOutcome =
  | { ok: true; amount: bigint }
  | { ok: false; reason: "proof"; detail: string }
  | { ok: false; reason: "state"; detail: string }
  | { ok: false; reason: "decryption"; detail: string };

/**
 * Is a past transfer disclosable by its sender?
 *
 * Determined BY TEST, never from a stored flag. Nothing on chain distinguishes
 * an ephemeral our derivation produced from one it did not, so the only
 * authoritative check is to derive the candidate and compare against what the
 * event published. A transfer predating the deterministic-ephemeral rule may
 * not reproduce, and that is "not disclosable", not "verification failed".
 */
export function isSenderDisclosable(vk: bigint, sigmaE: bigint, publishedRe: Point): boolean {
  const candidate = ephemeralScalar(vk, sigmaE);
  if (candidate === 0n) return false;
  return equals(scalarMul(candidate, H), publishedRe);
}

/**
 * Bind a disclosure to one recipient and one request.
 *
 * Both are absorbed, so the same amount disclosed to a different party, or to
 * the same party for a later request, produces a different binding and the
 * proof does not transfer.
 */
export function disclosureBinding(req: DisclosureRequest): bigint {
  return poseidonWithDomain(DOMAIN.DISCLOSURE_BIND, [
    req.recipientKey.x,
    req.recipientKey.y,
    req.nonce,
  ]);
}

/** Seal an amount to the requester: v + Poseidon2(delta_disc, S_disc.x, nu). */
export function sealDisclosedAmount(amount: bigint, sDiscX: bigint, nonce: bigint): bigint {
  return (amount + poseidonWithDomain(DOMAIN.DISCLOSURE, [sDiscX, nonce])) % R;
}

export function openDisclosedAmount(sealed: bigint, sDiscX: bigint, nonce: bigint): bigint {
  return (sealed - poseidonWithDomain(DOMAIN.DISCLOSURE, [sDiscX, nonce]) + R) % R;
}

/**
 * What a holder can and cannot prove, for the UI.
 *
 * The cherry-picking limitation is real and must not be glossed: a holder can
 * disclose three payments and withhold a fourth, and the verifier cannot detect
 * it from the proof. Completeness routes through the auditor, not the holder.
 */
export const DISCLOSURE_LIMITS = {
  singleUse: "This proof works once, for one party, and reveals one number.",
  notRevocable:
    "It cannot be revoked. What protects you is that it is useless to anyone else and " +
    "useless to the same party for a different request.",
  cherryPicking:
    "Proving a payment does not prove it was your only one. A counterparty wanting " +
    "completeness must ask your auditor, not you.",
} as const;
