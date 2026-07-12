// The screens must never be handed the wrong asset.
//
// The rule was `find(p => p.token === selected) ?? privAssets[0]`, and that
// fallback substitutes a DIFFERENT pocket whenever the selected one is absent.
// The screens then draw that asset's balance, state and actions under the
// selection the user made, and nothing downstream can detect the swap: a
// wallet with USDC chosen was looking at XLM's numbers.
//
// It needs nothing to go wrong on chain to happen. `loadPrivate` falls back to
// the SINGULAR read when the plural one fails, and that returns the primary
// asset alone, so the list legitimately holds one entry while the selection
// names another.
import { describe, it, expect } from "vitest";
import { selectPrivateAsset } from "./selectAsset";
import type { PrivatePocket } from "../../../core/messages";

const XLM: PrivatePocket = { state: "ready", symbol: "XLM", token: "CXLM" };
const USDC: PrivatePocket = { state: "ready", symbol: "USDC", token: "CUSDC" };
/** The singular read's shape: one pocket, no token to match on. */
const LEGACY: PrivatePocket = { state: "ready", symbol: "XLM" };

describe("choosing the private pocket a screen is about", () => {
  it("returns the asset that was actually selected", () => {
    expect(selectPrivateAsset([XLM, USDC], "CUSDC")).toBe(USDC);
  });

  it("returns NULL rather than a different asset when the selected one is missing", () => {
    // The defect, stated directly. Every caller already handles null, because
    // the list is null before it loads; none can detect a substitution.
    expect(selectPrivateAsset([XLM], "CUSDC")).toBeNull();
  });

  it("does not hand back XLM for a USDC selection even when XLM is all there is", () => {
    // The exact reachable case: the plural read failed, the singular fallback
    // returned the primary asset, and USDC was selected.
    const chosen = selectPrivateAsset([XLM], "CUSDC");
    expect(chosen?.symbol).not.toBe("XLM");
  });

  it("still accepts the legacy single-pocket shape, which carries no token", () => {
    // The one case the fallback was written for. Matching on token would find
    // nothing here, so removing the fallback outright would break an older
    // worker rather than fix anything.
    expect(selectPrivateAsset([LEGACY], "CXLM")).toBe(LEGACY);
  });

  it("does not treat a tokenless pocket as a wildcard when there are several", () => {
    // Two entries means the plural read worked, so a missing token is a
    // malformed entry, not the legacy shape.
    expect(selectPrivateAsset([LEGACY, USDC], "CUSDC")).toBe(USDC);
    expect(selectPrivateAsset([LEGACY, USDC], "CSOMETHING")).toBeNull();
  });

  it("defaults to the first pocket when nothing is selected yet", () => {
    // Not a substitution: the user has not asked for anything, so the wallet's
    // own default is the honest answer.
    expect(selectPrivateAsset([XLM, USDC], null)).toBe(XLM);
  });

  it("has nothing to return before the list loads, or when it is empty", () => {
    expect(selectPrivateAsset(null, "CXLM")).toBeNull();
    expect(selectPrivateAsset([], "CXLM")).toBeNull();
  });
});
