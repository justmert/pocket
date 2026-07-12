// Does what is on disk match what the screen said?
//
// Every test here reads the artefact the wallet left behind and opens it with
// nothing but the user's password, then compares. Nothing asks the wallet what
// it stored: a wallet that displays from the same variable it persists agrees
// with itself no matter how wrong both are.
import { test, expect, Wallet } from "../support/fixtures";
import { ADDRESS_RE } from "../support/wallet";
import {
  addressFromMnemonic,
  inspect,
  storage,
  unwrapDek,
  openSealed,
  ADDRESS_KEY,
  STATE_KEY,
  VAULT_KEY,
  INFLIGHT_KEY,
  STAGED_KEY,
  OPENINGS_PREFIX,
  type Sealed,
  type VaultHeader,
} from "./oracle";
import { launch, evictWorker, expectRestored, open, ask, PASSWORD } from "./harness";

/**
 * SEP-0005 test vector 1, published in the standard.
 *
 * The oracle is the only reason any other test in this slice means anything, so
 * it gets checked against a number neither this repo nor this wallet produced.
 * Without this the derivation could be wrong in the same direction as the
 * wallet's and every comparison below would pass while both were broken.
 */
test("the oracle's own derivation matches SEP-0005's published vector", async () => {
  const vector = "illness spike retreat truth genius clock brain pass fit cave bargain toe";
  expect(await addressFromMnemonic(vector)).toBe(
    "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
  );
});

test("the 24 words on screen are the 24 words on disk, and they own the address on the home screen", async ({
  wallet,
  harness,
}) => {
  const shown = await wallet.createWallet(PASSWORD);
  const onScreen = await wallet.revealAddress();
  expect(onScreen).toMatch(ADDRESS_RE);

  const disk = await inspect(harness.popup, PASSWORD);

  // The phrase the user was told to write down is the phrase this device can
  // still be opened with. A wallet that shows one and seals another hands the
  // user twenty-four words that own nothing, under a sentence promising the
  // opposite, and they find out on the day they need them.
  expect(disk.mnemonic.split(/\s+/), "the sealed phrase must be 24 words").toHaveLength(24);
  expect(disk.mnemonic, "the phrase shown must be the phrase sealed").toBe(shown);

  // Three answers about one account, from three places: the screen, the plain
  // `pocket.address` record, and an independent SEP-5 derivation from the
  // sealed phrase. Any two agreeing proves nothing if both come from the same
  // variable, so all three are required to agree.
  expect(disk.address, "the sealed phrase must derive the address on screen").toBe(onScreen);
  expect(disk.storedAddress, "pocket.address must be the address on screen").toBe(onScreen);
});

test("an eviction and a browser restart change nothing on disk, and the wallet comes back off it", async () => {
  const install = await launch();
  let restarted: Awaited<ReturnType<typeof open>> | null = null;
  try {
    const page = await install.popup();
    const w = new Wallet(page);
    const phrase = await w.createWallet(PASSWORD);
    const address = await w.revealAddress();

    const before = JSON.stringify(await storage(page), Object.keys(await storage(page)).sort());

    // MV3 eviction first. The session survives it, restored from the DEK mirror
    // in session storage (RAM), and must not rewrite anything on disk in the
    // process. The browser restart below is what forces the true off-disk read.
    await evictWorker(install.ctx, page);
    await expectRestored(page);
    const afterEviction = JSON.stringify(
      await storage(page),
      Object.keys(await storage(page)).sort(),
    );
    expect(afterEviction, "an eviction must not rewrite anything").toBe(before);

    // Then the whole browser. Same profile directory, new process.
    await install.suspend();
    restarted = await open(install.dir);
    const page2 = await restarted.popup();

    const afterRestart = JSON.stringify(
      await storage(page2),
      Object.keys(await storage(page2)).sort(),
    );
    expect(afterRestart, "a browser restart must not rewrite anything").toBe(before);

    // And what came back off disk is the same wallet, checked with the oracle
    // rather than by asking the wallet.
    const disk = await inspect(page2, PASSWORD);
    expect(disk.mnemonic).toBe(phrase);
    expect(disk.address).toBe(address);
    expect(disk.storedAddress).toBe(address);

    const w2 = new Wallet(page2);
    await expect(w2.lockedNotice()).toBeVisible();
    await w2.unlock(PASSWORD);
    await w2.waitForHome();
    expect(await w2.revealAddress()).toBe(address);
  } finally {
    await restarted?.suspend().catch(() => undefined);
    await install.close();
  }
});

test("a second install of the same phrase gets its own key, so neither device can open the other's records", async ({
  harness,
}) => {
  const w = new Wallet(harness.popup);
  const phrase = await w.createWallet(PASSWORD);
  const first = await storage(harness.popup);

  // The same phrase and the same password on a clean device.
  const second = await launch();
  try {
    const page = await second.popup();
    await new Wallet(page).importPhrase(phrase, PASSWORD);
    const other = await storage(page);

    // Same account, so the same opening-store key would be produced. That is
    // the whole hazard: a fresh vault gets a fresh random DEK, so any blob left
    // behind by the first install is undecryptable forever by the second, and
    // it would sit exactly where the second install looks.
    expect((other[ADDRESS_KEY] as string), "same phrase, same account").toBe(
      first[ADDRESS_KEY] as string,
    );

    const dekA = await unwrapDek(first[VAULT_KEY] as VaultHeader, PASSWORD);
    const dekB = await unwrapDek(other[VAULT_KEY] as VaultHeader, PASSWORD);
    expect(Buffer.from(dekA).toString("hex"), "each install must get its own DEK").not.toBe(
      Buffer.from(dekB).toString("hex"),
    );

    // Not merely different bytes: actually unable to read each other. This is
    // why `erase()` has to take the opening blobs with it.
    await expect(
      openSealed(dekA, other[STATE_KEY] as Sealed),
      "one install's key must not open another's records",
    ).rejects.toThrow();
  } finally {
    await second.close();
  }
});

test("a fresh wallet stores nothing unfinished, and locking writes nothing", async ({
  wallet,
  harness,
}) => {
  await wallet.createWallet(PASSWORD);

  const keys = Object.keys(await storage(harness.popup)).sort();
  // Nothing was submitted, so an in-flight or staged record here would be a
  // record of an operation that never happened, and both of them put a screen
  // in front of the whole wallet on every mount.
  expect(keys, "nothing was submitted, so nothing may be recorded").not.toContain(INFLIGHT_KEY);
  expect(keys).not.toContain(STAGED_KEY);
  expect(
    keys.filter((k) => k.startsWith(OPENINGS_PREFIX)),
    "no private operation ran, so there are no openings to hold",
  ).toEqual([]);

  // Watch for writes rather than sampling for them.
  //
  // The first version of this compared a storage snapshot before and after the
  // lock, and a mutation that made `lock()` write survived it: the write was
  // fire-and-forget, so the snapshot raced it and usually won. `onChanged`
  // fires whenever the store is touched by anyone, so a late write is still
  // observed. That is the difference between an assertion and a coin flip.
  await harness.popup.evaluate(() => {
    const w = window as unknown as { t10writes: string[] };
    w.t10writes = [];
    chrome.storage.local.onChanged.addListener((changes) => {
      w.t10writes.push(...Object.keys(changes));
    });
  });

  const before = JSON.stringify(await storage(harness.popup), keys);
  await wallet.lock();
  // Two more awaited round trips, so anything the lock scheduled has had a
  // whole unlock and a second lock to land in.
  await wallet.unlock(PASSWORD);
  await wallet.waitForHome();
  await wallet.lock();

  const writes = await harness.popup.evaluate(
    () => (window as unknown as { t10writes: string[] }).t10writes,
  );
  expect(writes, "locking and unlocking are memory operations, not disk ones").toEqual([]);
  expect(JSON.stringify(await storage(harness.popup), keys)).toBe(before);

  // And the lock really dropped the session rather than only re-rendering.
  const status = await ask<{ locked: boolean }>(harness.popup, { type: "status" });
  expect(status.locked).toBe(true);
});
