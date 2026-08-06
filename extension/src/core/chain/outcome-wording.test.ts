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

/**
 * A transaction-level rejection reaches the user as words.
 *
 * `describeSendError` returned the XDR discriminant name verbatim, so the
 * sentence read "Rejected (txBadSeq). Nothing was charged." That is safe (a
 * closed set, no RPC-authored string) and useless: it names a protocol
 * identifier to somebody who wanted to know what to do next.
 */
describe("what a rejection says happened", () => {
  const rejectionFor = async (name: string) => {
    const { submitAndConfirm } = await import("./submit");
    const server = {
      sendTransaction: async () => ({
        status: "ERROR",
        hash: "h".repeat(64),
        errorResult: { result: () => ({ switch: () => ({ name }) }) },
      }),
    } as never;
    const tx = {
      hash: () => Buffer.from("h".repeat(32)),
      timeBounds: { maxTime: String(Math.floor(Date.now() / 1000) + 180) },
      toXDR: () => "",
    } as never;
    const out = await submitAndConfirm(server, tx);
    return out.kind === "rejected" ? out.reason : `not a rejection: ${out.kind}`;
  };

  it("says what a stale sequence number means", async () => {
    const said = await rejectionFor("txBadSeq");
    expect(said, "a protocol identifier reached the user").not.toBe("txBadSeq");
    expect(said).toMatch(/already out of date/);
  });

  it("says what a passed time window means", async () => {
    expect(await rejectionFor("txTooLate")).toMatch(/time window had already passed/);
  });

  it("says what an unaffordable transaction means", async () => {
    expect(await rejectionFor("txInsufficientBalance")).toMatch(/cannot cover the amount/);
  });

  it("still passes an unmapped code through rather than inventing one", async () => {
    // From a closed set, better than silence, and guessing at a sentence for a
    // code nobody has seen would be inventing the one thing this reports.
    expect(await rejectionFor("txSomethingNew")).toBe("txSomethingNew");
  });
});
