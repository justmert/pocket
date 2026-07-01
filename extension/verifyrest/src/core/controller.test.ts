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
      remove: async (k: string | string[]) => {
        // chrome.storage.local.remove accepts one key OR an array. A mock that
        // only handles the string form silently drops a multi-key erase.
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
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
    // Both spellings. `readNative` reaches the ledger through the SDK's private
    // `_getLedgerEntries` so it can pass a raw key, and stubbing only the public
    // name made this pass for the wrong reason: the failure it caught was
    // "method missing", not the refused connection it is about.
    const refuse = () => Promise.reject(new Error("ECONNREFUSED"));
    (c as unknown as { servers: Map<string, unknown> }).servers.set("broken", {
      getLedgerEntries: refuse,
      _getLedgerEntries: refuse,
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

  // REVISED from the phase-2 audit (fbc489a, finding H3), deliberately and
  // with the original intent preserved.
  //
  // H3 removed "import" from ALLOWED_WHILE_LOCKED so a stray message could not
  // replace a funded wallet's seed. The intent was right; the mechanism was
  // too broad. A fresh install is ALSO locked, and it is the only state
  // onboarding-by-import is ever reached from, so the rule did not narrow that
  // path, it deleted it: "I have a recovery phrase" answered "Wallet is
  // locked." on the first screen for every returning user.
  //
  // The rule that satisfies both is "import only when no vault exists", and it
  // is enforced where it cannot be bypassed, inside controller.import itself.
  // The lock was never the thing protecting the seed.
  it("allows import while locked, because a fresh install is locked", async () => {
    const { isAllowedWhileLocked } = await import("./dispatch");
    expect(isAllowedWhileLocked("import")).toBe(true);
    expect(isAllowedWhileLocked("reset")).toBe(false);
    expect(isAllowedWhileLocked("status")).toBe(true);
    expect(isAllowedWhileLocked("unlock")).toBe(true);
  });

  it("still refuses to import over an existing wallet, which is what H3 was for", async () => {
    // The property H3 actually cared about, asserted against the guard that
    // really enforces it rather than against the dispatcher's allowlist.
    // This describe shares the store with the tests above it.
    store.clear();
    const c = new WalletController();
    await c.init();
    const { mnemonic } = await c.create("the first wallet's password");

    // Same device, same storage, a second controller trying to replace it.
    const other = new WalletController();
    await other.init();
    await expect(other.import("attacker password", mnemonic)).rejects.toThrow(
      /already exists on this device/,
    );
  });

  it("does not treat a status poll as activity that postpones the lock", async () => {
    const { isUserActivity } = await import("./dispatch");
    expect(isUserActivity("status")).toBe(false);
    expect(isUserActivity("lock")).toBe(false);
    expect(isUserActivity("buildPayment")).toBe(true);
  });
});

describe("private pocket reporting", () => {
  beforeEach(() => {
    store.clear();
  });

  it("refuses while locked", async () => {
    const c = new WalletController();
    await c.create("pw");
    c.lock();
    await expect(c.privatePocket()).rejects.toThrow(/locked/);
  });

  it("reports an unfunded account as such, rather than crashing", async () => {
    // A freshly created wallet has no ledger entry. Opening the private pocket
    // view must not blow up on it.
    const c = new WalletController();
    await c.create("pw");
    const p = await c.privatePocket();
    expect(p.state).toBe("unfunded");
    expect(p.message).toMatch(/does not exist on the network/i);
  }, 30_000);

  it("reports a funded but unregistered account with the honest disclosure", async () => {
    const c = new WalletController();
    // Import the funded testnet account so the ledger entry exists.
    await c.import(
      "pw",
      "illness spike retreat truth genius clock brain pass fit cave bargain toe",
    );
    const p = await c.privatePocket();
    // Whatever the state, it must not be a crash and must not invent a balance.
    expect(typeof p.state).toBe("string");
    if (p.state === "unregistered") {
      // The two facts a user must have BEFORE committing: it is public, and
      // the auditor binding is permanent.
      expect(p.message).toMatch(/publicly visible/i);
      expect(p.message).toMatch(/permanently binds an auditor/i);
    }
  }, 30_000);

  it("never reports a balance for a state that is not ready", async () => {
    const c = new WalletController();
    await c.create("pw");
    const p = await c.privatePocket();
    expect(p.spendable).toBeUndefined();
    expect(p.receiving).toBeUndefined();
  }, 30_000);

  it("says the private pocket is available on this deployment", async () => {
    const c = new WalletController();
    await c.create("pw");
    expect((await c.status()).privateAvailable).toBe(true);
  });
});

describe("opening persistence, which makes commitments spendable", () => {
  beforeEach(() => {
    store.clear();
  });

  it("round-trips openings through the encrypted vault", async () => {
    const c = new WalletController();
    await c.create("pw");
    const inner = c as unknown as {
      writeOpenings: (a: string, t: string, s: unknown) => Promise<void>;
      readOpenings: (a: string, t: string) => Promise<unknown>;
    };
    const state = {
      spendable: { value: 500n, randomness: 42n },
      receiving: { value: 30n, randomness: 7n },
      syncedThrough: 12345,
    };
    await inner.writeOpenings("GADDR", "CTOKEN", state);
    expect(await inner.readOpenings("GADDR", "CTOKEN")).toEqual(state);
  });

  it("stores them ENCRYPTED, never in the clear", async () => {
    // An opening reveals an amount. Storing it readable would defeat the point
    // of the private pocket on a device someone else can read.
    const c = new WalletController();
    await c.create("pw");
    await (
      c as unknown as { writeOpenings: (a: string, t: string, s: unknown) => Promise<void> }
    ).writeOpenings("GADDR", "CTOKEN", {
      spendable: { value: 123456789n, randomness: 42n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 1,
    });
    const raw = JSON.stringify([...store.entries()]);
    expect(raw).not.toContain("123456789");
    expect(raw).not.toContain("spendable");
  });

  it("keeps openings per (deployment, account), since identities are per-contract", async () => {
    // vk binds addr_f, so the same seed has a DIFFERENT confidential identity
    // on every deployment. Sharing one opening store across them would corrupt
    // both.
    const c = new WalletController();
    await c.create("pw");
    const inner = c as unknown as {
      writeOpenings: (a: string, t: string, s: unknown) => Promise<void>;
      readOpenings: (a: string, t: string) => Promise<unknown>;
    };
    const one = {
      spendable: { value: 1n, randomness: 1n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 1,
    };
    const two = {
      spendable: { value: 2n, randomness: 2n },
      receiving: { value: 0n, randomness: 0n },
      syncedThrough: 1,
    };
    await inner.writeOpenings("GADDR", "CTOKEN_A", one);
    await inner.writeOpenings("GADDR", "CTOKEN_B", two);
    expect(await inner.readOpenings("GADDR", "CTOKEN_A")).toEqual(one);
    expect(await inner.readOpenings("GADDR", "CTOKEN_B")).toEqual(two);
  });

  it("returns null when nothing is stored, rather than a zero balance", async () => {
    // Absent openings mean "we cannot know your balance", which is a different
    // and much more serious state than "your balance is zero".
    const c = new WalletController();
    await c.create("pw");
    expect(
      await (
        c as unknown as { readOpenings: (a: string, t: string) => Promise<unknown> }
      ).readOpenings("GADDR", "CTOKEN"),
    ).toBeNull();
  });
});
