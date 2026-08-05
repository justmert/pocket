// `recoverFromMnemonic` racing another install.
//
// It lives here rather than beside the other race tests because `tests/auth` has
// an owner and this is the failure-and-recovery slice: the loss it protects
// against is a wallet erased and not restored, which is unrecoverable.
//
// WHY THE OBVIOUS TEST DOES NOT WORK, because two people have now written it and
// watched it stay green with the serialisation removed. The natural assertion is
// COHERENCE: whatever the interleaving, one password opens the vault afterwards
// and the address beside it matches the seed inside. That holds even when the
// race happens, so it cannot pin anything.
//
// It holds because the damaging interleaving produces a perfectly coherent
// wallet. It is just the WRONG one:
//
//   1. recovery is authorised (right phrase, matches the stored address)
//   2. recovery calls `erase()`
//   3. `create` from another tab reads "does a vault exist?", finds none
//      because step 2 just removed it, and installs a brand new seed
//   4. recovery's `doImport` finds a vault and refuses
//
// The device now holds a coherent wallet nobody asked for, the user's own wallet
// is gone, and the recovery they authorised reported failure. So the property to
// assert is not coherence. It is:
//
//   an authorised recovery either completes, or leaves the wallet it was asked
//   to restore exactly where it was. Never erased and replaced by a stranger's.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../../src/lib/polyfill";

const store = new Map<string, unknown>();

/**
 * The damaging interleaving, forced rather than hoped for.
 *
 * The natural schedule does not produce it: `mnemonicToSeed` is slow PBKDF2, so
 * recovery is usually still deriving when the other caller has finished, and
 * the harmful order never comes up. Running the test and watching it pass says
 * nothing, which is exactly what two of us found.
 *
 * So the guard read is HELD. Any caller asking "does a vault already exist?"
 * waits until the erase has happened, which is the one window where the answer
 * is misleading. It is released by the erase itself, not by a timer, so there
 * is no sleep and no timing assumption. If the erase has already happened the
 * read is not held at all, which is what keeps the serialised case from
 * deadlocking on its own re-import.
 *
 * This chooses between two schedules the browser could legally produce. It does
 * not change what the wallet does in either.
 */
let holdGuardUntilErase = false;
let erased = false;
let releaseHeld: (() => void) | null = null;

vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | string[] | null) => {
        if (k === null) return Object.fromEntries(store);
        if (Array.isArray(k)) {
          const out: Record<string, unknown> = {};
          for (const key of k) if (store.has(key)) out[key] = store.get(key);
          return out;
        }
        if (holdGuardUntilErase && k === "pocket.vault" && !erased) {
          await new Promise<void>((r) => (releaseHeld = r));
        }
        return store.has(k) ? { [k]: store.get(k) } : {};
      },
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string | string[]) => {
        const keys = Array.isArray(k) ? k : [k];
        for (const key of keys) store.delete(key);
        if (keys.includes("pocket.vault")) {
          erased = true;
          releaseHeld?.();
          releaseHeld = null;
        }
      },
    },
  },
});

const { WalletController } = await import("../../src/core/controller");
const { clearSession } = await import("../../src/core/session");
const { KEYS } = await import("../../src/lib/storage");
const { mnemonicToSeed } = await import("@scure/bip39");
const { deriveEd25519 } = await import("../../src/core/keys/sep5");

const PASSWORD = "correct horse battery staple";

beforeEach(() => {
  store.clear();
  clearSession();
  holdGuardUntilErase = false;
  erased = false;
  releaseHeld = null;
});
afterEach(() => {
  holdGuardUntilErase = false;
  releaseHeld?.();
  clearSession();
});

const storedAddress = () => store.get(KEYS.publicAddress) as string | undefined;

async function addressOf(mnemonic: string): Promise<string> {
  const seed = new Uint8Array(await mnemonicToSeed(mnemonic));
  return deriveEd25519(seed as never, 0).publicKey();
}

/** An installed wallet, then locked: the state recovery is reached from. */
async function installedAndLocked() {
  const c = new WalletController();
  await c.init();
  const { mnemonic, address } = await c.create(PASSWORD);
  await c.lock();
  return { controller: c, mnemonic, address };
}

describe("an authorised recovery is never turned into a stranger's wallet", () => {
  it("leaves the recovered wallet installed when create races it", async () => {
    const { controller, mnemonic, address } = await installedAndLocked();
    holdGuardUntilErase = true;

    const [recovery, creation] = await Promise.allSettled([
      controller.recoverFromMnemonic(mnemonic, "a brand new password"),
      controller.create("another tab's password"),
    ]);

    // The whole point. Whichever of the two won, the wallet on this device must
    // be the one the recovery was authorised for. A `create` that slipped into
    // the window between the erase and the re-import would leave a coherent
    // wallet here that the user never asked for and cannot recover from.
    expect(
      storedAddress(),
      "the device holds a wallet the authorised recovery did not install",
    ).toBe(address);

    // And nobody was told something untrue about it.
    if (recovery.status === "fulfilled") expect(recovery.value).toBe(address);
    if (creation.status === "fulfilled") {
      expect(await addressOf(creation.value.mnemonic)).toBe(storedAddress());
    }
  });

  it("never leaves the device with no wallet at all", async () => {
    // The erase is the destructive half and it happens first. An interleaving
    // that lands between the erase and the re-import leaves nothing installed,
    // and the phrase is the only way back.
    const { controller, mnemonic } = await installedAndLocked();

    await Promise.allSettled([
      controller.recoverFromMnemonic(mnemonic, "pw one"),
      controller.create("pw two"),
      controller.recoverFromMnemonic(mnemonic, "pw three"),
    ]);

    expect(store.has(KEYS.vaultHeader), "the device was left with no vault").toBe(true);
    expect(store.has(KEYS.state), "the vault has no state beside it").toBe(true);
    expect(storedAddress()).toBeDefined();
  });

  it("leaves exactly one password able to open what is installed", async () => {
    // Coherence, kept as a companion rather than as the point: it is necessary
    // and, on its own, not sufficient. Both agents who wrote only this watched
    // it stay green with the serialisation removed.
    const { controller, mnemonic, address } = await installedAndLocked();

    await Promise.allSettled([
      controller.recoverFromMnemonic(mnemonic, "pw one"),
      controller.create("pw two"),
    ]);

    clearSession();
    const fresh = new WalletController();
    await fresh.init();
    const opened = await fresh
      .unlock("pw one")
      .catch(() => fresh.unlock("pw two"))
      .catch(() => fresh.unlock(PASSWORD))
      .catch(() => null);

    expect(opened, "no password opens the installed vault").not.toBeNull();
    expect(opened!.address).toBe(storedAddress());
    expect(opened!.address).toBe(address);
  });

  it("keeps the wallet when two recoveries of the same phrase collide", async () => {
    // The case that was judged harmless because both converge on one seed. That
    // reasoning is right, and it is asserted rather than assumed.
    const { controller, mnemonic, address } = await installedAndLocked();

    await Promise.allSettled([
      controller.recoverFromMnemonic(mnemonic, "pw one"),
      controller.recoverFromMnemonic(mnemonic, "pw two"),
    ]);

    expect(storedAddress()).toBe(address);
    expect(store.has(KEYS.vaultHeader)).toBe(true);
  });

  it("keeps the wallet when an import races the recovery", async () => {
    const { controller, mnemonic, address } = await installedAndLocked();
    const { generateMnemonic } = await import("@scure/bip39");
    const { wordlist } = await import("@scure/bip39/wordlists/english.js");

    await Promise.allSettled([
      controller.recoverFromMnemonic(mnemonic, "pw one"),
      controller.import("pw two", generateMnemonic(wordlist, 256)),
    ]);

    expect(storedAddress(), "an import landed in the window the recovery opened").toBe(address);
  });
});
