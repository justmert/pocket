import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  G,
  H,
  IDENTITY,
  commit,
  scalarMul,
  add,
  negate,
  equals,
  isOnCurve,
  encodePoint,
  decodePoint,
  ecdh,
} from "./grumpkin";
import { poseidonWithDomain } from "./poseidon";
import { DOMAIN } from "./domain";
import { R, Q, addModQ } from "./field";

const dir = join(import.meta.dirname, "testdata");
const fixture = (n: string) => JSON.parse(readFileSync(join(dir, `${n}.json`), "utf8"));
const hx = (s: string) => BigInt(s);
const h64 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");
const named = (n: string) =>
  n === "H"
    ? H
    : n === "G"
      ? G
      : (() => {
          throw new Error(n);
        })();

describe("commit, against the committed fixture", () => {
  for (const v of fixture("commit").vectors) {
    it("computes v*G + r*H", () => {
      const c = commit(hx(v.inputs.value), hx(v.inputs.randomness));
      expect(h64(c.x)).toBe(v.output.x);
      expect(h64(c.y)).toBe(v.output.y);
    });
  }
});

describe("scalar_mul, against the committed fixture", () => {
  for (const v of fixture("scalar_mul").vectors) {
    it("computes s*P", () => {
      const p = scalarMul(hx(v.inputs.scalar), named(v.inputs.point));
      expect(h64(p.x)).toBe(v.output.x);
      expect(h64(p.y)).toBe(v.output.y);
    });
  }
});

describe("ecdh, against the committed fixture", () => {
  for (const v of fixture("ecdh").vectors) {
    it("binds both coordinates through the Poseidon funnel", () => {
      const s = ecdh(hx(v.inputs.scalar), named(v.inputs.point));
      const out = poseidonWithDomain(DOMAIN.ECDH_SHARED_SECRET, [s.x, s.y]);
      expect(h64(out)).toBe(v.output);
    });
  }

  it("is NOT negation-invariant, which x-only extraction would be", () => {
    // A key and its negation are both valid registrations. An x-only shared
    // secret would map them to the same value for every scalar, collapsing
    // each (vk, -vk) pair onto one secret.
    const s1 = ecdh(0xfeedfacen, H);
    const s2 = ecdh(0xfeedfacen, negate(H));
    expect(s1.x).toBe(s2.x); // x alone cannot tell them apart
    expect(s1.y).not.toBe(s2.y); // binding y does
    expect(poseidonWithDomain(DOMAIN.ECDH_SHARED_SECRET, [s1.x, s1.y])).not.toBe(
      poseidonWithDomain(DOMAIN.ECDH_SHARED_SECRET, [s2.x, s2.y]),
    );
  });

  it("refuses to derive from a degenerate key", () => {
    // With sigma public, an identity shared secret makes every derived
    // ciphertext trivially decryptable.
    expect(() => ecdh(Q, H)).toThrow(/identity/);
  });
});

describe("generators", () => {
  it("are on the curve", () => {
    expect(isOnCurve(G)).toBe(true);
    expect(isOnCurve(H)).toBe(true);
  });

  it("are distinct and have no obvious relation", () => {
    expect(equals(G, H)).toBe(false);
    expect(equals(G, negate(H))).toBe(false);
  });
});

describe("point arithmetic", () => {
  it("maps a zero scalar to the identity rather than erroring", () => {
    // Deposits legitimately commit with r = 0. A library that throws here
    // would reject a valid opening.
    expect(scalarMul(0n, H)).toEqual(IDENTITY);
    expect(commit(1000n, 0n)).toEqual(scalarMul(1000n, G));
  });

  it("treats the identity as an additive unit", () => {
    expect(add(H, IDENTITY)).toEqual(H);
    expect(add(IDENTITY, IDENTITY)).toEqual(IDENTITY);
    expect(add(H, negate(H))).toEqual(IDENTITY);
  });

  it("is homomorphic, which is the whole point of the scheme", () => {
    // Com(v1,r1) + Com(v2,r2) = Com(v1+v2, (r1+r2) mod q). This is how the
    // contract credits a deposit without decrypting anything.
    const [v1, r1, v2, r2] = [500n, 12345n, 250n, 67890n];
    const sum = add(commit(v1, r1), commit(v2, r2));
    expect(sum).toEqual(commit(v1 + v2, addModQ(r1, r2)));
  });

  it("accumulates blindings mod q, NOT mod r", () => {
    // Trap #1. Two full-size blindings sum past q about half the time, and
    // reducing mod r instead gives an opening off by q - r that no longer
    // opens the on-chain point.
    const r1 = Q - 5n;
    const r2 = 10n;
    const correct = commit(100n, addModQ(r1, r2));
    const wrong = commit(100n, (r1 + r2) % R);
    expect(equals(correct, wrong)).toBe(false);
    expect(equals(add(commit(60n, r1), commit(40n, r2)), correct)).toBe(true);
  });
});

describe("wire encoding", () => {
  it("round-trips a 64-byte uncompressed affine point", () => {
    const p = commit(1000n, 42n);
    expect(encodePoint(p)).toHaveLength(64);
    expect(decodePoint(encodePoint(p))).toEqual(p);
  });

  it("encodes the identity as 64 zeros", () => {
    expect(Array.from(encodePoint(IDENTITY))).toEqual(new Array(64).fill(0));
  });

  it("rejects non-canonical coordinates at our own boundary", () => {
    // A client that produces these has already lost byte-uniqueness in the
    // local state that recovery reads from, so do not defer to the contract.
    const bad = new Uint8Array(64);
    bad.set(
      Uint8Array.from(
        R.toString(16)
          .padStart(64, "0")
          .match(/../g)!
          .map((b) => parseInt(b, 16)),
      ),
      0,
    );
    expect(() => decodePoint(bad)).toThrow(/canonical/);
  });

  it("rejects a point that is not on the curve", () => {
    const off = new Uint8Array(64);
    off[31] = 1;
    off[63] = 1; // (1, 1) is not on y^2 = x^3 - 17
    expect(() => decodePoint(off)).toThrow(/not on the Grumpkin curve/);
  });

  it("rejects a wrong-length buffer", () => {
    expect(() => decodePoint(new Uint8Array(63))).toThrow(/64 bytes/);
  });
});
