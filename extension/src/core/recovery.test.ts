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
      remove: async (k: string | string[]) => {
        // chrome.storage.local.remove accepts one key OR an array. A mock that
        // only handles the string form silently drops a multi-key erase.
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
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

/**
 * The authorisation on the erase path, which must fail CLOSED.
 *
 * `recoverFromMnemonic` is the one destructive operation reachable while
 * locked, so the attacker to beat is someone holding the device without the
 * password. It was guarded by `if (existing)`, which meant that when the stored
 * address was absent there was no check at all and any valid BIP-39 phrase
 * erased the vault and every confidential opening.
 */
describe("erase authorisation with no stored address", () => {
  beforeEach(() => {
    store.clear();
  });

  it("refuses a stranger's phrase rather than erasing the wallet", async () => {
    const { c } = await freshWallet("correct horse battery staple");
    const header = await readLocal(KEYS.vaultHeader);

    // An install predating the address key, or one that crashed between the
    // two writes in installSeed.
    store.delete(KEYS.publicAddress);

    // A phrase for an entirely different wallet, generated the same way.
    const other = new WalletController();
    await other.init();
    const stray = (await (async () => {
      const s = new Map(store);
      store.clear();
      const { mnemonic } = await other.create("someone else");
      store.clear();
      for (const [k, v] of s) store.set(k, v);
      return mnemonic;
    })()) as string;

    await expect(c.recoverFromMnemonic(stray, "attacker password")).rejects.toBeInstanceOf(
      RecoveryError,
    );
    // The vault and its openings are still here. Before the fix this erased
    // both and re-keyed the device to the attacker's phrase.
    expect(await readLocal(KEYS.vaultHeader)).toEqual(header);
  });

  it("refuses even the CORRECT phrase, because it cannot tell that it is correct", async () => {
    const { c, mnemonic } = await freshWallet("correct horse battery staple");
    store.delete(KEYS.publicAddress);
    await expect(c.recoverFromMnemonic(mnemonic, "a new password")).rejects.toBeInstanceOf(
      RecoveryError,
    );
    expect(await readLocal(KEYS.vaultHeader)).toBeDefined();
  });

  it("works again once an unlock has back-filled the address", async () => {
    const { c, mnemonic, address } = await freshWallet("correct horse battery staple");
    store.delete(KEYS.publicAddress);

    // The owner proves the password. That is what authorises writing the
    // address, since it is derived from the seed the vault just yielded.
    c.lock();
    await c.unlock("correct horse battery staple");
    expect(await readLocal<string>(KEYS.publicAddress)).toBe(address);

    // A permanent dead end has become a one-unlock migration.
    expect(await c.recoverFromMnemonic(mnemonic, "a new password")).toBe(address);
  });

  it("writes the address before the vault, so no crash can produce the unguarded state", async () => {
    // The dangerous half-written state is "a vault exists but its address does
    // not", because that is the one the erase path cannot authorise against.
    const order: string[] = [];
    const realSet = chrome.storage.local.set;
    chrome.storage.local.set = async (o: Record<string, unknown>) => {
      order.push(...Object.keys(o));
      return realSet(o);
    };
    try {
      await freshWallet("correct horse battery staple");
    } finally {
      chrome.storage.local.set = realSet;
    }
    expect(order.indexOf(KEYS.publicAddress)).toBeLessThan(order.indexOf(KEYS.vaultHeader));
  });
});
