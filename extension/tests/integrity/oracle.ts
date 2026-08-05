// The record oracle: it opens what the wallet wrote WITHOUT asking the wallet.
//
// Every claim in this slice has the same shape. The wallet renders a number and
// says the money is there. This file takes the artefact the wallet left on disk
//, a sealed blob in chrome.storage.local, opens it with nothing but the
// user's password, and checks that what falls out reproduces the accumulator
// the CONTRACT holds. If those two disagree, the number on screen is a claim
// about money that cannot be moved.
//
// So nothing here imports `extension/src`. Not the vault, not the field
// arithmetic, not the curve, not the storage key format. A shared helper would
// make a wrong wallet agree with itself, and agreement is exactly what is being
// tested. Only third-party libraries and the ledger.
//
// The one thing taken on trust is the pair of Pedersen generators, and it is
// self-validating rather than trusted: they are Barretenberg's generators for
// "DEFAULT_DOMAIN_SEPARATOR" indices 0 and 1, they are baked into the circuits'
// verification keys, and the contract's accumulator is built from points a
// proof committed to under them. Get them wrong and every comparison below
// fails loudly. There is no way for a wrong generator to produce a false pass.
import { scrypt } from "@noble/hashes/scrypt.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk/base";
import type { Page } from "@playwright/test";

export const RPC_URL = "https://soroban-testnet.stellar.org";
export const NETWORK_PASSPHRASE = "Test SDF Network ; September 2015";

/** The deployment this build's testnet config names. Copied, not imported. */
export const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
export const AUDITOR_REGISTRY = "CDE5JETGXV7TOUUDQPUTGLJB6TCUUIIWJJTLWFX4RNH36XABKCEPNTEV";

// ---------------------------------------------------------------- storage keys
//
// Spelled out rather than imported from lib/storage. A test that asks the
// wallet where it put something cannot notice the wallet putting it somewhere
// else, and "the erase missed a key because the reader used the same wrong
// format as the writer" is one of the two silent failures that file's own
// comment warns about.

export const VAULT_KEY = "pocket.vault";
export const STATE_KEY = "pocket.state";
export const ADDRESS_KEY = "pocket.address";
export const INFLIGHT_KEY = "pocket.inflight";
export const STAGED_KEY = "pocket.staged";
export const OPENINGS_PREFIX = "pocket.openings.";
export const AUDITORID_PREFIX = "pocket.auditorid.";

export function openingKeyFor(address: string, token = TOKEN): string {
  return `${OPENINGS_PREFIX}${token}.${address}`;
}

// --------------------------------------------------------------------- vault

export interface VaultHeader {
  v: number;
  kdf: { id: string; N: number; r: number; p: number; dkLen: number };
  salt: string;
  wrap: { iv: string; ct: string };
  aadAlg: string;
}

export interface Sealed {
  v: number;
  iv: string;
  ct: string;
}

const b64 = {
  decode(text: string): Uint8Array {
    return new Uint8Array(Buffer.from(text, "base64"));
  },
};

/**
 * The AAD the vault binds its header with.
 *
 * Reconstructed here from the header's own fields, in the same canonical order
 * the format documents. If the wallet ever changes the order, GCM fails the tag
 * and this throws, which is the correct outcome: a schema change that a reader
 * cannot follow must be loud.
 */
function headerAad(h: VaultHeader): Uint8Array {
  const str = (v: string) => JSON.stringify(v);
  return new TextEncoder().encode(
    `{"v":${h.v},` +
      `"kdf":{"id":${str(h.kdf.id)},"N":${h.kdf.N},"r":${h.kdf.r},` +
      `"p":${h.kdf.p},"dkLen":${h.kdf.dkLen}},` +
      `"salt":${str(h.salt)},` +
      `"wrapIv":${str(h.wrap.iv)},` +
      `"aadAlg":${str(h.aadAlg)}}`,
  );
}

/**
 * Unwrap the data-encryption key from a stored header, given only the password.
 *
 * scrypt at N=131072 costs about a quarter of a second, so callers cache it per
 * wallet rather than per assertion.
 */
export async function unwrapDek(header: VaultHeader, password: string): Promise<Uint8Array> {
  const kekRaw = scrypt(
    new TextEncoder().encode(password.normalize("NFKC")),
    b64.decode(header.salt),
    {
      N: header.kdf.N,
      r: header.kdf.r,
      p: header.kdf.p,
      dkLen: header.kdf.dkLen,
    },
  );
  const kek = await crypto.subtle.importKey(
    "raw",
    kekRaw as unknown as ArrayBuffer,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: buf(b64.decode(header.wrap.iv)),
      additionalData: buf(headerAad(header)),
    },
    kek,
    buf(b64.decode(header.wrap.ct)),
  );
  return new Uint8Array(pt);
}

/**
 * A byte view WebCrypto accepts.
 *
 * `Uint8Array<ArrayBufferLike>` is not `BufferSource`: the lib types demand a
 * view over a real ArrayBuffer, and a SharedArrayBuffer-backed one would be a
 * runtime error rather than a cast away. Everything here comes from base64 and
 * is backed by a plain ArrayBuffer.
 */
function buf(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

/** Open a payload sealed under the DEK. Throws on a wrong key or tampering. */
export async function openSealed<T>(dek: Uint8Array, sealed: Sealed): Promise<T> {
  const key = await crypto.subtle.importKey(
    "raw",
    dek as unknown as ArrayBuffer,
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: buf(b64.decode(sealed.iv)),
      additionalData: buf(new TextEncoder().encode(`pocket.payload.v${sealed.v}`)),
    },
    key,
    buf(b64.decode(sealed.ct)),
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(pt))) as T;
}

// ------------------------------------------------------- SEP-5, independently
//
// SLIP-0010 ed25519 to m/44'/148'/0'. Twenty lines, so it is written out rather
// than imported: the address the wallet displays and the address it stores are
// both the wallet's own answer, and this is the third opinion that makes
// comparing them worth anything.

function slip10(seed: Uint8Array, path: number[]): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const level of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    const i = (level | 0x80000000) >>> 0;
    data[33] = (i >>> 24) & 0xff;
    data[34] = (i >>> 16) & 0xff;
    data[35] = (i >>> 8) & 0xff;
    data[36] = i & 0xff;
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** The G-address a BIP-39 phrase controls, derived from the phrase alone. */
export async function addressFromMnemonic(mnemonic: string): Promise<string> {
  const { mnemonicToSeed } = await import("@scure/bip39");
  const seed = new Uint8Array(await mnemonicToSeed(mnemonic));
  return Keypair.fromRawEd25519Seed(Buffer.from(slip10(seed, [44, 148, 0]))).publicKey();
}

// ------------------------------------------------------ Grumpkin, from scratch
//
// y^2 = x^3 - 17 over F_r. Affine, double-and-add, extended-Euclid inverse.
// Plain enough to read in one sitting, which is the point: an oracle nobody can
// check is not an oracle.

/** BN254 scalar field, which is Grumpkin's COORDINATE field. */
const R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
/** Grumpkin's group ORDER. Blindings live here, and reducing them mod R instead
 *  yields an opening off by q-r that opens nothing. */
const Q = 0x30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47n;

export interface Point {
  x: bigint;
  y: bigint;
}

/** The identity, which is what a freshly registered account's balance is. */
export const IDENTITY: Point = { x: 0n, y: 0n };

/** Barretenberg's Pedersen generators, DEFAULT_DOMAIN_SEPARATOR indices 0, 1. */
const G: Point = {
  x: 0x083e7911d835097629f0067531fc15cafd79a89beecb39903f69572c636f4a5an,
  y: 0x1a7f5efaad7f315c25a918f30cc8d7333fccab7ad7c90f14de81bcc528f9935dn,
};
const H: Point = {
  x: 0x054aa86a73cb8a34525e5bbed6e43ba1198e860f5f3950268f71df4591bde402n,
  y: 0x209dcfbf2cfb57f9f6046f44d71ac6faf87254afc7407c04eb621a6287cac126n,
};

const mod = (a: bigint, m = R): bigint => ((a % m) + m) % m;

function inv(a: bigint): bigint {
  let [old_r, r] = [mod(a), R];
  let [old_s, s] = [1n, 0n];
  while (r !== 0n) {
    const q = old_r / r;
    [old_r, r] = [r, old_r - q * r];
    [old_s, s] = [s, old_s - q * s];
  }
  if (old_r !== 1n) throw new Error("not invertible");
  return mod(old_s);
}

const isZero = (p: Point) => p.x === 0n && p.y === 0n;

export function pointAdd(a: Point, b: Point): Point {
  if (isZero(a)) return b;
  if (isZero(b)) return a;
  if (a.x === b.x && mod(a.y + b.y) === 0n) return IDENTITY;
  const lambda =
    a.x === b.x && a.y === b.y
      ? mod(3n * a.x * a.x * inv(2n * a.y))
      : mod((b.y - a.y) * inv(b.x - a.x));
  const x = mod(lambda * lambda - a.x - b.x);
  return { x, y: mod(lambda * (a.x - x) - a.y) };
}

function scalarMul(k: bigint, p: Point): Point {
  let s = mod(k, Q);
  if (s === 0n || isZero(p)) return IDENTITY;
  let acc = IDENTITY;
  let base = p;
  while (s > 0n) {
    if (s & 1n) acc = pointAdd(acc, base);
    base = pointAdd(base, base);
    s >>= 1n;
  }
  return acc;
}

/** Pedersen commitment C = v*G + r*H. */
export function commit(value: bigint, randomness: bigint): Point {
  return pointAdd(scalarMul(value, G), scalarMul(randomness, H));
}

/**
 * The commitment an opening of (value, randomness) produces, with the ONE
 * special case the protocol has: an all-zero opening is the identity, not
 * 0*G + 0*H computed the long way. They agree, but only because scalarMul
 * short-circuits, and the contract stores the identity for a fresh account.
 */
export function commitmentOf(o: { value: bigint; randomness: bigint }): Point {
  if (o.value === 0n && o.randomness === 0n) return IDENTITY;
  return commit(o.value, o.randomness);
}

export const samePoint = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;
export const showPoint = (p: Point): string =>
  isZero(p)
    ? "IDENTITY"
    : `${p.x.toString(16).padStart(64, "0")}:${p.y.toString(16).padStart(64, "0")}`;

// ------------------------------------------------------------- the chain read

export interface ChainAccount {
  auditorId: number;
  spendableCommitment: Point;
  receivingCommitment: Point;
}

function pointFromScVal(v: xdr.ScVal): Point {
  const bytes = new Uint8Array(v.bytes());
  if (bytes.length !== 64) throw new Error(`expected a 64-byte point, got ${bytes.length}`);
  const read = (off: number) => {
    let out = 0n;
    for (let i = 0; i < 32; i++) out = (out << 8n) | BigInt(bytes[off + i] as number);
    return out;
  };
  return { x: read(0), y: read(32) };
}

/**
 * `confidential_balance(address)`, read straight off the token contract.
 *
 * Raw JSON-RPC rather than the SDK's `rpc.Server`, so nothing here shares a
 * code path with the wallet's own read. Null means the account has no private
 * pocket on this deployment.
 */
export async function chainAccount(address: string, token = TOKEN): Promise<ChainAccount | null> {
  const tx = new TransactionBuilder(new Account(address, "0"), {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      new Contract(token).call("confidential_balance", nativeToScVal(Address.fromString(address))),
    )
    .setTimeout(30)
    .build();

  const res = await fetch(RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "simulateTransaction",
      params: { transaction: tx.toXDR() },
    }),
  });
  if (!res.ok) throw new Error(`soroban rpc ${res.status} reading ${address}`);
  const body = (await res.json()) as {
    result?: { error?: unknown; results?: { xdr: string }[]; restorePreamble?: unknown };
    error?: { message?: string };
  };
  if (body.error) throw new Error(`soroban rpc error: ${JSON.stringify(body.error)}`);
  const result = body.result;
  if (!result) throw new Error("soroban rpc answered without a result");
  if (result.error) {
    const text = typeof result.error === "string" ? result.error : JSON.stringify(result.error);
    // 3501 is AccountNotRegistered: a real answer, not a failure.
    if (/#3501|AccountNotRegistered/i.test(text)) return null;
    throw new Error(`simulation failed: ${text}`);
  }
  const retval = result.results?.[0]?.xdr;
  if (!retval) throw new Error("simulation returned no value");

  const map = xdr.ScVal.fromXDR(retval, "base64").map();
  if (!map) throw new Error("confidential_balance did not return a map");
  const field = (name: string): xdr.ScVal => {
    const e = map.find((x) => x.key().sym().toString() === name);
    if (!e) throw new Error(`confidential account has no ${name}`);
    return e.val();
  };
  return {
    auditorId: field("auditor_id").u32(),
    spendableCommitment: pointFromScVal(field("spendable_commitment")),
    receivingCommitment: pointFromScVal(field("receiving_commitment")),
  };
}

// -------------------------------------------------------------- the openings

export interface StoredOpenings {
  spendable: { value: bigint; randomness: bigint };
  receiving: { value: bigint; randomness: bigint };
  syncedThrough: number;
}

interface RawOpenings {
  spendable: { value: string; randomness: string };
  receiving: { value: string; randomness: string };
  syncedThrough: number;
}

/** Decrypt the opening blob this device holds for one account. */
export async function openOpenings(dek: Uint8Array, sealed: Sealed): Promise<StoredOpenings> {
  const raw = await openSealed<RawOpenings>(dek, sealed);
  return {
    spendable: { value: BigInt(raw.spendable.value), randomness: BigInt(raw.spendable.randomness) },
    receiving: { value: BigInt(raw.receiving.value), randomness: BigInt(raw.receiving.randomness) },
    syncedThrough: raw.syncedThrough,
  };
}

export interface OpeningVerdict {
  ok: boolean;
  /** Which side disagreed, when one did. */
  which?: "spendable" | "receiving";
  detail: string;
  openings: StoredOpenings;
  chain: ChainAccount;
}

/**
 * THE assertion this whole slice exists for.
 *
 * Takes the sealed bytes on disk and the commitments the contract holds, and
 * answers whether those bytes can actually move that money. A wallet showing
 * "25.0000000 XLM" whose stored opening does not reproduce the accumulator is
 * showing a number for funds that are permanently unspendable, and nothing in
 * the UI distinguishes the two.
 */
export function openingsOpenTheChain(
  openings: StoredOpenings,
  chain: ChainAccount,
): OpeningVerdict {
  const spend = commitmentOf(openings.spendable);
  if (!samePoint(spend, chain.spendableCommitment)) {
    return {
      ok: false,
      which: "spendable",
      detail:
        `the stored spendable opening (value ${openings.spendable.value}) commits to ` +
        `${showPoint(spend)} but the contract holds ${showPoint(chain.spendableCommitment)}`,
      openings,
      chain,
    };
  }
  const recv = commitmentOf(openings.receiving);
  if (!samePoint(recv, chain.receivingCommitment)) {
    return {
      ok: false,
      which: "receiving",
      detail:
        `the stored receiving opening (value ${openings.receiving.value}) commits to ` +
        `${showPoint(recv)} but the contract holds ${showPoint(chain.receivingCommitment)}`,
      openings,
      chain,
    };
  }
  return {
    ok: true,
    detail: `spendable ${openings.spendable.value} and receiving ${openings.receiving.value} both open the contract's accumulators`,
    openings,
    chain,
  };
}

// ------------------------------------------------------------------- storage
//
// Read from an extension PAGE, never through the worker. The point is what is
// on disk, and a read routed through the worker can be answered from a heap
// that is about to be evicted.

export async function storage(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  return JSON.parse(raw) as Record<string, unknown>;
}

/** The one opening blob this device holds, and the key it is under. */
export function openingEntry(all: Record<string, unknown>): { key: string; sealed: Sealed } | null {
  const key = Object.keys(all).find((k) => k.startsWith(OPENINGS_PREFIX));
  if (!key) return null;
  return { key, sealed: all[key] as Sealed };
}

/**
 * Everything needed to check one wallet's persisted state, opened from the
 * password alone.
 */
export async function inspect(
  page: Page,
  password: string,
): Promise<{
  all: Record<string, unknown>;
  dek: Uint8Array;
  mnemonic: string;
  address: string;
  storedAddress: string | undefined;
  openings: StoredOpenings | null;
  openingKey: string | null;
}> {
  const all = await storage(page);
  const header = all[VAULT_KEY] as VaultHeader | undefined;
  if (!header) throw new Error(`no vault on disk. keys: ${Object.keys(all).join(", ") || "none"}`);
  const dek = await unwrapDek(header, password);
  const { mnemonic } = await openSealed<{ mnemonic: string }>(dek, all[STATE_KEY] as Sealed);
  const entry = openingEntry(all);
  return {
    all,
    dek,
    mnemonic,
    address: await addressFromMnemonic(mnemonic),
    storedAddress: all[ADDRESS_KEY] as string | undefined,
    openings: entry ? await openOpenings(dek, entry.sealed) : null,
    openingKey: entry?.key ?? null,
  };
}

/** Stroops to the seven-decimal string the UI renders. */
export function formatStroops(v: bigint): string {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10_000_000n;
  const frac = (abs % 10_000_000n).toString().padStart(7, "0");
  return `${neg ? "-" : ""}${whole}.${frac}`;
}
