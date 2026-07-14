// The rule that decides whether a user is told their payment failed.
import { describe, it, expect } from "vitest";
import { stillUnresolved } from "./backgroundOps";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const open = { hash: HASH, maxTime: 0, windowPassed: false, answered: false, expired: false };

describe("a failed op that the worker still holds a record for", () => {
  it("is unresolved, not failed", () => {
    // The case that matters: `pending` reaches the popup as a thrown error and
    // is indistinguishable from a real failure without asking the worker.
    expect(stillUnresolved({ status: "failed", hash: HASH }, open)).toBe(true);
  });

  it("is unresolved when the op never learned its own hash", () => {
    expect(stillUnresolved({ status: "failed" }, open)).toBe(true);
  });

  it("is NOT unresolved once the record has expired", () => {
    // Past its time bounds AND answered by the ledger, the envelope can never
    // be applied and never was, so "it may still land" stops being true and the
    // failure is real.
    expect(
      stillUnresolved(
        { status: "failed", hash: HASH },
        { ...open, windowPassed: true, answered: true, expired: true },
      ),
    ).toBe(false);
  });

  it("stays unresolved when the deadline passed but nobody could reach the ledger", () => {
    // The distinction the single `expired` field could not carry. An outage
    // spanning the 180-second window leaves the envelope un-includable from now
    // on, which says nothing about whether it landed before then. Calling that
    // a failure is the one instruction that makes a user send it again.
    expect(
      stillUnresolved(
        { status: "failed", hash: HASH },
        { ...open, windowPassed: true, answered: false, expired: false },
      ),
    ).toBe(true);
  });

  it("is NOT unresolved when the worker holds nothing", () => {
    expect(stillUnresolved({ status: "failed", hash: HASH }, null)).toBe(false);
  });

  it("does not borrow another transaction's record", () => {
    // Two ops can be in flight and the worker holds ONE record. Without the
    // hash check a genuinely failed swap would be relabelled by an unrelated
    // payment that happens to still be settling, and the user would be told not
    // to retry something that never left.
    expect(stillUnresolved({ status: "failed", hash: OTHER }, open)).toBe(false);
  });

  it("leaves an op alone once it has resolved", () => {
    // The answer arrives asynchronously, so a result that landed in the
    // meantime must win over it.
    expect(stillUnresolved({ status: "done", hash: HASH }, open)).toBe(false);
    expect(stillUnresolved({ status: "processing", hash: HASH }, open)).toBe(false);
    expect(stillUnresolved({ status: "unresolved", hash: HASH }, open)).toBe(false);
  });
});
