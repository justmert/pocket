// SEP-0005 Ed25519 derivation: the public pocket.
//
// BIP-39 mnemonic to seed, then SLIP-0010 ed25519 to m/44'/148'/N'. Every level
// is hardened, which SLIP-0010 requires for ed25519: there is no public-parent
// to public-child derivation on a twisted Edwards curve, so non-hardened
// derivation is not defined at all.
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { Keypair } from "@stellar/stellar-sdk/base";

const HARDENED = 0x80000000;
const ED25519_CURVE = new TextEncoder().encode("ed25519 seed");

interface Node {
  key: Uint8Array;
  chainCode: Uint8Array;
}

function master(seed: Uint8Array): Node {
  const I = hmac(sha512, ED25519_CURVE, seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/** One hardened CKD step. Index is hardened unconditionally. */
function derive(node: Node, index: number): Node {
  const data = new Uint8Array(37);
  data[0] = 0x00;
  data.set(node.key, 1);
  const i = (index | HARDENED) >>> 0;
  data[33] = (i >>> 24) & 0xff;
  data[34] = (i >>> 16) & 0xff;
  data[35] = (i >>> 8) & 0xff;
  data[36] = i & 0xff;
  const I = hmac(sha512, node.chainCode, data);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/** Raw 32-byte ed25519 seed for account `index` on m/44'/148'/index'. */
export function deriveRawSeed(seed: Uint8Array, index: number): Uint8Array {
  // Without this, index 0 and index 2^31 alias to the same key, and a negative
  // or fractional index wraps silently to some other account.
  if (!Number.isInteger(index) || index < 0 || index >= 0x80000000) {
    throw new Error(`account index must be an integer in [0, 2^31), got ${index}`);
  }
  let node = master(seed);
  for (const level of [44, 148, index]) node = derive(node, level);
  return node.key;
}

/** Stellar keypair for account `index`. */
export function deriveEd25519(seed: Uint8Array, index: number): Keypair {
  return Keypair.fromRawEd25519Seed(Buffer.from(deriveRawSeed(seed, index)));
}
