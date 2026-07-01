// The six operations the lock lets through, and the guard each one carries
// instead.
//
// This is the actual argument. `dispatch.ts` says it plainly: "the lock is not
// the guard. An operation belongs here only when it would still be safe with the
// lock removed entirely." Every test below runs with the wallet LOCKED, which is
// the lock removed as far as these six are concerned, and asks whether the
// operation's own guard holds.
//
// The attacker to beat is someone holding the unlocked device without the
// password. Not a network attacker, not a malicious page: the manifest keeps
// those out. Someone who picked up a phone.
//
// A refusal must also be INERT. "It refused" is not enough if it erased the
// vault on the way, so every refusal below is followed by a check that the
// wallet, its address and its openings are all still there.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "../../src/lib/polyfill";
import { installChrome } from "./_harness/chrome";

const chrome = installChrome();

const { WalletController, WalletExistsError, RecoveryError } = await import(
  "../../src/core/controller"
);
const { WrongPasswordError } = await import("../../src/core/vault/vault");
const { clearSession, getSession } = await import("../../src/core/session");
const { KEYS, openingKey } = await import("../../src/lib/storage");
const { generateMnemonic } = await import("@scure/bip39");
const { wordlist } = await import("@scure/bip39/wordlists/english.js");
const { sealPayload } = await import("../../src/core/vault/vault");
const { describeError } = await import("../../src/core/dispatch");

const PASSWORD = "correct horse battery staple";
const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";

beforeEach(() => {
  chrome.local.clear();
  chrome.session.clear();
  clearSession();
});
afterEach(() => clearSession());

/** A wallet on disk, with an opening blob, then locked. The realistic target. */
async function installedAndLocked() {
  const c = new WalletController();
  await c.init();
  const { mnemonic, address } = await c.create(PASSWORD);
  const session = getSession()!;
  // Openings are the irreplaceable part: they are not derivable from the
  // phrase, so a wrongful erase destroys funds the phrase cannot bring back.
  chrome.local.set(
    openingKey(TOKEN, address),
    await sealPayload(session.dek, {
      spendable: { value: "12345", randomness: "678" },
      receiving: { value: "0", randomness: "0" },
      syncedThrough: 42,
    }),
  );
  c.lock();
  return { controller: c, mnemonic, address };
}

/** Everything a wrongful erase would take. */
function whatSurvives() {
  return {
    vault: chrome.local.has(KEYS.vaultHeader),
    state: chrome.local.has(KEYS.state),
    address: chrome.local.has(KEYS.publicAddress),
    openings: [...chrome.local.keys()].filter((k) => k.startsWith(`${KEYS.openings}.`)).length,
  };
}

const INTACT = { vault: true, state: true, address: true, openings: 1 };

describe("create: the guard is that a vault already exists", () => {
  it("refuses to overwrite an installed wallet, while locked", async () => {
    const { controller } = await installedAndLocked();
    await expect(controller.create("attacker password")).rejects.toBeInstanceOf(WalletExistsError);
    expect(whatSurvives()).toEqual(INTACT);
  });

  it("refuses through a fresh controller, so the guard is on disk not in memory", async () => {
    // A restarted worker is the normal case: MV3 evicts it constantly. A guard
    // that lived in the instance would be gone by the time it mattered.
    await installedAndLocked();
    const fresh = new WalletController();
    await fresh.init();
    await expect(fresh.create("attacker password")).rejects.toBeInstanceOf(WalletExistsError);
    expect(whatSurvives()).toEqual(INTACT);
  });

  it("still allows the first create on a genuinely empty device", async () => {
    const c = new WalletController();
    await c.init();
    const { address } = await c.create(PASSWORD);
    expect(address).toMatch(/^G[A-Z2-7]{55}$/);
  });
});

describe("import: the same guard, for the same reason", () => {
  it("refuses to replace an installed wallet's seed, while locked", async () => {
    const { controller } = await installedAndLocked();
    const strangers = generateMnemonic(wordlist, 256);
    await expect(controller.import("attacker password", strangers)).rejects.toBeInstanceOf(
      WalletExistsError,
    );
    expect(whatSurvives()).toEqual(INTACT);
  });

  it("refuses through a fresh controller too", async () => {
    await installedAndLocked();
    const fresh = new WalletController();
    await fresh.init();
    await expect(
      fresh.import("attacker password", generateMnemonic(wordlist, 256)),
    ).rejects.toBeInstanceOf(WalletExistsError);
    expect(whatSurvives()).toEqual(INTACT);
  });

  it("refuses an invalid phrase on an empty device rather than installing nothing", async () => {
    const c = new WalletController();
    await c.init();
    await expect(c.import(PASSWORD, "not a real recovery phrase at all")).rejects.toThrow(
      /not a valid recovery phrase/i,
    );
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(false);
  });
});

describe("recoverFromMnemonic: the one destructive path reachable while locked", () => {
  // It erases the vault AND every confidential opening, without a password. So
  // its guard has to carry the whole weight, and it has to fail CLOSED.

  it("refuses a phrase that derives a different wallet", async () => {
    const { controller } = await installedAndLocked();
    const strangers = generateMnemonic(wordlist, 256);
    await expect(controller.recoverFromMnemonic(strangers, "new password")).rejects.toBeInstanceOf(
      RecoveryError,
    );
    expect(whatSurvives()).toEqual(INTACT);
  });

  it("says whose fault it is, without naming the address it expected", async () => {
    const { controller, address } = await installedAndLocked();
    const said = await controller
      .recoverFromMnemonic(generateMnemonic(wordlist, 256), "new password")
      .then(
        () => "erased",
        (e) => describeError(e),
      );
    expect(said).toMatch(/belongs to a different wallet/i);
    expect(said).not.toContain(address);
  });

  it("refuses an invalid phrase", async () => {
    const { controller } = await installedAndLocked();
    await expect(controller.recoverFromMnemonic("word ".repeat(24), PASSWORD)).rejects.toBeInstanceOf(
      RecoveryError,
    );
    expect(whatSurvives()).toEqual(INTACT);
  });

  it("refuses an empty phrase", async () => {
    const { controller } = await installedAndLocked();
    await expect(controller.recoverFromMnemonic("", PASSWORD)).rejects.toBeInstanceOf(RecoveryError);
    expect(whatSurvives()).toEqual(INTACT);
  });

  // The calibration case, and the reason this whole spec exists. The check used
  // to be wrapped in `if (existing)`, so when the stored address was ABSENT
  // there was no check at all: any valid BIP-39 phrase erased the vault and
  // every opening, while locked, with no password. Two ways to reach an absent
  // address, both real: a vault created before the address key existed, and the
  // window inside `installSeed` between its three writes.
  it("refuses ANY phrase when there is no stored address to check against", async () => {
    const { controller } = await installedAndLocked();
    chrome.local.delete(KEYS.publicAddress);

    const strangers = generateMnemonic(wordlist, 256);
    await expect(controller.recoverFromMnemonic(strangers, "attacker password")).rejects.toBeInstanceOf(
      RecoveryError,
    );
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(true);
    expect(chrome.local.has(KEYS.state)).toBe(true);
    expect([...chrome.local.keys()].filter((k) => k.startsWith(`${KEYS.openings}.`))).toHaveLength(1);
  });

  it("refuses even the CORRECT phrase when there is no stored address", async () => {
    // Fails closed means closed. The right phrase is not a way round a check
    // that cannot be performed, because "the right phrase" is exactly what
    // could not be established.
    const { controller, mnemonic } = await installedAndLocked();
    chrome.local.delete(KEYS.publicAddress);
    await expect(controller.recoverFromMnemonic(mnemonic, "new password")).rejects.toBeInstanceOf(
      RecoveryError,
    );
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(true);
  });

  it("tells the user how to get out of that state without losing anything", async () => {
    const { controller, mnemonic } = await installedAndLocked();
    chrome.local.delete(KEYS.publicAddress);
    const said = await controller.recoverFromMnemonic(mnemonic, "new password").then(
      () => "erased",
      (e) => describeError(e),
    );
    expect(said).toMatch(/unlock the wallet once with its password/i);
    expect(said).toMatch(/reinstalling the extension/i);
  });

  it("becomes possible again after one unlock, which back-fills the address", async () => {
    // What makes the refusal a migration rather than a dead end. Getting this
    // far requires the password, so the address written here cannot be planted
    // by anyone who could not have opened the vault anyway.
    const { controller, mnemonic, address } = await installedAndLocked();
    chrome.local.delete(KEYS.publicAddress);

    await controller.unlock(PASSWORD);
    expect(chrome.local.get(KEYS.publicAddress)).toBe(address);

    controller.lock();
    const restored = await controller.recoverFromMnemonic(mnemonic, "a brand new password");
    expect(restored).toBe(address);
  });

  it("accepts the right phrase and restores the same account", async () => {
    const { controller, mnemonic, address } = await installedAndLocked();
    const restored = await controller.recoverFromMnemonic(mnemonic, "a brand new password");
    expect(restored).toBe(address);
    // And the new password is the one that works now.
    controller.lock();
    await expect(controller.unlock("a brand new password")).resolves.toMatchObject({
      locked: false,
    });
  });

  it("destroys the openings when it DOES run, which the user must have been told", async () => {
    // Not a defect: openings are not derivable from the phrase. Pinned because
    // it is the cost of the operation and it must not quietly change.
    const { controller, mnemonic } = await installedAndLocked();
    await controller.recoverFromMnemonic(mnemonic, "a brand new password");
    expect([...chrome.local.keys()].filter((k) => k.startsWith(`${KEYS.openings}.`))).toHaveLength(0);
  });

  it("normalises case and spacing rather than refusing a correct phrase", async () => {
    const { controller, mnemonic, address } = await installedAndLocked();
    const messy = `  ${mnemonic.toUpperCase().split(" ").join("   ")}  `;
    await expect(controller.recoverFromMnemonic(messy, "a brand new password")).resolves.toBe(
      address,
    );
  });
});

describe("unlock: the guard is the password, and only the password", () => {
  it("refuses a wrong password", async () => {
    const { controller } = await installedAndLocked();
    await expect(controller.unlock("wrong")).rejects.toBeInstanceOf(WrongPasswordError);
    expect(getSession()).toBeNull();
  });

  it("says only that the password was wrong", async () => {
    const { controller } = await installedAndLocked();
    const said = await controller.unlock("wrong").then(
      () => "unlocked",
      (e) => describeError(e),
    );
    expect(said).toBe("Wrong password.");
  });

  it("leaves no session behind after a failed attempt", async () => {
    const { controller } = await installedAndLocked();
    for (const attempt of ["", "a", "wrong", PASSWORD.slice(0, -1)]) {
      await controller.unlock(attempt).catch(() => undefined);
      expect(getSession()).toBeNull();
    }
    await expect(controller.unlock(PASSWORD)).resolves.toMatchObject({ locked: false });
  });

  it("refuses to unlock a device with no wallet", async () => {
    const c = new WalletController();
    await c.init();
    await expect(c.unlock(PASSWORD)).rejects.toThrow(/no wallet to unlock/);
  });
});

describe("reset: NOT on the allowlist, and its own guard is the password", () => {
  // Belt and braces. The lock stands in front of it, and it also asks for the
  // password, so the lock being wrong would not by itself destroy a wallet.
  it("refuses a wrong password even when called directly", async () => {
    const { controller } = await installedAndLocked();
    await expect(controller.reset("wrong")).rejects.toBeInstanceOf(WrongPasswordError);
    expect(whatSurvives()).toEqual(INTACT);
  });

  it("erases everything when the password is right", async () => {
    const { controller } = await installedAndLocked();
    await controller.reset(PASSWORD);
    expect(whatSurvives()).toEqual({
      vault: false,
      state: false,
      address: false,
      openings: 0,
    });
  });
});

describe("status and lock reveal nothing and destroy nothing", () => {
  it("status while locked exposes no address and no key material", async () => {
    const { controller } = await installedAndLocked();
    const s = await controller.status();
    expect(s).toMatchObject({ initialised: true, locked: true });
    expect(s.address).toBeUndefined();
    expect(JSON.stringify(s)).not.toMatch(/seed|dek|mnemonic|privateKey/i);
  });

  it("lock is idempotent and destroys nothing on disk", async () => {
    const { controller } = await installedAndLocked();
    controller.lock();
    controller.lock();
    expect(getSession()).toBeNull();
    expect(whatSurvives()).toEqual(INTACT);
  });
});
