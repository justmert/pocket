// "You do not hold this" must be a fact, not a default.
//
// Every screen needing one asset out of the balance list wrote
// `(w.balances ?? []).find(...)` and asserted a negative from the miss. `?? []`
// collapses three different facts into one empty array: not loaded yet, the
// read failed, and the account genuinely holds none. Only the last is about the
// user, and it was the only one being said out loud, complete with instructions
// ("Receive or swap into USDC first", "Add it in Manage assets") that are
// wasted work if the account already holds the asset.
import { describe, it, expect } from "vitest";
import { findHeld, holdingAmount } from "./holdings";
import type { PublicBalance } from "../../../core/messages";

const USDC: PublicBalance = {
  id: "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  code: "USDC",
  amount: "12.5000000",
  authorized: true,
};
const isUsdc = (b: PublicBalance) => b.code === "USDC";

describe("looking one asset up in the balance list", () => {
  it("says 'held' with the balance when it is there", () => {
    expect(findHeld([USDC], null, isUsdc)).toEqual({ kind: "held", balance: USDC });
  });

  it("says 'absent' only when the list was actually READ and lacks it", () => {
    expect(findHeld([], null, isUsdc)).toEqual({ kind: "absent" });
  });

  it("says 'loading', not 'absent', before the list arrives", () => {
    // This is the state a popup spends its first moments in, and it is the one
    // that rendered "You do not hold any public USDC to bridge".
    expect(findHeld(null, null, isUsdc)).toEqual({ kind: "loading" });
  });

  it("says 'unreadable' and carries the worker's own words when the read failed", () => {
    const said = findHeld(null, "Pocket could not reach the network.", isUsdc);
    expect(said).toEqual({ kind: "unreadable", message: "Pocket could not reach the network." });
  });

  it("gives no spendable figure for any answer but 'held'", () => {
    // What gates Continue. All three non-answers are reasons not to offer a
    // spend; only one of them is a reason to tell the user why.
    expect(holdingAmount(findHeld([USDC], null, isUsdc))).toBe("12.5000000");
    expect(holdingAmount(findHeld([], null, isUsdc))).toBeNull();
    expect(holdingAmount(findHeld(null, null, isUsdc))).toBeNull();
    expect(holdingAmount(findHeld(null, "boom", isUsdc))).toBeNull();
  });

  it("never reports 'absent' and 'unreadable' as the same thing", () => {
    // The distinction the whole module exists for: one of these comes with an
    // instruction to go and acquire the asset, and it must never fire on a
    // network error.
    expect(findHeld(null, "boom", isUsdc).kind).not.toBe("absent");
    expect(findHeld(null, null, isUsdc).kind).not.toBe("absent");
  });
});

describe("a refresh that failed with a list already on screen", () => {
  // The state a failed refresh ACTUALLY produces. The provider deliberately
  // keeps the previous list and sets `balanceError` beside it, and the guard
  // read `balanceError && !balances`, which is the one shape that never
  // happens. So the screens got "held" with a stale figure they were about to
  // let the user spend from, or "absent" and an instruction to go and acquire
  // an asset they may well already hold.
  it("is unreadable, not held, even though a stale figure is available", () => {
    expect(findHeld([USDC], "Could not read your balances.", isUsdc)).toEqual({
      kind: "unreadable",
      message: "Could not read your balances.",
    });
  });

  it("is unreadable rather than absent for an asset missing from the stale list", () => {
    // The worse half: a negative comes with instructions, and acting on a
    // negative the wallet cannot vouch for is wasted work at best.
    expect(findHeld([], "Could not read your balances.", isUsdc).kind).toBe("unreadable");
  });

  it("offers no amount to spend from", () => {
    expect(holdingAmount(findHeld([USDC], "nope", isUsdc))).toBeNull();
  });

  it("still reports a real holding when the read succeeded", () => {
    // The control. A rule that answers "unreadable" for everything tells the
    // user less than the bug did.
    expect(findHeld([USDC], null, isUsdc)).toEqual({ kind: "held", balance: USDC });
  });
});
