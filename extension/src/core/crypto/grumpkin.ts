// Grumpkin curve operations.
//
// Grumpkin is y^2 = x^3 - 17 over F_r, forming a 2-cycle with BN254: its base
// field is BN254's scalar field, and its scalar field is BN254's base field.
// That inversion is the source of trap #1, so read field.ts before touching
// anything here.
//
// Point coordinates are F_r elements. Scalars multiplying points are F_q
// elements (the group order). Since r < q, every F_r value is already a valid
// scalar with no reduction, which is why a Noir `Field` can be passed to
// multi_scalar_mul unambiguously.
import { weierstrass } from "@noble/curves/abstract/weierstrass.js";
import { Field } from "@noble/curves/abstract/modular.js";
import { R, Q } from "./field";

/** Grumpkin's BASE field is BN254's scalar field: point coordinates live here. */
const Fr = Field(R);
/** Grumpkin's SCALAR field is BN254's base field: multipliers live here. */
const Fq = Field(Q);

export type Point = { x: bigint; y: bigint };

/** The identity, encoded as (0, 0) on the wire. */
export const IDENTITY: Point = { x: 0n, y: 0n };

/**
 * Barretenberg's Pedersen generators, indices 0 and 1 of
 * "DEFAULT_DOMAIN_SEPARATOR". No known discrete-log relation between them:
 * each is the output of hash-to-curve on the domain separator plus index.
 * Values taken verbatim from circuits/lib/src/lib.nr.
 */
export const G: Point = {
  x: 0x083e7911d835097629f0067531fc15cafd79a89beecb39903f69572c636f4a5an,
  y: 0x1a7f5efaad7f315c25a918f30cc8d7333fccab7ad7c90f14de81bcc528f9935dn,
};

export const H: Point = {
  x: 0x054aa86a73cb8a34525e5bbed6e43ba1198e860f5f3950268f71df4591bde402n,
  y: 0x209dcfbf2cfb57f9f6046f44d71ac6faf87254afc7407c04eb621a6287cac126n,
};

/**
 * y^2 = x^3 - 17 over F_r. `allowInfinityPoint` is required: a freshly
 * registered account's balance commitment IS the identity, so a curve that
 * refuses to represent it cannot model a real wallet.
 */
const GrumpkinPoint = weierstrass(
  { p: R, n: Q, h: 1n, a: 0n, b: Fr.create(-17n), Gx: G.x, Gy: G.y },
  { Fp: Fr, Fn: Fq, allowInfinityPoint: true },
);

const Pt = GrumpkinPoint;

const toNoble = (p: Point) =>
  p.x === 0n && p.y === 0n ? Pt.ZERO : Pt.fromAffine({ x: p.x, y: p.y });

const fromNoble = (p: InstanceType<typeof Pt>): Point => {
  if (p.is0()) return IDENTITY;
  const a = p.toAffine();
  return { x: a.x, y: a.y };
};

/** True when `p` satisfies the curve equation, or is the identity. */
export function isOnCurve(p: Point): boolean {
  if (p.x === 0n && p.y === 0n) return true;
  if (p.x < 0n || p.x >= R || p.y < 0n || p.y >= R) return false;
  try {
    toNoble(p).assertValidity();
    return true;
  } catch {
    return false;
  }
}

/**
 * Scalar multiplication. A ZERO scalar maps to the identity rather than
 * erroring: deposits legitimately commit with r = 0, and a library that throws
 * there would reject a valid opening.
 */
export function scalarMul(scalar: bigint, p: Point): Point {
  const s = ((scalar % Q) + Q) % Q;
  if (s === 0n) return IDENTITY;
  const np = toNoble(p);
  if (np.is0()) return IDENTITY;
  return fromNoble(np.multiply(s));
}

export function add(a: Point, b: Point): Point {
  return fromNoble(toNoble(a).add(toNoble(b)));
}

export function negate(p: Point): Point {
  if (p.x === 0n && p.y === 0n) return IDENTITY;
  return fromNoble(toNoble(p).negate());
}

export function equals(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

/** Pedersen commitment C = v*G + r*H. */
export function commit(value: bigint, randomness: bigint): Point {
  return add(scalarMul(value, G), scalarMul(randomness, H));
}

/** 64-byte uncompressed affine encoding, x || y, big-endian. Identity is 64 zeros. */
export function encodePoint(p: Point): Uint8Array {
  const out = new Uint8Array(64);
  const put = (v: bigint, off: number) => {
    let x = v;
    for (let i = 31; i >= 0; i--) {
      out[off + i] = Number(x & 0xffn);
      x >>= 8n;
    }
  };
  put(p.x, 0);
  put(p.y, 32);
  return out;
}

export function decodePoint(bytes: Uint8Array): Point {
  if (bytes.length !== 64) throw new Error(`expected 64 bytes, got ${bytes.length}`);
  const read = (off: number) => {
    let v = 0n;
    for (let i = 0; i < 32; i++) v = (v << 8n) | BigInt(bytes[off + i] as number);
    return v;
  };
  const p = { x: read(0), y: read(32) };
  // Non-canonical coordinates must be rejected at our own boundary, not left to
  // the contract: a client that produces them has already lost byte-uniqueness
  // in the local state recovery reads from.
  if (p.x >= R || p.y >= R) throw new Error("point coordinates are not canonical F_r elements");
  if (!isOnCurve(p)) throw new Error("point is not on the Grumpkin curve");
  return p;
}

/**
 * ECDH shared-secret scalar. Binds BOTH coordinates: an x-only extraction is
 * negation-invariant, so a key and its negation (itself a valid registration)
 * would map to the same secret for every scalar.
 *
 * Fails on the identity rather than proceeding: with sigma public, an identity
 * shared secret makes every derived ciphertext trivially decryptable.
 */
export function ecdh(scalar: bigint, p: Point): Point {
  const s = scalarMul(scalar, p);
  if (s.x === 0n && s.y === 0n) {
    throw new Error("ECDH produced the identity; refusing to derive from a degenerate key");
  }
  return s;
}
