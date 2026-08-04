// A detail sheet shows what the wallet knows NOW, not what it knew on the tap.
//
// Both detail sheets held the object their row was rendered from. `refresh`
// writes the loaded list and nothing reconciled the two, so a balance that
// changed under an open sheet, or a payment that landed, changed nothing on
// screen: the sheet could disagree with the row it was opened from, and
// `PrivateAssetSheet`'s own header claims the opposite in words.
import { describe, it, expect } from "vitest";
import { liveDetail, livePublicDetail } from "./selectAsset";
import type { PrivatePocket, PublicBalance } from "../../../core/messages";

// The provider's own function, not a copy of it: a test that reimplements the
// logic it is checking passes just as happily while the shipped code is wrong.
const livePublic = livePublicDetail;

const xlm = (amount: string): PublicBalance => ({
  id: "native",
  code: "XLM",
  amount,
  authorized: true,
});
const usdc: PublicBalance = {
  id: "USDC:GISSUER",
  code: "USDC",
  amount: "5.0000000",
  authorized: true,
};

describe("the public asset a detail sheet is showing", () => {
  it("is the refreshed one, not the one the row was drawn from", () => {
    expect(livePublic(xlm("1.0000000"), [xlm("7.0000000"), usdc])?.amount).toBe("7.0000000");
  });

  it("is never a different asset", () => {
    // The failure this must not trade for: an asset that has left the list
    // must stop being drawn, not be replaced by whatever is first.
    expect(livePublic(usdc, [xlm("7.0000000")])).toBeNull();
  });

  it("keeps the snapshot while the balances are still being read", () => {
    const tapped = xlm("1.0000000");
    expect(livePublic(tapped, null)).toBe(tapped);
  });
});

describe("the private asset a detail sheet is showing", () => {
  // The same property, already extracted; asserted here beside its public twin
  // so the pair cannot drift.
  const priv = (spendable: string): PrivatePocket => ({
    state: "ready",
    symbol: "XLM",
    token: "CXLM",
    spendable,
  });

  it("is the refreshed one", () => {
    expect(liveDetail(priv("1.0000000"), [priv("7.0000000")])?.spendable).toBe("7.0000000");
  });
});
