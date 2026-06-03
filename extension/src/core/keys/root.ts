// The signer root. SDK.md 5.2.
//
// For an address controlled by an ed25519 key, the root is a SEP-0053 signature
// over a message naming the protocol, the deployment and the account:
//
//   msg  = SK_LABEL || 0x0a || enc(contract) || 0x0a || enc(account)     151 bytes
//   root = Ed25519-Sign(sk_ed, SHA-256("Stellar Signed Message:\n" || msg))
//
// Binding both addresses into the MESSAGE, rather than relying on the HKDF info
// alone, bounds a harvested signature: a dapp that tricks a user into signing
// once gets the root for that account on that deployment, not for every account
// the key controls everywhere.
//
// The SEP-0053 envelope is mandatory even when we hold the raw secret. A client
// MUST compute this signature rather than use the secret's 32 bytes directly,
// so one form covers both custody shapes.
import { Keypair, hash } from "@stellar/stellar-sdk/base";
import { SK_LABEL } from "./sk";

/** SEP-0053's prefix. 24 bytes, ending in a real LF (0x0a), not a literal backslash-n. */
export const SEP53_PREFIX = "Stellar Signed Message:\n";

/** Build the 151-byte message. Separators are LF; both addresses are 56-char strkeys. */
export function buildRootMessage(contractId: string, accountId: string): Uint8Array {
  if (contractId.length !== 56) throw new Error("contract id must be a 56-character strkey");
  if (accountId.length !== 56) throw new Error("account id must be a 56-character strkey");
  const msg = `${SK_LABEL}\n${contractId}\n${accountId}`;
  const bytes = new TextEncoder().encode(msg);
  if (bytes.length !== 151) {
    throw new Error(`root message must be 151 bytes, got ${bytes.length}`);
  }
  return bytes;
}

/** SEP-0053 digest: SHA-256 over prefix || message. Signing raw bytes is a different key. */
export function sep53Digest(message: Uint8Array): Uint8Array {
  const prefix = new TextEncoder().encode(SEP53_PREFIX);
  if (prefix.length !== 24) throw new Error("SEP-0053 prefix must be 24 bytes");
  const buf = new Uint8Array(prefix.length + message.length);
  buf.set(prefix, 0);
  buf.set(message, prefix.length);
  return new Uint8Array(hash(Buffer.from(buf)));
}

/**
 * Produce a signer root locally. Pocket holds the seed, so no user prompt.
 *
 * Callers holding a signature from an EXTERNAL signer must instead verify it
 * with `verifyRoot` before use: a wallet with a different account selected
 * returns a well-formed signature over the same message, yielding a wrong but
 * entirely usable sk. Registration then succeeds and the account is
 * unreproducible from the key the user believes controls it.
 */
export function signerRoot(keypair: Keypair, contractId: string, accountId: string): Uint8Array {
  const digest = sep53Digest(buildRootMessage(contractId, accountId));
  const sig = new Uint8Array(keypair.sign(Buffer.from(digest)));
  if (sig.length !== 64) throw new Error("expected a 64-byte ed25519 signature");
  return sig;
}

/** Verify a root against the public key we expect to have signed it. */
export function verifyRoot(
  root: Uint8Array,
  publicKey: string,
  contractId: string,
  accountId: string,
): boolean {
  const digest = sep53Digest(buildRootMessage(contractId, accountId));
  return Keypair.fromPublicKey(publicKey).verify(Buffer.from(digest), Buffer.from(root));
}
