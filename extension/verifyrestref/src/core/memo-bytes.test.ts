// A Stellar text memo is 28 BYTES, not 28 characters.
//
// The distinction is invisible in ASCII and decisive outside it: a 28-character
// English memo fits, and a 10-character emoji memo does not. Exchange deposits
// are the main reason anyone types a memo at all, and a memo that is silently
// truncated or that fails at submit time after the user has reviewed and signed
// is the expensive kind of wrong.
import { describe, it, expect } from "vitest";
import { Memo } from "@stellar/stellar-sdk/base";

const bytes = (s: string) => new TextEncoder().encode(s).length;

describe("the memo boundary is bytes, not characters", () => {
  it("accepts 28 ASCII characters, which is 28 bytes", () => {
    const m = "a".repeat(28);
    expect(bytes(m)).toBe(28);
    expect(() => Memo.text(m)).not.toThrow();
  });

  it("refuses 29 ASCII characters", () => {
    expect(() => Memo.text("a".repeat(29))).toThrow();
  });

  it("refuses a string that is short in characters and long in bytes", () => {
    // Ten emoji, well under any character limit, and 40 bytes.
    const m = "🙂".repeat(10);
    expect(m.length).toBeLessThan(28);
    expect(bytes(m)).toBeGreaterThan(28);
    expect(() => Memo.text(m)).toThrow();
  });

  it("accepts multibyte text that fits in bytes", () => {
    // Seven emoji is 28 bytes exactly: the boundary from the other side.
    const m = "🙂".repeat(7);
    expect(bytes(m)).toBe(28);
    expect(() => Memo.text(m)).not.toThrow();
  });

  it("counts an RTL string by its bytes too", () => {
    const m = "مرحبا";
    expect(bytes(m)).toBeGreaterThan(m.length);
    expect(() => Memo.text(m)).not.toThrow();
  });
});

describe("what the wallet says about a memo that is too long", () => {
  it("names the memo as the problem, rather than a generic failure", async () => {
    // Memo.text throws a bare Error from inside the SDK, and describeError's
    // allowlist is by NAME, so an unnamed throw becomes "Something went wrong.
    // Try again, and check your connection." That sends a user to check their
    // network over a string they typed, and no amount of retrying fixes it.
    const { describeError } = await import("./dispatch");
    const { MemoTooLongError } = await import("./chain/payment");
    const err = new MemoTooLongError(
      "That memo is 40 bytes and the limit is 28. The limit counts bytes rather than " +
        "characters, so accents and emoji use several each.",
    );
    expect(err).toBeTruthy();
    const shown = describeError(err);
    expect(shown.toLowerCase()).toMatch(/memo/);
    expect(shown).not.toMatch(/check your connection/);
  });
});
