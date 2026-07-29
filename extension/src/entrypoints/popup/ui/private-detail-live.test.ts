// The private asset sheet reads a LIVE pocket, or it is lying in its own header.
//
// `PrivateAssetSheet`'s comment says "it reads the live pocket off `priv`
// rather than a passed snapshot, so a balance that refreshes, or a receive that
// lands, updates the open sheet in place". It did not. `setPrivateDetail` has
// exactly two writers and both are "a row was tapped"; `refresh` writes
// `privAssets` and nothing reconciled the two, so the sheet held the object the
// row was rendered from until it was closed and reopened. MoveSheet reads the
// same field to decide which asset it is acting on.
import { describe, it, expect } from "vitest";
import { liveDetail } from "./selectAsset";
import type { PrivatePocket } from "../../../core/messages";

const XLM = (spendable: string): PrivatePocket => ({
  state: "ready",
  symbol: "XLM",
  token: "CXLM",
  spendable,
});
const USDC: PrivatePocket = { state: "ready", symbol: "USDC", token: "CUSDC" };
const LEGACY: PrivatePocket = { state: "ready", symbol: "XLM" };

describe("the asset a private sheet is showing", () => {
  it("is the refreshed one, not the one the row was drawn from", () => {
    const tapped = XLM("1.0000000");
    const loaded = [XLM("7.0000000"), USDC];
    expect(liveDetail(tapped, loaded)?.spendable).toBe("7.0000000");
  });

  it("stays the tapped asset, never a different one", () => {
    // The failure this must not trade for: resolving USDC against a set that no
    // longer lists it must not hand back XLM.
    expect(liveDetail(USDC, [XLM("7.0000000")])).toBeNull();
  });

  it("keeps the snapshot while the set is still being read", () => {
    // Null is "not loaded yet". Blanking the open sheet on every refresh would
    // be a flicker, and the snapshot is the best-known truth until it lands.
    const tapped = XLM("1.0000000");
    expect(liveDetail(tapped, null)).toBe(tapped);
  });

  it("keeps a token-less snapshot rather than substituting the first asset", () => {
    // The legacy single-pocket shape. `selectPrivateAsset(assets, null)`
    // returns assets[0], which is right for "nothing selected yet" and wrong
    // here: it would turn this sheet into a different asset's.
    expect(liveDetail(LEGACY, [XLM("7.0000000"), USDC])).toBe(LEGACY);
  });

  it("has nothing to show when nothing was tapped", () => {
    expect(liveDetail(null, [XLM("7.0000000")])).toBeNull();
  });
});
