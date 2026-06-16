// The encrypted vault. Holds the seed, the derived roots, and the confidential
// balance openings.
//
// Openings are as sensitive as keys: an opening reveals an amount. They are also
// not a cache. Per SDK.md 10.1, with RPC-only event access, discarding them
// loses the receiving-side openings permanently, so this store must never be
// treated as evictable.
import { scrypt } from "@noble/hashes/scrypt.js";
import {
  KDF_PARAMS,
  SALT_BYTES,
  IV_BYTES,
  VAULT_SCHEMA_VERSION,
  b64,
  bytes,
  MIN_KDF,
  type KdfParams,
  canonicalHeaderBytes,
  type Bytes,
  type VaultHeader,
  type SealedPayload,
} from "./envelope";

export class WrongPasswordError extends Error {
  constructor() {
    super("wrong password");
    this.name = "WrongPasswordError";
  }
}

export class CorruptVaultError extends Error {
  constructor(detail: string) {
    super(`the stored wallet is damaged: ${detail}`);
    this.name = "CorruptVaultError";
  }
}

export class SchemaVersionError extends Error {
  constructor(found: number) {
    super(
      `vault schema v${found} is newer than this build understands (v${VAULT_SCHEMA_VERSION}). ` +
        `Refusing to read it rather than risk misinterpreting stored openings.`,
    );
    this.name = "SchemaVersionError";
  }
}

const random = (n: number): Bytes => crypto.getRandomValues(new Uint8Array(n)) as Bytes;

/**
 * scrypt is memory-hard; PBKDF2 is not, and SHA-256 is the most
 * ASIC-accelerated function in existence.
 *
 * Parameters come from the vault's own header, not the module constant, so
 * raising the default for new vaults does not lock anyone out of an existing
 * one. The header is inside the AAD, so a tampered value fails the tag; the
 * floor is belt-and-braces against ever honouring weak parameters.
 */
function deriveKek(password: string, salt: Uint8Array, kdf: KdfParams): Bytes {
  if (kdf.id !== "scrypt") throw new Error(`unsupported key derivation: ${kdf.id}`);
  // Structural damage, checked before the strength policy. A non-integer N is
  // not a weak parameter, it is a broken header, and saying "weaker than we
  // accept" about it sends the reader looking for the wrong problem.
  for (const [name, value] of [
    ["N", kdf.N],
    ["r", kdf.r],
    ["p", kdf.p],
    ["dkLen", kdf.dkLen],
  ] as const) {
    if (!Number.isSafeInteger(value)) {
      throw new CorruptVaultError(`key derivation parameter ${name} is not an integer`);
    }
  }
  if (kdf.N < MIN_KDF.N || kdf.r < MIN_KDF.r || kdf.p < MIN_KDF.p || kdf.dkLen < MIN_KDF.dkLen) {
    throw new Error("vault header requests weaker key derivation than this build accepts");
  }
  // The KEK wraps the DEK under AES-256-GCM, so 32 bytes is the only length
  // that can work. Without this, a header claiming dkLen 64 reaches
  // importKey and comes back as a bare WebCrypto DataError, which is outside
  // the taxonomy dispatch knows how to phrase and reaches the user as a
  // generic network-flavoured message.
  if (kdf.dkLen !== 32) {
    throw new CorruptVaultError(`key derivation asks for ${kdf.dkLen} bytes, but AES-256 needs 32`);
  }
  return bytes(
    scrypt(new TextEncoder().encode(password.normalize("NFKC")), salt, {
      N: kdf.N,
      r: kdf.r,
      p: kdf.p,
      dkLen: kdf.dkLen,
    }),
  );
}

async function aesKey(raw: Bytes, usages: KeyUsage[]): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, usages);
}

async function seal(
  key: CryptoKey,
  plaintext: Bytes,
  aad: Bytes,
): Promise<{ iv: Bytes; ct: Bytes }> {
  const iv = random(IV_BYTES);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv, additionalData: aad },
    key,
    plaintext,
  );
  return { iv, ct: new Uint8Array(ct) as Bytes };
}

async function open(key: CryptoKey, iv: Bytes, ct: Bytes, aad: Bytes): Promise<Bytes> {
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv, additionalData: aad }, key, ct);
  return new Uint8Array(pt) as Bytes;
}

/** Create a fresh vault. Returns the header to persist and the DEK to hold in memory. */
export async function createVault(password: string): Promise<{ header: VaultHeader; dek: Bytes }> {
  const salt = random(SALT_BYTES);
  const dek = random(32);
  const kek = await aesKey(deriveKek(password, salt, KDF_PARAMS), ["encrypt"]);

  const header: VaultHeader = {
    v: VAULT_SCHEMA_VERSION,
    kdf: { ...KDF_PARAMS },
    salt: b64.encode(salt),
    wrap: { iv: "", ct: "" },
    aadAlg: "canonical-json-v1",
  };
  // The wrap IV is part of the AAD, so it must be fixed before sealing.
  const iv = random(IV_BYTES);
  header.wrap.iv = b64.encode(iv);
  const aad = canonicalHeaderBytes(header);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv, additionalData: aad },
    kek,
    dek,
  );
  header.wrap.ct = b64.encode(new Uint8Array(ct) as Bytes);
  return { header, dek };
}

/**
 * Unwrap the DEK. A wrong password surfaces as a GCM tag failure and nothing
 * else, which is the only signal there is; there is no separate verifier blob
 * to check, and adding one would only give an attacker a cheaper oracle.
 */
export async function unlockVault(header: VaultHeader, password: string): Promise<Bytes> {
  // Both ends of the range, not just the newer one. `v` is inside the AAD, so a
  // version this build has never written would fail the tag anyway, but it
  // would fail it as WrongPasswordError, which is the one diagnosis that must
  // never be wrong here: it sends a user holding the correct password to the
  // erase flow.
  if (!Number.isSafeInteger(header.v) || header.v < 1) {
    throw new CorruptVaultError(`the vault header records schema version ${String(header.v)}`);
  }
  if (header.v > VAULT_SCHEMA_VERSION) throw new SchemaVersionError(header.v);
  const kek = await aesKey(deriveKek(password, b64.decode(header.salt), header.kdf), ["decrypt"]);
  // Structural problems are NOT password problems. Reporting "wrong password"
  // for a corrupted vault sends a user with the right password to a reset flow
  // that destroys their wallet, which is a social-engineering step away from
  // data loss.
  let iv: Bytes;
  let ct: Bytes;
  try {
    iv = b64.decode(header.wrap.iv);
    ct = b64.decode(header.wrap.ct);
  } catch {
    throw new CorruptVaultError("the vault header is not valid base64");
  }
  if (iv.length !== IV_BYTES) throw new CorruptVaultError("the vault header has a malformed IV");
  if (ct.length < 33) throw new CorruptVaultError("the wrapped key is truncated");

  try {
    return await open(kek, iv, ct, canonicalHeaderBytes(header));
  } catch {
    // A tag failure past the structural checks is either a wrong password or a
    // tampered header, and we deliberately do not distinguish those two:
    // telling an attacker which one failed is a free oracle.
    throw new WrongPasswordError();
  }
}

/** Encrypt a payload under the DEK. A fresh IV every write, never reused. */
export async function sealPayload(dek: Bytes, value: unknown): Promise<SealedPayload> {
  const key = await aesKey(dek, ["encrypt"]);
  const aad = new TextEncoder().encode(`pocket.payload.v${VAULT_SCHEMA_VERSION}`) as Bytes;
  const { iv, ct } = await seal(key, new TextEncoder().encode(JSON.stringify(value)) as Bytes, aad);
  return { v: VAULT_SCHEMA_VERSION, iv: b64.encode(iv), ct: b64.encode(ct) };
}

/** Decrypt a payload. Fails closed on an unrecognised schema version. */
export async function openPayload<T>(dek: Bytes, sealed: SealedPayload): Promise<T> {
  // Same reasoning as unlockVault: `v` picks the AAD, so a nonsense version
  // silently becomes a tag failure that reads as a wrong password.
  if (!Number.isSafeInteger(sealed.v) || sealed.v < 1) {
    throw new CorruptVaultError(`a stored record records schema version ${String(sealed.v)}`);
  }
  if (sealed.v > VAULT_SCHEMA_VERSION) throw new SchemaVersionError(sealed.v);
  const key = await aesKey(dek, ["decrypt"]);
  const aad = new TextEncoder().encode(`pocket.payload.v${sealed.v}`) as Bytes;
  const pt = await open(key, b64.decode(sealed.iv), b64.decode(sealed.ct), aad);
  return JSON.parse(new TextDecoder().decode(pt)) as T;
}

/** Re-wrap the DEK under a new password. Touches 32 bytes, not the payload. */
export async function changePassword(
  header: VaultHeader,
  oldPassword: string,
  newPassword: string,
): Promise<VaultHeader> {
  const dek = await unlockVault(header, oldPassword);
  const salt = random(SALT_BYTES);
  const iv = random(IV_BYTES);
  const next: VaultHeader = {
    v: VAULT_SCHEMA_VERSION,
    kdf: { ...KDF_PARAMS },
    salt: b64.encode(salt),
    wrap: { iv: b64.encode(iv), ct: "" },
    aadAlg: "canonical-json-v1",
  };
  const kek = await aesKey(deriveKek(newPassword, salt, KDF_PARAMS), ["encrypt"]);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv, additionalData: canonicalHeaderBytes(next) },
    kek,
    dek,
  );
  next.wrap.ct = b64.encode(new Uint8Array(ct) as Bytes);
  return next;
}
