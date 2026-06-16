// The self-auditor key. Decision D8.
//
// Every confidential account binds an `auditor_id` permanently at registration,
// the field is immutable for the life of the account, and the transfer circuit
// enforces auditor ciphertexts on every operation. There is no opt-out, so
// somebody holds a decryption key for every account that exists. Pocket's
// answer is that the somebody is the user: the wallet derives a second Grumpkin
// key from the same seed and registers it, so the compliance channel is real
// and populated rather than pointed at the vendor.
//
//   aud_sk = RS( HKDF-SHA-512( IKM  = auditor root,
//                              salt = AUDITOR_LABEL,
//                              info = be32(addr_f) || be32(acct_f) || le4(j) ) )
//   K_aud  = aud_sk * H
//
// Nothing here touches Poseidon, so no domain tag is consumed: the 1..16 range
// is the on-chain wire contract and this derivation is purely client-side.
// Domain separation is carried entirely by the HKDF salt and by the signed
// message, both of which live in a `pocket/` namespace that cannot collide with
// an `openzeppelin/` one.
//
// # Upstream specifies nothing here
//
// SDK.md 11 specifies the auditor CLIENT and deliberately not auditor key
// derivation. Grepping DESIGN, DESIGN_cont, COMPLIANCE, OVERVIEW and
// SELECTIVE_DISCLOSURE finds `aud_sk` named (SELECTIVE_DISCLOSURE.md 76) and
// never derived. So this construction is ours, and the honest consequence is
// that a conforming third-party auditor client could not reproduce it if
// upstream later specifies a different one. That risk is bounded in a way the
// holder-side derivation's is not: `register` is single-use and unrepairable,
// whereas an auditor key is rotatable. AUDITOR_DERIVATION_VERSION is stamped
// alongside every key we register so a later migration can tell which
// construction produced which key rather than guessing.
//
// # Why a separate signer root, and not merely a second HKDF salt
//
// SDK.md 11 requires that "an auditor facade MUST NOT be able to construct a
// spending witness, and MUST NOT be able to open a post-merge spendable
// balance". Under self-auditing one person holds both roles, so key custody
// cannot enforce that and the derivation graph has to.
//
// The spending root is an ed25519 signature over the SK_LABEL message. This one
// is a signature over the AUDITOR_LABEL message. Neither is computable from the
// other without the ed25519 secret, so a facade handed the auditor root, or
// aud_sk alone, has no path back to sk: it would have to forge a signature over
// a different message. Had both keys hung off one root under two salts, the
// separation would have rested on the facade never being handed that root,
// which is a convention rather than a structure.
//
// The second half of the requirement follows from the first. The post-merge
// spendable blinding is r' = Poseidon2(SPEND_RANDOMNESS, vk, sigma) and vk =
// Poseidon2(VIEWING_KEY, sk, addr_f), so an opening of C_spend needs sk.
// DESIGN_cont.md 9 states the same conclusion from the other side: "r_s depends
// on vk_A and is not derivable from any auditor key."
import { R, toBytesBE, fromBytesBE, le4, maskTop2Bits } from "../crypto/field";
import { auditorPublicKey } from "../crypto/derive";
import { type Point } from "../crypto/grumpkin";
import { Keypair } from "@stellar/stellar-sdk/base";
import { hkdfSha512 } from "./sk";
import { sep53Digest } from "./root";

/**
 * Appears twice, exactly as SK_LABEL does: as the HKDF salt, and as the head of
 * the signed message.
 *
 * The `pocket/` prefix is deliberate. This is our namespace, not upstream's, and
 * it must not be mistakable for a conformant OpenZeppelin derivation. If
 * upstream later specifies one its salt will sit in the `openzeppelin/`
 * namespace and the two cannot collide.
 */
export const AUDITOR_LABEL = "pocket/confidential-auditor/v1/aud_sk";

/**
 * Stamped alongside every registered auditor key.
 *
 * Bump it if the construction below ever changes. Without a version recorded at
 * registration, a future migration cannot tell which construction produced a
 * given on-chain key and has to guess, on material that is expensive to get
 * wrong.
 */
export const AUDITOR_DERIVATION_VERSION = 1;

/** Same bound and the same reasoning as sk's: ~24% per draw, so 64 is 2^-130. */
const MAX_REJECTIONS = 64;

export interface AuditorDerivation {
  /** The auditor secret scalar, a canonical F_r element in [1, r). */
  audSk: bigint;
  /** K_aud = aud_sk*H, the 64-byte point the registry stores. */
  publicKey: Point;
  /** How many candidates were rejected before this one. Useful in tests. */
  rejections: number;
  /** Which construction produced this key. Record it with the registration. */
  version: number;
}

/**
 * Build the auditor root message. Same 151-byte shape as the spending root's,
 * differing only in the label.
 *
 * Both labels happen to be 37 characters, so both messages are 151 bytes. That
 * is a coincidence and not a collision: the bytes differ from the first one, so
 * the digests and therefore the roots differ. The length assertion below is
 * kept for the same reason the spending one is, to catch a truncated strkey.
 *
 * `operatorId` is the address that will own the registry entry and is the only
 * address permitted to rotate it. Under self-auditing that is the account
 * itself; it is named separately because the auditor role is held by an
 * operator address and conflating the two would hide that.
 */
export function buildAuditorRootMessage(contractId: string, operatorId: string): Uint8Array {
  if (contractId.length !== 56) throw new Error("contract id must be a 56-character strkey");
  if (operatorId.length !== 56) throw new Error("operator id must be a 56-character strkey");
  const bytes = new TextEncoder().encode(`${AUDITOR_LABEL}\n${contractId}\n${operatorId}`);
  if (bytes.length !== 151) {
    throw new Error(`auditor root message must be 151 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/**
 * Produce the auditor signer root locally. Pocket holds the seed, so no prompt.
 *
 * Self-verifies before returning, as `signerRoot` does. A corrupted keypair
 * would otherwise yield a usable-but-wrong auditor key, and a wrong auditor key
 * registers happily and then decrypts nothing for the life of the account.
 */
export function auditorSignerRoot(
  keypair: Keypair,
  contractId: string,
  operatorId: string,
): Uint8Array {
  const digest = sep53Digest(buildAuditorRootMessage(contractId, operatorId));
  const sig = new Uint8Array(keypair.sign(Buffer.from(digest)));
  if (sig.length !== 64) throw new Error("expected a 64-byte ed25519 signature");
  if (!keypair.verify(Buffer.from(digest), Buffer.from(sig))) {
    throw new Error("the signer produced a signature that does not verify against its own key");
  }
  return sig;
}

/** Verify an auditor root against the public key we expect to have signed it. */
export function verifyAuditorRoot(
  root: Uint8Array,
  publicKey: string,
  contractId: string,
  operatorId: string,
): boolean {
  const digest = sep53Digest(buildAuditorRootMessage(contractId, operatorId));
  return Keypair.fromPublicKey(publicKey).verify(Buffer.from(digest), Buffer.from(root));
}

/**
 * Derive the auditor secret and its public point.
 *
 * # Which modulus
 *
 * Grumpkin scalars live in F_q, so correctness alone would admit anything below
 * q. The scalar is nonetheless drawn from F_r, and that is the specified
 * procedure rather than a preference. DESIGN.md 2.2, "Scalar sampling":
 *
 *   "Grumpkin scalars live in F_q, which is slightly larger than F_r. All
 *    secret scalars in this design (sk, r_e, sigma, sigma_a) are sampled by the
 *    rejection sampling procedure, which produces a uniform draw from F_r:
 *    ... 2. Mask the top 2 bits to zero, yielding a 254-bit candidate
 *    x in [0, 2^254). 3. If x >= r, reject ..."
 *
 * What makes an F_r draw a valid Grumpkin scalar is r < q, so no reduction ever
 * occurs and no two distinct draws collide onto one scalar. That inequality is
 * the `R_LT_Q` invariant in crypto/field.ts, and auditor.test.ts asserts it
 * rather than leaving it as a comment. Nothing is lost by the narrower range:
 * q - r is about 2^127 against a field of about 2^254, so the draw forgoes
 * roughly one part in 2^127 of the scalar space.
 *
 * Staying in F_r also keeps the scalar inside the codebase's only 32-byte
 * encoding, `toBytesBE`, which is canonical against r and throws above it.
 *
 * # Binding
 *
 * `addrF` binds the deployment, `acctF` the account holding the role. Both
 * matter under self-auditing: two accounts derived from one seed that shared an
 * auditor key, or shared one auditor_id, would publish that linkage on chain,
 * and it is a linkage a third-party auditor would never create.
 */
export async function deriveAuditorKey(
  root: Uint8Array,
  addrF: bigint,
  acctF: bigint,
): Promise<AuditorDerivation> {
  // Same two admitted forms as the spending root. A truncated or empty root
  // derives a usable but WRONG key with no complaint, and a wrong auditor key
  // is only discovered when someone tries to read a ciphertext and cannot.
  if (root.length !== 64 && root.length !== 32) {
    throw new Error(
      `auditor root must be a 64-byte SEP-0053 signature or a 32-byte raw root, got ${root.length} bytes`,
    );
  }
  const salt = new TextEncoder().encode(AUDITOR_LABEL);
  const addrBytes = toBytesBE(addrF);
  const acctBytes = toBytesBE(acctF);

  for (let j = 0; j < MAX_REJECTIONS; j++) {
    const info = new Uint8Array(68);
    info.set(addrBytes, 0);
    info.set(acctBytes, 32);
    info.set(le4(j), 64);

    const okm = await hkdfSha512(root, salt, info, 32);
    const candidate = fromBytesBE(maskTop2Bits(okm));

    if (candidate >= R) continue;
    if (candidate === 0n) continue;

    // The registry refuses the identity, because with sigma public an identity
    // key makes every ciphertext under it trivially decryptable. H has prime
    // order and the candidate is in [1, r) with r < q, so this cannot fire.
    // Surfacing the registry's own condition here anyway means a client-side
    // failure rather than a contract error on a permanent binding.
    const publicKey = auditorPublicKey(candidate);
    if (publicKey.x === 0n && publicKey.y === 0n) continue;

    return {
      audSk: candidate,
      publicKey,
      rejections: j,
      version: AUDITOR_DERIVATION_VERSION,
    };
  }
  throw new Error("auditor key derivation exceeded the rejection bound");
}
