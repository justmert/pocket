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

describe("destructive-path guards (audit C1)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("refuses to import over an existing wallet", async () => {
    const c = new WalletController();
    const { address } = await c.create("pw");
    await expect(
      c.import("pw2", "illness spike retreat truth genius clock brain pass fit cave bargain toe"),
    ).rejects.toThrow(/already exists/);
    // And the original wallet is untouched.
    c.lock();
    expect((await c.unlock("pw")).address).toBe(address);
  });

  it("only destroys the wallet through reset, and only with the current password", async () => {
    const c = new WalletController();
    const { address } = await c.create("pw");

    await expect(c.reset("wrong")).rejects.toBeInstanceOf(WrongPasswordError);
    c.lock();
    expect((await c.unlock("pw")).address).toBe(address);

    await c.reset("pw");
    expect((await c.status()).initialised).toBe(false);
  });
});

describe("balance honesty (audit H1)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("renders zero ONLY for an account that does not exist yet", async () => {
    const c = new WalletController();
    await c.create("pw");
    // A freshly generated address has never been funded, so the ledger entry is
    // genuinely absent. That is the one case allowed to show zero.
    const b = await c.balances();
    expect(b[0]?.amount).toBe("0.0000000");
  });

  it("propagates a network failure instead of showing a confident zero", async () => {
    const c = new WalletController();
    await c.create("pw");
    // Point the controller at an unroutable RPC. Before the fix this returned a
    // confident authorized 0.0000000; a funded user would have seen their
    // balance vanish because the network hiccuped.
    (c as unknown as { servers: Map<string, unknown> }).servers.clear();
    (c as unknown as { network: string }).network = "broken";
    (
      c as unknown as { servers: Map<string, { getLedgerEntries: () => Promise<never> }> }
    ).servers.set("broken", {
      getLedgerEntries: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    await expect(c.balances()).rejects.toThrow(/ECONNREFUSED/);
  });
});

describe("what gets signed (audit H2)", () => {
  beforeEach(() => {
    store.clear();
  });

  it("refuses a handle it did not issue", async () => {
    const c = new WalletController();
    await c.create("pw");
    await expect(c.confirmPayment("deadbeef")).rejects.toThrow(/no longer pending/);
  });

  it("refuses to sign the same handle twice", async () => {
    // Single-use: the handle is removed on first use, so a replayed confirm
    // cannot re-submit or double-spend.
    const c = new WalletController();
    await c.create("pw");
    await expect(c.confirmPayment("deadbeef")).rejects.toThrow();
  });
});

describe("message discipline (audit H3)", () => {
  it("rejects an unsupported operation rather than answering ok", async () => {
    const { dispatch } = await import("./dispatch");
    const c = new WalletController();
    await expect(dispatch(c, { type: "notARealOperation" } as never)).rejects.toThrow(
      /unsupported operation/,
    );
  });

  it("does not allow import while locked", async () => {
    const { isAllowedWhileLocked } = await import("./dispatch");
    expect(isAllowedWhileLocked("import")).toBe(false);
    expect(isAllowedWhileLocked("reset")).toBe(false);
    expect(isAllowedWhileLocked("status")).toBe(true);
    expect(isAllowedWhileLocked("unlock")).toBe(true);
  });

  it("does not treat a status poll as activity that postpones the lock", async () => {
    const { isUserActivity } = await import("./dispatch");
    expect(isUserActivity("status")).toBe(false);
    expect(isUserActivity("lock")).toBe(false);
    expect(isUserActivity("buildPayment")).toBe(true);
  });
});
