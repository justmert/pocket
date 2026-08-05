// Check-then-act, on the three paths that install a seed.
//
// The calibration case: `create` read "does a vault exist?", found none, and
// wrote. Two popup tabs both passed that guard, both installed a seed, and both
// were shown a recovery phrase under the words "the only way to recover your
// wallet". Last write won, so one of those two phrases owned nothing and its
// holder had no way to find out, because the phrase is shown exactly once. Fixed
// by serialising `create` through `exclusive()`.
//
// The popup is an ordinary extension page and opens in a tab, so two of them at
// once is a user, not a synthetic race. There is ONE controller in the worker,
// so the queue is the only thing separating them.
//
// `create` was fixed. `import` and `recoverFromMnemonic` have the same
// check-then-act shape and were judged harmless because "they converge on the
// same seed". This spec tests that judgement rather than repeating it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import type { WalletStatus } from "../../src/core/messages";
import "../../src/lib/polyfill";
import { installChrome } from "./_harness/chrome";

const chrome = installChrome();

const { WalletController, WalletExistsError } = await import("../../src/core/controller");
const { clearSession } = await import("../../src/core/session");
const { KEYS } = await import("../../src/lib/storage");
const { generateMnemonic, mnemonicToSeed } = await import("@scure/bip39");
const { wordlist } = await import("@scure/bip39/wordlists/english.js");
const { deriveEd25519 } = await import("../../src/core/keys/sep5");

const PASSWORD = "correct horse battery staple";

beforeEach(() => {
  chrome.local.clear();
  chrome.session.clear();
  clearSession();
});
afterEach(() => {
  chrome.beforeLocalWrite = undefined;
  chrome.afterLocalRemove = undefined;
  clearSession();
});

/** The address a phrase owns, so a claim can be checked against the wallet. */
async function addressOf(mnemonic: string): Promise<string> {
  const seed = new Uint8Array(await mnemonicToSeed(mnemonic));
  return deriveEd25519(seed as never, 0).publicKey();
}

/** Whatever wallet is actually installed, identified without a session. */
function storedAddress(): string | undefined {
  return chrome.local.get(KEYS.publicAddress) as string | undefined;
}

/**
 * A note on scheduling, because it decided how these tests are written.
 *
 * I first tried to force the interleaving with hooks on the storage shim,
 * pausing one caller until the other had passed its guard. Both attempts made
 * the tests WORSE, and instructively so: adding an await to the read or the
 * write path is itself a scheduling change, and under the new schedule the
 * second caller's guard correctly refused. The observer removed the thing it
 * was trying to observe.
 *
 * The natural schedule already produces the race every time, and for a reason
 * rather than by luck: both callers await the same three things in the same
 * order (the guard read, then scrypt inside `createVault`, then
 * `mnemonicToSeed`), so they arrive at the write in lockstep having both passed
 * a guard that was true when each read it. Ten consecutive runs, recorded in
 * the report, produce the identical failing set.
 *
 * So these run unhooked. If they ever go quiet, that is a signal to check
 * whether the schedule moved rather than whether the bug was fixed, and the
 * fix is to serialise the path, at which point they should refuse cleanly.
 */

describe("two tabs creating a wallet at once", () => {
  it("hands out exactly one recovery phrase", async () => {
    const c = new WalletController();
    await c.init();

    const results = await Promise.allSettled([c.create("tab one"), c.create("tab two")]);
    const ok = results.filter((r) => r.status === "fulfilled");
    expect(ok).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(
      (results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason,
    ).toBeInstanceOf(WalletExistsError);
  });

  it("the phrase it handed out owns the wallet that is installed", async () => {
    const c = new WalletController();
    await c.init();

    const results = await Promise.allSettled([
      c.create("one"),
      c.create("two"),
      c.create("three"),
      c.create("four"),
    ]);
    const winners = results.filter(
      (r): r is PromiseFulfilledResult<{ mnemonic: string; address: string }> =>
        r.status === "fulfilled",
    );
    expect(winners).toHaveLength(1);
    // The claim the backup screen makes has to be true of the stored wallet.
    expect(await addressOf(winners[0]!.value.mnemonic)).toBe(storedAddress());
    expect(winners[0]!.value.address).toBe(storedAddress());
  });

  it("survives many simultaneous attempts without installing two seeds", async () => {
    const c = new WalletController();
    await c.init();
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) => c.create(`tab ${i}`)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(true);
  });
});

describe("two tabs importing DIFFERENT phrases at once", () => {
  // The judgement to test. "They converge on the same seed" is true when both
  // tabs carry the SAME phrase. Two tabs, two different phrases, is a different
  // question and the user has typed both, so both look legitimate to them.
  it("installs one wallet and does not tell the other tab it succeeded", async () => {
    const c = new WalletController();
    await c.init();
    const [a, b] = [generateMnemonic(wordlist, 256), generateMnemonic(wordlist, 256)];

    const results = await Promise.allSettled([c.import("tab one", a), c.import("tab two", b)]);
    const fulfilled = results.filter(
      (r): r is PromiseFulfilledResult<{ address: string }> => r.status === "fulfilled",
    );

    // Whatever the outcome, a tab told "your wallet is at G..." must be telling
    // the truth about the wallet this device now holds. Two different successes
    // means one of them is a lie the user cannot detect.
    for (const f of fulfilled) {
      expect(f.value.address).toBe(storedAddress());
    }
  });

  it("leaves a vault whose stored address matches the seed it holds", async () => {
    // `installSeed` writes address, then header, then state. Interleaved, the
    // address can come from one phrase and the vault from the other, and that
    // combination is precisely what `recoverFromMnemonic` refuses to act on.
    const c = new WalletController();
    await c.init();
    const [a, b] = [generateMnemonic(wordlist, 256), generateMnemonic(wordlist, 256)];
    await Promise.allSettled([c.import("one", a), c.import("two", b)]);

    clearSession();
    const fresh = new WalletController();
    await fresh.init();
    // Whichever password won, one of them opens the vault, and the seed inside
    // must derive the address stored beside it.
    const opened = await fresh
      .unlock("one")
      .catch(() => fresh.unlock("two"))
      .catch(() => null);
    expect(opened, "neither password opened the installed vault").not.toBeNull();
    expect(opened!.address).toBe(storedAddress());
  });
});

describe("create racing import", () => {
  // The most reachable pairing of the three: one tab on "Create a new wallet",
  // another on "I have a recovery phrase". Both are first-run screens, both are
  // one click from the splash, and only one of the two paths is serialised.
  it("never shows a generated phrase for a wallet that was not installed", async () => {
    const c = new WalletController();
    await c.init();
    const theirs = generateMnemonic(wordlist, 256);

    const [created, imported] = await Promise.allSettled([
      c.create("creating tab"),
      c.import("importing tab", theirs),
    ]);

    if (created.status === "fulfilled") {
      // The backup screen is about to say this phrase is the only way to
      // recover the wallet. It has to own the wallet that exists.
      expect(await addressOf(created.value.mnemonic)).toBe(storedAddress());
    }
    if (imported.status === "fulfilled") {
      expect(imported.value.address).toBe(storedAddress());
    }
    // And they cannot both be right.
    expect([created, imported].filter((r) => r.status === "fulfilled").length).toBeLessThanOrEqual(
      1,
    );
  });
});

describe("the write phases cannot interleave, which is the property rather than a symptom", () => {
  // Everything above asserts a CONSEQUENCE of the race: a tab told the wrong
  // address, a phrase that owns nothing. Those are the reachable harms, and
  // they depend on the schedule, so passing them means "this schedule did not
  // produce the harm", not "the harm is impossible".
  //
  // This block asserts the property itself, off the storage boundary, and it
  // does not depend on the schedule at all. `installSeed` writes exactly three
  // keys, always in this order:
  //
  //     pocket.address -> pocket.state -> pocket.vault
  //
  // The HEADER is last, and that is the commit point: `status().initialised` is
  // `header !== undefined` and `import` refuses when a vault exists, so once
  // the header lands the wallet claims to exist and everything needed to open
  // it must already be on disk. Written second, a failed third write left a
  // vault whose seed was never stored, which no password opens and no import
  // replaces.
  //
  // and the dangerous interleaving is a header from one install beside state
  // from another: that header's DEK cannot decrypt that state, so no password
  // opens the vault and no phrase repairs it, because the phrase reinstalls
  // over a vault that still exists. A wrong address on screen is recoverable.
  // That is not.
  //
  // If installs are serialised, N concurrent callers produce exactly ONE such
  // triple. If they are not, the triples interleave, and this sees it whether
  // or not the run happened to produce a bricked vault.
  //
  // The hook only records. It returns undefined, so it adds no microtask and
  // does not move the schedule it is measuring.
  const INSTALL_KEYS: string[] = [KEYS.publicAddress, KEYS.state, KEYS.vaultHeader];

  function recordInstallWrites(): string[] {
    const order: string[] = [];
    chrome.beforeLocalWrite = (key) => {
      if (INSTALL_KEYS.includes(key)) order.push(key);
    };
    return order;
  }

  /** The three writes of one install, in order, and nothing woven through them. */
  const ONE_INSTALL = [KEYS.publicAddress, KEYS.state, KEYS.vaultHeader];

  it("two imports of different phrases produce one uninterrupted install", async () => {
    const order = recordInstallWrites();
    const c = new WalletController();
    await c.init();
    const [a, b] = [generateMnemonic(wordlist, 256), generateMnemonic(wordlist, 256)];

    await Promise.allSettled([c.import("tab one", a), c.import("tab two", b)]);
    expect(order).toEqual(ONE_INSTALL);
  });

  it("create racing import produces one uninterrupted install", async () => {
    const order = recordInstallWrites();
    const c = new WalletController();
    await c.init();
    await Promise.allSettled([
      c.create("creating tab"),
      c.import("importing tab", generateMnemonic(wordlist, 256)),
    ]);
    expect(order).toEqual(ONE_INSTALL);
  });

  it("eight callers at once still produce one uninterrupted install", async () => {
    // Eight, because two callers can look serialised by luck and eight cannot.
    const order = recordInstallWrites();
    const c = new WalletController();
    await c.init();
    const phrases = Array.from({ length: 4 }, () => generateMnemonic(wordlist, 256));
    await Promise.allSettled([
      ...Array.from({ length: 4 }, (_, i) => c.create(`create ${i}`)),
      ...phrases.map((p, i) => c.import(`import ${i}`, p)),
    ]);
    expect(order).toEqual(ONE_INSTALL);
  });

  it("recovery erases and reinstalls without another install cutting in", async () => {
    // Recovery is erase-then-import, and the erase is what makes an interleave
    // here worse than anywhere else: a create landing inside that window
    // installs a wallet the recovery then overwrites, and the create tab has
    // already shown its phrase.
    const c = new WalletController();
    await c.init();
    const { mnemonic } = await c.create(PASSWORD);
    await c.lock();

    const order = recordInstallWrites();
    await Promise.allSettled([
      c.recoverFromMnemonic(mnemonic, "new password"),
      c.create("racing tab"),
    ]);
    // Recovery reinstalls, and the racing create is refused, so exactly one
    // triple again. Two would mean the erase window was open to a stranger.
    expect(order).toEqual(ONE_INSTALL);
  });

  it("holds the queue across its own erase, not just up to it", async () => {
    // This test exists because the mutation that should have falsified the one
    // above turned NOTHING red. Unserialising `recoverFromMnemonic` changes
    // nothing under the natural schedule, because a racing `create` reads the
    // vault header and is refused BEFORE the erase ever happens. The guard was
    // shipping with no test that could fail.
    //
    // The window that matters is between the erase and the reinstall, when the
    // device holds no wallet at all and every vault-exists guard says yes. So
    // the racing caller is started when that window OPENS, which is a schedule
    // the browser is free to produce and the one the guard exists for. The hook
    // only records; it returns nothing and suspends nothing.
    const c = new WalletController();
    await c.init();
    const { mnemonic, address } = await c.create(PASSWORD);
    await c.lock();

    const order = recordInstallWrites();
    let erased!: () => void;
    const eraseWindowOpen = new Promise<void>((r) => (erased = r));
    chrome.afterLocalRemove = (keys) => {
      if (keys.includes(KEYS.vaultHeader)) erased();
    };

    const recovering = c.recoverFromMnemonic(mnemonic, "new password");
    await eraseWindowOpen;
    const racing = c.create("racing tab");
    await Promise.allSettled([recovering, racing]);

    expect(order, "a second install got into the erase window").toEqual(ONE_INSTALL);
    // And it is the RECOVERED wallet that survived. Recovery proved it owns
    // this account; the racing tab proved nothing. If the racing tab's address
    // is the one on disk, recovery erased a wallet and then lost the device to
    // somebody who could not have authorised the erase.
    expect(storedAddress(), "the racing tab's wallet is the one on the device").toBe(address);
  });

  it("the vault the winner left behind actually opens", async () => {
    // The other half of the property. "One install happened" is only worth
    // asserting if that install is coherent, so open it with the winner's
    // password and check the seed inside derives the address stored beside it.
    const c = new WalletController();
    await c.init();
    const [a, b] = [generateMnemonic(wordlist, 256), generateMnemonic(wordlist, 256)];
    const passwords = ["tab one", "tab two"];
    await Promise.allSettled([c.import(passwords[0]!, a), c.import(passwords[1]!, b)]);

    clearSession();
    const fresh = new WalletController();
    await fresh.init();
    // `unlock` answers with the full status, whose `address` is optional. It
    // was being typed as `{ address: string }`, so the assertion below read a
    // field TypeScript had been told could not be missing and nothing checked
    // this file.
    const opened = await passwords.reduce<Promise<WalletStatus | null>>(
      async (acc, pw) => (await acc) ?? fresh.unlock(pw).catch(() => null),
      Promise.resolve(null),
    );
    expect(opened, "neither password opened the installed vault").not.toBeNull();
    expect(opened!.address, "an opened vault must report the address it holds").toBe(
      storedAddress(),
    );
  });
});

describe("recoverFromMnemonic racing an install", () => {
  it("does not erase a wallet installed while it was checking", async () => {
    // Recovery erases and then re-imports. Its authorisation is a comparison
    // against the stored address, so anything that changes that address between
    // the check and the erase is authorising against a wallet that is gone.
    const c = new WalletController();
    await c.init();
    const { mnemonic, address } = await c.create(PASSWORD);
    await c.lock();

    const [recovered] = await Promise.allSettled([
      c.recoverFromMnemonic(mnemonic, "new password"),
      c.create("racing tab"),
    ]);

    // Whatever happened, the device must hold one wallet and its address must
    // be the one whoever succeeded was told about.
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(true);
    if (recovered.status === "fulfilled") {
      expect(recovered.value).toBe(address);
      expect(storedAddress()).toBe(address);
    }
  });

  it("does not lose the openings of a wallet it refused to recover", async () => {
    const c = new WalletController();
    await c.init();
    await c.create(PASSWORD);
    await c.lock();

    const strangers = generateMnemonic(wordlist, 256);
    await Promise.allSettled([
      c.recoverFromMnemonic(strangers, "attacker"),
      c.recoverFromMnemonic(strangers, "attacker"),
      c.recoverFromMnemonic(strangers, "attacker"),
    ]);
    expect(chrome.local.has(KEYS.vaultHeader)).toBe(true);
    expect(chrome.local.has(KEYS.state)).toBe(true);
  });
});
