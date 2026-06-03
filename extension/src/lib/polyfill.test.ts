import { describe, it, expect } from "vitest";

// The polyfill exists because stellar-sdk throws "Buffer is not defined" at
// runtime in an MV3 service worker. This pins that it installs the global and
// that the sdk can actually use it, so a future refactor cannot quietly drop it.
describe("Buffer polyfill", () => {
  it("installs Buffer on globalThis", async () => {
    await import("./polyfill");
    expect(typeof globalThis.Buffer).toBe("function");
    expect(globalThis.Buffer.from("pocket").toString("hex")).toBe("706f636b6574");
  });

  it("lets stellar-sdk build a keypair without a DOM", async () => {
    await import("./polyfill");
    const { Keypair } = await import("@stellar/stellar-sdk/base");
    const kp = Keypair.fromSecret("SBUUZ6Q6EAVYEVQHPHL72FVAAKOJEGW7HVWAWTZGRXBGMN3DHHLTUQFW");
    expect(kp.publicKey()).toBe("GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7");
  });
});
