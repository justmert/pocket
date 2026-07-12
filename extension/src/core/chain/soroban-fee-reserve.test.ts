// "Use max" has to leave enough behind to pay for the transaction.
//
// The swap, yield and shield screens reserved `BASE_FEE`: 100 stroops, which
// pays for a classic payment. All three build SOROBAN invocations, which pay
// that plus a resource fee decided by simulation. Measured on this deployment:
// ~179,000 stroops for a swap and 350,412 for a native shield, three to four
// orders of magnitude more than was held back.
//
// So the user pressed the wallet's own "use max" button and got an amount the
// transaction could not be paid for.
import { describe, it, expect } from "vitest";
import { BASE_FEE } from "@stellar/stellar-sdk/base";
import {
  SOROBAN_FEE_RESERVE_STROOPS,
  sendableAfterFee,
  parseAmount,
  formatAmount,
} from "./balances";

/** The largest fee actually measured on this deployment, in stroops. */
const MEASURED_WORST = 350_412n;

describe("what a Soroban 'use max' holds back", () => {
  it("covers the worst fee measured on this deployment", () => {
    expect(SOROBAN_FEE_RESERVE_STROOPS).toBeGreaterThanOrEqual(MEASURED_WORST);
  });

  it("is orders of magnitude above the base fee it replaced", () => {
    // The defect, stated as a number: the old reserve was 100 stroops.
    expect(SOROBAN_FEE_RESERVE_STROOPS).toBeGreaterThan(BigInt(BASE_FEE) * 1000n);
  });

  it("is not so large that it swallows a real balance", () => {
    // A reserve is a rounding-up, not a tax. Half an XLM off a max is a
    // fraction the user still holds; five XLM would be a bug of its own.
    expect(SOROBAN_FEE_RESERVE_STROOPS).toBeLessThanOrEqual(10_000_000n);
  });

  it("leaves the worst measured fee payable out of a maxed balance", () => {
    // The property that matters, end to end: take the whole spendable balance,
    // apply the max reservation, and the difference still covers the fee.
    const spendable = "40.0000000";
    const max = sendableAfterFee(spendable, SOROBAN_FEE_RESERVE_STROOPS);
    const left = parseAmount(spendable) - parseAmount(max);
    expect(left).toBeGreaterThanOrEqual(MEASURED_WORST);
  });

  it("would NOT have left it payable under the old base-fee reservation", () => {
    // Proves the test is measuring the defect and not passing vacuously.
    const spendable = "40.0000000";
    const oldMax = sendableAfterFee(spendable, BigInt(BASE_FEE));
    const left = parseAmount(spendable) - parseAmount(oldMax);
    expect(left).toBeLessThan(MEASURED_WORST);
  });

  it("floors at zero rather than going negative on a tiny balance", () => {
    expect(
      formatAmount(parseAmount(sendableAfterFee("0.0000001", SOROBAN_FEE_RESERVE_STROOPS))),
    ).toBe("0.0000000");
  });
});
