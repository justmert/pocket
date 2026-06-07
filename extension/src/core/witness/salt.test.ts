import { describe, it, expect } from "vitest";
import { sampleSalt } from "./salt";
import { R } from "../crypto/field";

describe("salt sampling", () => {
  it("produces canonical nonzero F_r elements", () => {
    for (let i = 0; i < 200; i++) {
      const s = sampleSalt();
      expect(s > 0n && s < R).toBe(true);
    }
  });

  it("is a 254-bit draw, not a 248-bit one", () => {
    // The reference demo clears the whole top byte, capping candidates at
    // 2^248 so its modulus test can never fire. Ours must exceed that bound
    // sometimes, or it is not sampling the same space.
    const bound = 1n << 248n;
    const seen = Array.from({ length: 400 }, () => sampleSalt());
    expect(seen.some((s) => s >= bound)).toBe(true);
    expect(seen.every((s) => s < 1n << 254n)).toBe(true);
  });

  it("never repeats", () => {
    // A repeated salt repeats the ephemeral key and every mask derived from it.
    const seen = new Set(Array.from({ length: 500 }, () => sampleSalt().toString()));
    expect(seen.size).toBe(500);
  });
});
