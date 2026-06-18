// The one instruction that must never be swallowed.
//
// describeError replaces any error whose NAME is not allowlisted. When the
// submit path threw a bare Error, the authored "do not resend" message was
// discarded and the user was told to try again, which is the exact opposite
// advice after an unresolved submission and can spend twice.
import { describe, it, expect } from "vitest";
import { describeError } from "./dispatch";
import { SubmitOutcomeError, describeOutcome } from "./chain/submit";

describe("submit outcomes reach the user intact", () => {
  it("keeps the do-not-resend instruction for a pending transaction", () => {
    const outcome = { kind: "pending", hash: "c23d994e" } as never;
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).toContain("do not resend");
    expect(shown).toContain("c23d994e");
    expect(shown).not.toContain("Something went wrong");
  });

  it("keeps the fee-was-charged warning for a failed transaction", () => {
    const outcome = { kind: "failed", reason: "txFailed", hash: "d1" } as never;
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).toContain("A fee was charged");
    expect(shown).not.toContain("Something went wrong");
  });

  it("still replaces an unnamed error, so the allowlist is not weakened", () => {
    expect(describeError(new Error("Error(Contract, #3506)."))).toBe(
      "Something went wrong. Try again, and check your connection.",
    );
  });
});
