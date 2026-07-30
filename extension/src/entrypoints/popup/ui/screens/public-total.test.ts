// A deposit into the vault is not a loss.
//
// The public headline is summed from the per-asset prices the rows use, and it
// counted only the account's own balances. A yield deposit MOVES money out of
// the account and into the vault contract, so the headline dropped by exactly
// the amount deposited and nothing on the screen accounted for the difference
// in money terms: the vault section reports its position in the underlying
// asset and never in dollars.
import { describe, it, expect } from "vitest";
import { publicTotalUsd } from "./Home";
import type { PublicBalance } from "../../../../core/messages";

const XLM = (amount: string): PublicBalance => ({
  id: "native",
  code: "XLM",
  amount,
  total: amount,
  authorized: true,
});
const USDC = (amount: string): PublicBalance => ({
  id: "USDC:GISSUER",
  code: "USDC",
  amount,
  authorized: true,
});

const PRICES = { XLM: 0.2, USDC: 1 };

describe("the public headline total", () => {
  it("counts what is in the vault", () => {
    // 100 XLM in the account at $0.20 is $20; 50 XLM in the vault is $10.
    const withVault = publicTotalUsd([XLM("100")], PRICES, { code: "XLM", amount: 50 });
    expect(withVault).toBeCloseTo(30, 6);
  });

  it("does not move when money goes from the account into the vault", () => {
    // The defect, as the property. Before and after a 50 XLM deposit the
    // user's money is the same money.
    const before = publicTotalUsd([XLM("150")], PRICES, null);
    const after = publicTotalUsd([XLM("100")], PRICES, { code: "XLM", amount: 50 });
    expect(after).toBeCloseTo(before!, 6);
  });

  it("still sums the account's own assets", () => {
    expect(publicTotalUsd([XLM("100"), USDC("5")], PRICES, null)).toBeCloseTo(25, 6);
  });

  it("abandons the total when the vault's asset cannot be priced", () => {
    // Same rule as the rows. A holding counted as zero is a total that is
    // quietly wrong, and there is no shape a partial total has that a complete
    // one does not.
    expect(publicTotalUsd([XLM("100")], { XLM: 0.2 }, { code: "EURC", amount: 5 })).toBeNull();
  });

  it("abandons the total when an ACCOUNT asset cannot be priced", () => {
    expect(publicTotalUsd([XLM("100"), USDC("5")], { XLM: 0.2 }, null)).toBeNull();
  });

  it("has no total at all before the balances have been read", () => {
    expect(publicTotalUsd(null, PRICES, { code: "XLM", amount: 50 })).toBeNull();
  });
});
