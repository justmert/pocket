import { describe, it, expect } from "vitest";
import { isAllowedWhileLocked, describeError, isUserActivity } from "./dispatch";

describe("the locked-state allowlist", () => {
  it("keeps reset out, because it has no guard of its own", () => {
    // reset() takes a password and erases. Nothing else stops it, so the lock
    // is its only protection.
    expect(isAllowedWhileLocked("reset")).toBe(false);
  });

  it("lets import through, because its guard is stronger than the lock", () => {
    // The phase-2 critical was "import replaces a funded wallet's seed". The
    // fix for that is the existence guard INSIDE import(), which refuses
    // outright when a vault is present. Excluding it from this set as well
    // looked like defence in depth and was not: a fresh install is locked by
    // definition, so it made restoring from a phrase impossible.
    expect(isAllowedWhileLocked("import")).toBe(true);
  });

  it("lets recovery through, because it carries its own authorisation", () => {
    // A forgotten password is precisely when this is needed, and the phrase
    // check is stronger than the lock: it proves ownership of this account.
    expect(isAllowedWhileLocked("recoverFromMnemonic")).toBe(true);
  });

  it("keeps every private operation out while locked", () => {
    for (const op of ["buildPrivateOp", "confirmPrivateOp", "privatePocket", "buildPayment"]) {
      expect(isAllowedWhileLocked(op), op).toBe(false);
    }
  });
});

describe("describeError has no shape heuristic", () => {
  it("replaces an RPC-authored string even when it looks authored", () => {
    // "Starts with a capital, ends with a stop" is trivially satisfiable by a
    // string we did not write. That is why the allowlist is by NAME.
    const rpc = new Error("Error(Contract, #3506).");
    expect(describeError(rpc)).not.toContain("3506");
    expect(describeError(new Error("Insufficient balance for the transfer."))).toBe(
      "Something went wrong. Try again, and check your connection.",
    );
  });

  it("passes through errors we named ourselves", () => {
    class PrivatePocketError extends Error {
      override readonly name = "PrivatePocketError";
    }
    expect(describeError(new PrivatePocketError("That address has no private pocket."))).toBe(
      "That address has no private pocket.",
    );
  });
});

describe("idle-lock activity", () => {
  it("counts a private operation as activity, so proving is not interrupted", () => {
    expect(isUserActivity("buildPrivateOp")).toBe(true);
    expect(isUserActivity("confirmPrivateOp")).toBe(true);
  });

  it("does not count an unrecognised message as activity", () => {
    expect(isUserActivity("somethingElse")).toBe(false);
  });
});

describe("onboarding by import must be reachable", () => {
  it("allows import while locked, which is the only state it happens in", () => {
    // A fresh install has no vault, so it is locked by definition. Dropping
    // this from the set made "I have a recovery phrase" answer "Wallet is
    // locked." on the first screen, for every returning user on a new machine.
    expect(isAllowedWhileLocked("import")).toBe(true);
  });

  it("still keeps reset out, which import's own guard does not cover", () => {
    expect(isAllowedWhileLocked("reset")).toBe(false);
  });
});
