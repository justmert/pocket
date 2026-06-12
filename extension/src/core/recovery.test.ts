// The forgotten-password route, and the erase it depends on.
//
// The property that matters: erasing must take the openings with it. A new
// vault gets a fresh random DEK, so an opening blob that survives is
// undecryptable forever, and re-importing the same mnemonic reproduces the same
// storage key and hits that blob rather than a clean slate.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";

// In-memory chrome.storage.local. `get(null)` returns everything, which is how
// the real API enumerates and how the openings sweep finds its keys.
const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) =>
        k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string) => void store.delete(k),
    },
  },
});

const { WalletController, RecoveryError } = await import("./controller");
const { KEYS, readLocal, writeLocal, openingKeys } = await import("../lib/storage");

/** A real phrase from the wallet's own generator, never a transcribed one. */
async function freshWallet(password: string) {
  const c = new WalletController();
  await c.init();
  const { mnemonic, address } = await c.create(password);
  return { c, mnemonic, address };
}

describe("erase and restore", () => {
  beforeEach(() => {
    store.clear();
  });

  it("records the address in the clear so a locked wallet can still be identified", async () => {
    const { address } = await freshWallet("correct horse battery staple");
    expect(await readLocal<string>(KEYS.publicAddress)).toBe(address);
  });

  it("refuses a phrase belonging to a different wallet", async () => {
    const { c } = await freshWallet("correct horse battery staple");
    // A second, unrelated wallet's phrase, generated the same way.
    store.clear();
    const other = (await freshWallet("another")).mnemonic;
    store.clear();
    await c.create("correct horse battery staple");

    await expect(c.recoverFromMnemonic(other, "new password here")).rejects.toBeInstanceOf(
      RecoveryError,
    );
    // The wallet it refused to erase must still be there.
    expect(await readLocal(KEYS.vaultHeader)).toBeDefined();
  });

  it("refuses a phrase that is not a valid mnemonic", async () => {
    const { c } = await freshWallet("correct horse battery staple");
    await expect(c.recoverFromMnemonic("not a real phrase at all", "pw")).rejects.toBeInstanceOf(
      RecoveryError,
    );
  });

  it("restores the same address under a new password", async () => {
    const { c, mnemonic, address } = await freshWallet("correct horse battery staple");
    c.lock();
    expect(await c.recoverFromMnemonic(mnemonic, "a different password now")).toBe(address);

    // The new password must work, and only the new one.
    c.lock();
    await expect(c.unlock("correct horse battery staple")).rejects.toThrow();
    await expect(c.unlock("a different password now")).resolves.toBeDefined();
  });

  it("takes every openings key with it, across deployments and accounts", async () => {
    const { c, mnemonic } = await freshWallet("correct horse battery staple");
    await writeLocal(`${KEYS.openings}.CTOKEN1.GABC`, { v: 1, iv: "x", ct: "y" });
    await writeLocal(`${KEYS.openings}.CTOKEN2.GDEF`, { v: 1, iv: "x", ct: "y" });
    expect(await openingKeys()).toHaveLength(2);

    await c.recoverFromMnemonic(mnemonic, "a different password now");

    // Nothing may survive: a stale blob is undecryptable under the new DEK and
    // would surface as a permanent, unexplained failure of the private pocket.
    expect(await openingKeys()).toHaveLength(0);
  });

  it("reset also clears the openings, not just the vault", async () => {
    const { c } = await freshWallet("correct horse battery staple");
    await writeLocal(`${KEYS.openings}.CTOKEN1.GABC`, { v: 1, iv: "x", ct: "y" });

    await c.reset("correct horse battery staple");

    expect(await openingKeys()).toHaveLength(0);
    expect(await readLocal(KEYS.vaultHeader)).toBeUndefined();
    expect(await readLocal(KEYS.publicAddress)).toBeUndefined();
  });

  it("reset still refuses without the password", async () => {
    const { c } = await freshWallet("correct horse battery staple");
    await expect(c.reset("wrong password")).rejects.toThrow();
    expect(await readLocal(KEYS.vaultHeader)).toBeDefined();
  });
});
