import { describe, it, expect } from "vitest";
import { formatAmount, parseAmount, STROOPS_PER_UNIT } from "./balances";

describe("amount handling", () => {
  // Money is bigint stroops end to end. Floats never touch it: 0.1 + 0.2 is a
  // classic way to lose a user's money.
  it("round-trips", () => {
    for (const s of ["0.0000000", "1.0000000", "0.0000001", "9999999.9999999"]) {
      expect(formatAmount(parseAmount(s))).toBe(s);
    }
  });

  it("parses to exact stroops", () => {
    expect(parseAmount("1")).toBe(STROOPS_PER_UNIT);
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(parseAmount("50")).toBe(500_000_000n);
  });

  it("rejects more than 7 decimals rather than rounding a user's money away", () => {
    expect(() => parseAmount("0.12345678")).toThrow(/7 decimal/);
  });

  it("rejects junk rather than coercing it to zero", () => {
    for (const bad of ["", "abc", "1.2.3", "1e5", " ", "0x10"]) {
      expect(() => parseAmount(bad)).toThrow();
    }
  });

  it("handles values beyond Number.MAX_SAFE_INTEGER exactly", () => {
    // 2^53 stroops is ~900M XLM, reachable on mainnet. A float loses precision
    // here; bigint does not.
    const big = "922337203685.4775807"; // i64 max in stroops
    expect(formatAmount(parseAmount(big))).toBe(big);
    expect(parseAmount(big)).toBe(9223372036854775807n);
  });

  it("keeps negatives exact, for deltas", () => {
    expect(formatAmount(parseAmount("-1.5"))).toBe("-1.5000000");
  });

  it("truncates for display without mutating the value", () => {
    const raw = parseAmount("1.2345678");
    expect(formatAmount(raw, 2)).toBe("1.23");
    // Display truncation must never round: showing 1.24 for 1.2345678 would be
    // a different number, and a user reading it back would be misled.
    expect(formatAmount(raw)).toBe("1.2345678");
    expect(raw).toBe(12345678n);
  });
});
