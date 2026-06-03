import { describe, it, expect } from "vitest";
import { R, Q, addModR, addModQ, isCanonicalFr, toBytesBE, fromBytesBE, le4, maskTop2Bits } from "./field";

describe("the two moduli", () => {
  // Trap #1. These agree in their top 17 hex digits, so any test that only
  // eyeballs them will pass while the code is wrong.
  it("are the values SDK.md 4.1 pins", () => {
    expect(R.toString(16)).toBe("30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001");
    expect(Q.toString(16)).toBe("30644e72e131a029b85045b68181585d97816a916871ca8d3c208c16d87cfd47");
  });

  it("share a 17-hex-digit prefix, which is why they must never be compared by eye", () => {
    expect(R.toString(16).slice(0, 17)).toBe(Q.toString(16).slice(0, 17));
  });

  it("satisfies r < q, so every F_r element is already a valid Grumpkin scalar", () => {
    expect(R < Q).toBe(true);
  });

  it("differ by exactly q - r", () => {
    expect(Q - R).toBe(147946756881789318990833708069417712966n);
  });
});

describe("addModQ vs addModR", () => {
  // The failure this guards: two full-size blindings summed mod r instead of
  // mod q give an opening off by q - r that no longer opens the on-chain point.
  it("disagree for operands whose sum lands between r and q", () => {
    const a = R - 1n;
    const b = 2n;
    expect(addModQ(a, b)).toBe(R + 1n); // no reduction: still below q
    expect(addModR(a, b)).toBe(1n); // wrapped
    expect(addModQ(a, b)).not.toBe(addModR(a, b));
  });

  it("agree when the sum stays below r", () => {
    expect(addModQ(5n, 7n)).toBe(addModR(5n, 7n));
  });
});

describe("encoding", () => {
  it("round-trips big-endian", () => {
    const x = 0x0123456789abcdefn;
    expect(fromBytesBE(toBytesBE(x))).toBe(x);
  });

  it("rejects a non-canonical value rather than silently wrapping", () => {
    expect(() => toBytesBE(R)).toThrow();
    expect(isCanonicalFr(R)).toBe(false);
    expect(isCanonicalFr(R - 1n)).toBe(true);
  });

  it("writes the counter little-endian, which is the opposite of the field elements", () => {
    // le4(0) hides a byte-order bug; le4(1) is where it surfaces, and that only
    // happens on a rejected draw.
    expect(Array.from(le4(0))).toEqual([0, 0, 0, 0]);
    expect(Array.from(le4(1))).toEqual([1, 0, 0, 0]);
    expect(Array.from(le4(258))).toEqual([2, 1, 0, 0]);
  });
});

describe("maskTop2Bits", () => {
  it("clears exactly the top two bits", () => {
    const all = new Uint8Array(32).fill(0xff);
    expect(maskTop2Bits(all)[0]).toBe(0x3f);
    expect(fromBytesBE(maskTop2Bits(all)) < 1n << 254n).toBe(true);
  });

  it("does not mutate its input", () => {
    const src = new Uint8Array(32).fill(0xff);
    maskTop2Bits(src);
    expect(src[0]).toBe(0xff);
  });

  it("leaves a 248-bit draw distinguishable from a 254-bit one", () => {
    // The reference demo clears the whole top byte, so its scalars are 248-bit
    // and its modulus test can never fire. Ours must not do that.
    const all = new Uint8Array(32).fill(0xff);
    expect(maskTop2Bits(all)[0]).not.toBe(0x00);
  });
});
