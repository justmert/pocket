// The dollar figure under an entered amount.
import { describe, it, expect } from "vitest";
import { fiatOf } from "./money";

describe("fiatOf", () => {
  it("multiplies a real amount by a real price", () => {
    expect(fiatOf("10", 0.25)).toBeCloseTo(2.5);
    expect(fiatOf("0.5", 2)).toBeCloseTo(1);
  });

  it("says nothing when there is no price or no amount", () => {
    expect(fiatOf("10", null)).toBeNull();
    expect(fiatOf("", 1)).toBeNull();
  });

  it("says nothing rather than $NaN for what the field can actually hold", () => {
    // The compose field is a plain text input; inputMode is a soft-keyboard
    // hint, not a filter. Each of these made `Number` NaN, and NaN is neither
    // null nor empty, so the caption read "$NaN".
    for (const junk of ["-", ".", "1,5", "abc", "1.2.3", "+", "١٢"]) {
      expect(fiatOf(junk, 1), junk).toBeNull();
    }
  });

  it("says nothing when the product itself overflows", () => {
    expect(fiatOf("1e400", 2)).toBeNull();
    expect(fiatOf("179769313486231570000000000000000000000000000000000", 1e300)).toBeNull();
  });
});
