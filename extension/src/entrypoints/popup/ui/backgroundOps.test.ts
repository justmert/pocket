// The rule that decides whether a user is told their payment failed.
import { describe, it, expect } from "vitest";
import { stillUnresolved } from "./backgroundOps";

const HASH = "a".repeat(64);
const OTHER = "b".repeat(64);
const open = { hash: HASH, maxTime: 0, expired: false };

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
    // Past its time bounds the envelope can never be applied, so "it may still
    // land" stops being true and the failure is real.
    expect(stillUnresolved({ status: "failed", hash: HASH }, { ...open, expired: true })).toBe(
      false,
    );
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
