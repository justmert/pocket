import { describe, it, expect } from "vitest";
import {
  ERROR,
  err,
  isDappPermittedMethod,
  CONFIDENTIAL_METHODS,
  DAPP_ALLOWED_CONTRACT_METHODS,
} from "./sep43";

describe("SEP-43 error codes", () => {
  it("matches the spec's four codes exactly", () => {
    expect(ERROR).toEqual({
      INTERNAL: -1,
      EXTERNAL: -2,
      INVALID_REQUEST: -3,
      USER_REJECTED: -4,
    });
  });

  it("returns errors in the resolved object rather than throwing", () => {
    // A dapp reads result.error; it does not catch. Throwing would break every
    // conforming client.
    const e = err(ERROR.USER_REJECTED, "The user declined.");
    expect(e.error.code).toBe(-4);
    expect(e.error.message).toBe("The user declined.");
  });

  it("supports the optional ext field", () => {
    expect(err(ERROR.INVALID_REQUEST, "bad", ["detail"]).error.ext).toEqual(["detail"]);
  });
});

describe("the dapp privacy boundary", () => {
  it("permits nothing by default", () => {
    // An allowlist that starts empty cannot fail open.
    expect(DAPP_ALLOWED_CONTRACT_METHODS.size).toBe(0);
    expect(isDappPermittedMethod("anything")).toBe(false);
  });

  it("refuses EVERY confidential operation", () => {
    for (const m of CONFIDENTIAL_METHODS) {
      expect(isDappPermittedMethod(m), `${m} must never be dapp-reachable`).toBe(false);
    }
  });

  it("refuses a method nobody has heard of", () => {
    // The property that a denylist cannot give: a confidential operation added
    // upstream tomorrow is already refused today.
    expect(isDappPermittedMethod("some_future_confidential_op")).toBe(false);
    expect(isDappPermittedMethod("")).toBe(false);
  });

  it("names the confidential set explicitly, for legibility", () => {
    // The allowlist is what enforces; this set exists so a reader can see the
    // intent without inferring it.
    expect(CONFIDENTIAL_METHODS.has("confidential_transfer")).toBe(true);
    expect(CONFIDENTIAL_METHODS.has("register")).toBe(true);
    expect(CONFIDENTIAL_METHODS.has("withdraw")).toBe(true);
  });
});
