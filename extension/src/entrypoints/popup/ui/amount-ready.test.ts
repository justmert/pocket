// The one gate that decides whether a compose screen's primary action is live.
//
// It replaced `withinSpendable` used alone at five call sites. That function
// answers "is this at most the balance", and `withinSpendable("0", s)` is true
// by construction, so a typed zero enabled Continue everywhere and the worker
// answered "A payment has to be for more than zero." Move had no ceiling at all
// (`const ready = amount !== ""`) while driving a percentage slider off the very
// `spendable` it did not compare against.
import { describe, it, expect } from "vitest";
import { amountReady } from "./AmountComposer";

const BALANCE = "10.0000000";

describe("what makes an amount ready to send", () => {
  it("accepts an ordinary amount inside the balance", () => {
    expect(amountReady("1.5", BALANCE)).toBe(true);
  });

  it("accepts exactly the whole balance, which is what Use max fills", () => {
    expect(amountReady(BALANCE, BALANCE)).toBe(true);
  });

  it("refuses an empty field", () => {
    expect(amountReady("", BALANCE)).toBe(false);
  });

  it("refuses zero, which `withinSpendable` alone accepts", () => {
    // The defect this exists for: every screen turned Continue live on "0" and
    // let the worker do the refusing, after the press.
    expect(amountReady("0", BALANCE)).toBe(false);
    expect(amountReady("0.0000000", BALANCE)).toBe(false);
  });

  it("refuses more than the balance", () => {
    expect(amountReady("10.0000001", BALANCE)).toBe(false);
  });

  it("refuses a half-typed value rather than throwing", () => {
    // The composer deliberately lets these reach state while the caret is in the
    // field. They are not ready; they are also not an error.
    expect(amountReady(".", BALANCE)).toBe(false);
    expect(amountReady("abc", BALANCE)).toBe(false);
  });

  it("refuses when the balance is unknown, unless the caller says otherwise", () => {
    // null is "not read", which is not "zero" and not "fine". A yield WITHDRAW is
    // the one caller that legitimately opts in: it draws from the vault, not from
    // a wallet balance.
    expect(amountReady("1", null)).toBe(false);
    expect(amountReady("1", null, { allowUnknownBalance: true })).toBe(true);
  });

  it("still refuses zero even when the balance is unknown and allowed", () => {
    expect(amountReady("0", null, { allowUnknownBalance: true })).toBe(false);
  });
});
