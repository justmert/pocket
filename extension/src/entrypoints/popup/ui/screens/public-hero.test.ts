// The headline must not vanish because a price host did.
//
// `publicUsd` goes null the moment ANY held asset's price is missing, and that
// rule is right: a total that silently omits an asset is worse than no total.
// Rendering the null as a shimmer was not. Measured with the price host down:
// the balance row still read 9999.0000000 XLM and the ledger still reported
// 10000.0000000, while the hero showed `role=status "Reading the ledger"`
// indefinitely. The figure was in memory the whole time.
import { describe, it, expect } from "vitest";
import { ledgerFallback } from "./Home";

describe("the public headline when no price can be read", () => {
  it("falls back to the ledger's own figure", () => {
    expect(ledgerFallback(null, "9998.5000000")).toEqual({
      value: "9998.5000000",
      code: "XLM",
    });
  });

  it("names the unit, so the figure cannot read as dollars", () => {
    // A bare number where a dollar figure normally sits is a wrong figure, not
    // a missing one.
    expect(ledgerFallback(null, "1.0000000")?.code).toBe("XLM");
  });

  it("leaves the dollar figure alone when there is one", () => {
    expect(ledgerFallback(1655.52, "9998.5000000")).toBeNull();
    // Including zero, which is a real total and not a missing one.
    expect(ledgerFallback(0, "0.0000000")).toBeNull();
  });

  it("invents nothing when the ledger figure is missing too", () => {
    expect(ledgerFallback(null, null)).toBeNull();
  });
});
