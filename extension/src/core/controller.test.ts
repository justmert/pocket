import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";

// Minimal in-memory chrome.storage.local, so the controller can be exercised
// without a browser. Only storage is faked; the vault crypto, the derivation
// and the chain calls are all real.
const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string) => (store.has(k) ? { [k]: store.get(k) } : {}),
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string) => void store.delete(k),
    },
  },
});

const { WalletController } = await import("./controller");
const { WrongPasswordError } = await import("./vault/vault");
const { getSession } = await import("./session");

describe("wallet lifecycle", () => {
  beforeEach(() => {
    store.clear();
  });

  it("starts uninitialised", async () => {
    const c = new WalletController();
    await c.init();
    const s = await c.status();
    expect(s.initialised).toBe(false);
    expect(s.locked).toBe(true);
    expect(s.address).toBeUndefined();
  });

  it("creates a wallet and returns a 24-word phrase exactly once", async () => {
    const c = new WalletController();
    const { mnemonic, address } = await c.create("pw");
    expect(mnemonic.split(" ")).toHaveLength(24);
    expect(address).toMatch(/^G[A-Z2-7]{55}$/);
    const s = await c.status();
    expect(s.initialised).toBe(true);
    expect(s.locked).toBe(false);
  });

  it("refuses to create over an existing wallet", async () => {
    const c = new WalletController();
    await c.create("pw");
    await expect(c.create("pw2")).rejects.toThrow(/already exists/);
  });

  it("locks, then unlocks to the same address", async () => {
    const c = new WalletController();
    const { address } = await c.create("pw");
    c.lock();
    expect((await c.status()).locked).toBe(true);
    expect(getSession()).toBeNull();

    const s = await c.unlock("pw");
    expect(s.locked).toBe(false);
    expect(s.address).toBe(address);
  });

  it("rejects the wrong password", async () => {
    const c = new WalletController();
    await c.create("pw");
    c.lock();
    await expect(c.unlock("nope")).rejects.toBeInstanceOf(WrongPasswordError);
    expect((await c.status()).locked).toBe(true);
  });

  it("imports a known phrase to the SEP-0005 address", async () => {
    const c = new WalletController();
    const { address } = await c.import(
      "pw",
      "illness spike retreat truth genius clock brain pass fit cave bargain toe",
    );
    expect(address).toBe("GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6");
  });

  it("normalises a messily pasted phrase", async () => {
    const c = new WalletController();
    const { address } = await c.import(
      "pw",
      "  Illness  spike retreat\ttruth genius clock\nbrain pass fit cave bargain TOE ",
    );
    expect(address).toBe("GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6");
  });

  it("rejects an invalid phrase rather than deriving a wrong wallet", async () => {
    const c = new WalletController();
    await expect(c.import("pw", "not actually a mnemonic at all")).rejects.toThrow(
      /recovery phrase/,
    );
  });

  it("refuses balance reads while locked", async () => {
    const c = new WalletController();
    await c.create("pw");
    c.lock();
    await expect(c.balances()).rejects.toThrow(/locked/);
  });

  it("survives a lock/unlock cycle without changing the derived key", async () => {
    const c = new WalletController();
    const { address } = await c.create("pw");
    for (let i = 0; i < 3; i++) {
      c.lock();
      expect((await c.unlock("pw")).address).toBe(address);
    }
  });
});
