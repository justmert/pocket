// What a dApp grant is, and what it stops being.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../../lib/polyfill";

const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) =>
        k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
    },
  },
});

const { WalletController } = await import("../controller");
const { KEYS, readLocal } = await import("../../lib/storage");

describe("a grant does not outlive the wallet that made it", () => {
  beforeEach(() => store.clear());

  it("erasing the wallet takes every dApp grant with it", async () => {
    const c = new WalletController();
    await c.init();
    await c.create("first password");
    await c.connectDapp("https://app.example");
    expect(await readLocal(KEYS.dappSessions)).toBeDefined();

    await c.reset("first password");

    // Otherwise the NEXT wallet installed on this device inherits every
    // connection the last one made, silently and with no prompt.
    expect(await readLocal(KEYS.dappSessions)).toBeUndefined();
  });

  it("a recovery into a different wallet takes them too", async () => {
    const c = new WalletController();
    await c.init();
    const { mnemonic } = await c.create("first password");
    await c.connectDapp("https://app.example");

    await c.recoverFromMnemonic(mnemonic, "a new password");
    expect(await readLocal(KEYS.dappSessions)).toBeUndefined();
  });
});

describe("the granted address is the consent", () => {
  beforeEach(() => store.clear());

  it("answers getAddress for the account the site was connected to", async () => {
    const c = new WalletController();
    await c.init();
    const { address } = await c.create("pw");
    await c.connectDapp("https://app.example");

    const res = (await c.sep43("https://app.example", "getAddress", [])) as { address?: string };
    expect(res.address).toBe(address);
  });

  it("REFUSES and drops the grant when the wallet has changed underneath it", async () => {
    // Connect a site to wallet A, then recover into wallet B on the same
    // device. The grant is still inside its 24 hours. Answering with B links
    // the user's old and new addresses for a third party, which is exactly
    // what a wallet shipping a private pocket must not do.
    const c = new WalletController();
    await c.init();
    await c.create("pw");
    await c.connectDapp("https://app.example");

    // Forge the situation directly: the stored grant names a different account.
    const sessions = (await readLocal<Record<string, { address: string }>>(KEYS.dappSessions))!;
    sessions["https://app.example"]!.address = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7";
    await chrome.storage.local.set({ [KEYS.dappSessions]: sessions });

    const res = (await c.sep43("https://app.example", "getAddress", [])) as {
      error?: { message: string };
    };
    expect(res.error).toBeDefined();
    expect(res.error!.message).toMatch(/changed since this site connected/);

    // And the stale grant is GONE, not merely refused once.
    const after = (await readLocal<Record<string, unknown>>(KEYS.dappSessions)) ?? {};
    expect(after["https://app.example"]).toBeUndefined();
  });

  it("never signs for a site, whatever the session says", async () => {
    const c = new WalletController();
    await c.init();
    await c.create("pw");
    await c.connectDapp("https://app.example");

    for (const m of ["signTransaction", "signAuthEntry", "signMessage"]) {
      const res = (await c.sep43("https://app.example", m, ["AAAA"])) as {
        error?: { message: string };
      };
      expect(res.error, `${m} must refuse`).toBeDefined();
    }
  });

  it("reveals nothing to an origin that never connected", async () => {
    const c = new WalletController();
    await c.init();
    await c.create("pw");

    const res = (await c.sep43("https://evil.example", "getAddress", [])) as {
      error?: { message: string };
      address?: string;
    };
    expect(res.address).toBeUndefined();
    expect(res.error).toBeDefined();
  });
});
