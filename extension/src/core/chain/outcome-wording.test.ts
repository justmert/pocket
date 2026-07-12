// What the unfinished-transaction screen is allowed to say.
//
// That screen branched on the outcome three ways: succeeded navigated away in
// silence, pending said "still not confirmed", and EVERYTHING ELSE said
// "Resolved: it will not land. You can carry on." in a positive tone.
//
// "Everything else" includes `failed`, which means the transaction WAS included
// in a ledger, a fee WAS charged and the sequence number WAS consumed. Saying
// it did not land is not a softening; it is the opposite of what happened, on
// the one screen a user opens specifically to find out what happened.
//
// The correct sentence already existed in the worker and nothing on that path
// read it. These pin the properties the screen now depends on.
import { describe, it, expect } from "vitest";
import { describeOutcome, type SubmitOutcome } from "./submit";

const FAILED: SubmitOutcome = { kind: "failed", hash: "h", ledger: 9, reason: "txFailed" };

describe("describing a transaction that was included and failed", () => {
  it("does NOT say it will not land", () => {
    // The exact claim the screen used to make about this outcome.
    expect(describeOutcome(FAILED)).not.toMatch(/will not land/i);
  });

  it("says a fee was charged", () => {
    expect(describeOutcome(FAILED)).toMatch(/fee was charged/i);
  });

  it("says the sequence number was used", () => {
    // Load-bearing for what the user does next: the next transaction needs a
    // new sequence, and a wallet that says nothing was consumed invites a
    // resend that collides.
    expect(describeOutcome(FAILED)).toMatch(/sequence number was used/i);
  });
});

describe("every terminal outcome says whether it cost anything", () => {
  const OUTCOMES: SubmitOutcome[] = [
    { kind: "succeeded", hash: "h", ledger: 1, applicationOrder: 0 },
    FAILED,
    { kind: "rejected", hash: "h", reason: "txBadSeq" },
    { kind: "notAccepted", hash: "h" },
    { kind: "expired", hash: "h" },
  ];

  it("gives each one its own sentence, so none can be collapsed into another", () => {
    const said = OUTCOMES.map(describeOutcome);
    expect(new Set(said).size).toBe(OUTCOMES.length);
  });

  it("never tells the user nothing was charged when something was", () => {
    // The two that DID cost: succeeded and failed. Neither may claim otherwise.
    for (const o of [OUTCOMES[0]!, FAILED]) {
      expect(describeOutcome(o), o.kind).not.toMatch(/nothing was charged/i);
    }
  });

  it("does say nothing was charged for the ones that really cost nothing", () => {
    expect(describeOutcome({ kind: "rejected", hash: "h", reason: "r" })).toMatch(
      /nothing was charged/i,
    );
  });
});
