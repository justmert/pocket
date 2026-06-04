// The at-rest envelope for the vault.
//
// Two tiers: the password derives a KEK via scrypt, the KEK wraps a random DEK,
// and the DEK encrypts the payload. That way a password change re-wraps 32
// bytes instead of the whole payload, which matters because the payload holds
// the opening store and grows without bound.
//
// The header sits in the clear because we need it to know how to decrypt, so it
// is passed as AES-GCM additionalData on both operations. That turns a schema
// downgrade from a convention we must remember to enforce into an
// authentication-tag mismatch.

/** Bumping this is a migration. The value is inside the AAD, so it cannot be edited on disk. */
export const VAULT_SCHEMA_VERSION = 1;

/**
 * Parameters as they appear on disk. Deliberately NOT literal types: a header is
 * untrusted input and can carry any values, so the type must be able to
 * represent a tampered one.
 */
export interface KdfParams {
  id: string;
  N: number;
  r: number;
  p: number;
  dkLen: number;
}

/** OWASP's second-choice ladder, top rung. Measured at ~250 ms in V8. */
export const KDF_PARAMS: KdfParams = { id: "scrypt", N: 131072, r: 8, p: 1, dkLen: 32 };

export const SALT_BYTES = 16;
/** 12 bytes exactly: AES-GCM uses a 96-bit IV directly as the counter block. */
export const IV_BYTES = 12;

export interface VaultHeader {
  v: number;
  kdf: KdfParams;
  salt: string;
  wrap: { iv: string; ct: string };
  aadAlg: "canonical-json-v1";
}

export interface SealedPayload {
  v: number;
  iv: string;
  ct: string;
}

/**
 * A Uint8Array known to be backed by a real ArrayBuffer, which is what WebCrypto
 * wants. TypeScript widens plain `Uint8Array` to `ArrayBufferLike`, which also
 * admits SharedArrayBuffer, and WebCrypto rejects that.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** Copy into a fresh ArrayBuffer-backed view. Cheap, and avoids casting. */
export function bytes(src: Uint8Array): Bytes {
  const out = new Uint8Array(src.length);
  out.set(src);
  return out as Bytes;
}

export const b64 = {
  encode(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s);
  },
  decode(text: string): Bytes {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out as Bytes;
  },
};

/**
 * Canonical header bytes for use as AAD. Deterministic by construction: fixed
 * key order, no whitespace, no reliance on JSON.stringify's insertion order.
 * Named and versioned via `aadAlg` so it can be migrated.
 */
export function canonicalHeaderBytes(h: VaultHeader): Bytes {
  const canonical =
    `{"v":${h.v},` +
    `"kdf":{"id":"${h.kdf.id}","N":${h.kdf.N},"r":${h.kdf.r},"p":${h.kdf.p},"dkLen":${h.kdf.dkLen}},` +
    `"salt":"${h.salt}",` +
    `"wrapIv":"${h.wrap.iv}",` +
    `"aadAlg":"${h.aadAlg}"}`;
  return new TextEncoder().encode(canonical) as Bytes;
}
