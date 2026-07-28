// Escape belongs to the thing on top.
//
// An InfoTip inside a confirm sheet is above it. Both listened on `window`, so
// one press at the 'i' next to "What this does" dismissed the tip AND cancelled
// the confirm underneath, throwing away the staged transaction the tip was
// explaining. Listener order cannot decide it: the sheet is already open when
// the tip opens, so the sheet's listener is registered first and runs first,
// and `stopImmediatePropagation` from the tip arrives after the damage.
import { describe, it, expect, beforeEach } from "vitest";
import { claimEscape, escapeClaimed, resetEscapeClaims } from "./escapeLayers";

beforeEach(() => resetEscapeClaims());

describe("who holds Escape", () => {
  it("is nobody when nothing transient is open", () => {
    expect(escapeClaimed()).toBe(false);
  });

  it("is the tip while it is open", () => {
    const release = claimEscape();
    expect(escapeClaimed(), "the sheet under an open tip would answer Escape").toBe(true);
    release();
    expect(escapeClaimed()).toBe(false);
  });

  it("stays held while any one of several tips is open", () => {
    // Two tips can overlap: one closing on a 90ms timer while the next opens.
    // Releasing the first must not hand Escape back to the sheet under the
    // second.
    const a = claimEscape();
    const b = claimEscape();
    a();
    expect(escapeClaimed()).toBe(true);
    b();
    expect(escapeClaimed()).toBe(false);
  });

  it("cannot be released twice, which would free it early", () => {
    // A component may release in a cleanup and again in a close handler. A
    // second decrement would drive the count negative and let the NEXT tip's
    // Escape reach the sheet.
    const a = claimEscape();
    const b = claimEscape();
    a();
    a();
    a();
    expect(escapeClaimed(), "a double release freed Escape while a tip was open").toBe(true);
    b();
    expect(escapeClaimed()).toBe(false);
  });
});
