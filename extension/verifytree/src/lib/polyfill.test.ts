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
    // Generated here rather than pinned: what is under test is that the SDK's
    // ed25519 works without a DOM, and a secret literal in a tracked file is a
    // pattern that would carry a real key just as easily.
    const kp = Keypair.random();
    expect(Keypair.fromSecret(kp.secret()).publicKey()).toBe(kp.publicKey());
    expect(kp.publicKey()).toMatch(/^G[A-Z2-7]{55}$/);
  });
});
