// "Hide balance" applied everywhere a figure is drawn.
//
// It was honoured on four surfaces and ignored on fourteen, including two
// figures on the very screen that draws the toggle, and the whole activity
// screen, which is exactly what someone turning the setting on in public is
// hiding. Two causes, both structural:
//
//   1. `Amount` defaulted `hidden` to FALSE, so every figure had to opt IN by
//      threading `hidden={w.hidden}` down to it. Forgetting it revealed a
//      balance, silently, which is the dangerous direction.
//   2. History draws its amounts as interpolated strings and so inherited
//      nothing from the component at all.
import { describe, it, expect } from "vitest";
import { isMasked, maskAmount } from "./Amount";

describe("masking a figure drawn as text", () => {
  it("leaves it alone when the mask is off", () => {
    expect(maskAmount("40.0000000", false)).toBe("40.0000000");
    expect(maskAmount("$12.34", false)).toBe("$12.34");
  });

  it("hides the digits AND the magnitude", () => {
    // A mask whose width tracks the number leaks the number's size, which is
    // most of what someone is hiding. Fixed run per part.
    expect(maskAmount("40.0000000", true)).toBe(maskAmount("9123456.7000000", true));
  });

  it("keeps the currency sign, which is not the secret", () => {
    expect(maskAmount("$12.34", true).startsWith("$")).toBe(true);
    expect(maskAmount("-5.00", true).startsWith("-")).toBe(true);
  });

  it("masks a whole-number figure too", () => {
    const said = maskAmount("40", true);
    expect(said).not.toContain("4");
    expect(said).not.toContain(".");
  });

  it("leaves no digit of the original anywhere in the output", () => {
    for (const v of ["40.0000000", "$1,234.56", "-0.0000001", "9"]) {
      expect(/[0-9]/.test(maskAmount(v, true)), v).toBe(false);
    }
  });
});

describe("whether a figure is masked at all", () => {
  it("follows the wallet's setting when the call site says nothing", () => {
    // The default, and the reason the setting was ignored in fourteen places:
    // this used to be false regardless of what the wallet was set to.
    expect(isMasked(undefined, true, false)).toBe(true);
    expect(isMasked(undefined, false, false)).toBe(false);
  });

  it("lets a call site that DOES say something win", () => {
    expect(isMasked(false, true, false)).toBe(false);
    expect(isMasked(true, false, false)).toBe(true);
  });

  it("reveals a figure the user is looking at on purpose, whatever else is set", () => {
    // A confirm, a receipt, an amount being typed. Masking these makes the
    // screen unusable rather than private.
    expect(isMasked(undefined, true, true)).toBe(false);
    expect(isMasked(true, true, true)).toBe(false);
  });

  it("fails toward hiding, not toward showing", () => {
    // The property that matters. With the mask on, the only way to show a
    // figure is to ask for it: nothing reveals by omission.
    for (const explicit of [undefined, true]) {
      expect(isMasked(explicit, true, false)).toBe(true);
    }
  });
});
