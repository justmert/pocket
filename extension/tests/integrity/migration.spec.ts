// Upgrading over an install a PREVIOUS version made.
//
// This is the case no amount of testing the current build can reach, because
// the data under test was written by code that is no longer in the tree. So the
// old code is actually run: `build-old.sh` archives a commit's `extension/src`,
// builds it into its own output directory, and the spec swaps that build into
// the SAME extension path the current build will occupy. The path matters more
// than it looks: Chrome derives the extension id from it, and the id is what
// namespaces chrome.storage.local, so two builds at two paths are two different
// extensions with two different stores and nothing has been migrated at all.
//
// The bar, from the brief and worth restating: an install carrying records from
// before a schema change must still open them, or say plainly that it cannot.
// Silence or a wrong balance is the failure.
import { test, expect, type Page } from "@playwright/test";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import {
  addressFromMnemonic,
  chainAccount,
  formatStroops,
  inspect,
  openingKeyFor,
  openingsOpenTheChain,
  storage,
  ADDRESS_KEY,
  AUDITORID_PREFIX,
  OPENINGS_PREFIX,
  STATE_KEY,
} from "./oracle";
import {
  open,
  launch,
  installBuild,
  swappablePath,
  tryAsk,
  clearServiceWorkerCache,
  OLD_VERSION,
  NEW_VERSION,
  CURRENT_BUILD,
  OLD_BUILD,
  PASSWORD,
} from "./harness";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * `9087fea`, the last commit before `pocket.address` existed.
 *
 * Chosen because that key is the one real schema addition in this wallet's
 * history: it is what authorises `recoverFromMnemonic`, and an install made
 * before it does not have one. Build it with
 * `./tests/integrity/build-old.sh 9087fea .output-t10-preaddr`.
 */
const PRE_ADDRESS_BUILD = resolve(here, "../../.output-t10-preaddr/chrome-mv3");

function requireBuild(path: string, how: string): void {
  if (!existsSync(path)) throw new Error(`no build at ${path}. Build it with: ${how}`);
}

/**
 * Onboard the PREVIOUS build, in the previous build's own words.
 *
 * The shared page object speaks the current UI. This test is the one place that
 * drives an older one, so the two vocabularies cannot be the same object, and a
 * page object that tried to speak both would be a page object that describes
 * neither.
 */
async function createWalletOnOldUi(page: Page, password: string): Promise<string> {
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({
    timeout: WAITS.onboarding,
  });
  const cells = await page
    .locator("span")
    .filter({ hasText: /^\d+\.\s\w+\s*$/ })
    .allInnerTexts();
  const phrase = cells.map((c: string) => c.replace(/^\d+\.\s*/, "").trim()).join(" ");
  await page.getByRole("button", { name: "I have written it down" }).click();
  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: WAITS.onboarding });
  return phrase;
}

test("a wallet created before pocket.address existed still opens, and the upgrade back-fills it", async ({}, testInfo) => {
  test.setTimeout(6 * 60_000);
  requireBuild(PRE_ADDRESS_BUILD, "./tests/integrity/build-old.sh 9087fea .output-t10-preaddr");

  const at = swappablePath(testInfo.parallelIndex);
  const dir = mkdtempSync(join(tmpdir(), "pocket-t10-mig-"));
  let install: Awaited<ReturnType<typeof open>> | null = null;
  try {
    // ------------------------------------------------ the previous version
    installBuild(PRE_ADDRESS_BUILD, at, OLD_VERSION);
    install = await open(dir, at);
    const page = await install.popup();
    const phrase = await createWalletOnOldUi(page, PASSWORD);
    const expected = await addressFromMnemonic(phrase);

    const oldKeys = Object.keys(await storage(page)).sort();
    // The premise, established rather than assumed. If this build DID write an
    // address, the rest of this test would be checking nothing.
    expect(oldKeys, "this build predates pocket.address").not.toContain(ADDRESS_KEY);
    console.log(`  wrote with 9087fea: ${oldKeys.join(", ")}`);
    await install.suspend();

    // ------------------------------------------------- upgrade in place
    //
    // Version bump AND service-worker cache clear, both required. See
    // `installBuild` and `clearServiceWorkerCache`: without them the popup is
    // the new build and the worker answering it is still the old one.
    clearServiceWorkerCache(dir);
    installBuild(CURRENT_BUILD, at, NEW_VERSION);
    install = await open(dir, at);
    const upgraded = await install.popup();
    const w = new Wallet(upgraded);

    // Not onboarding. A wallet that offers to create a new one has silently
    // decided the existing install is not a wallet, and the user's next click
    // is the destructive one.
    await expect(w.lockedNotice(), "an upgraded install must ask for the password").toBeVisible({
      timeout: WAITS.onboarding,
    });

    // Before the password is entered, the erase-and-restore route is the one
    // destructive path reachable while locked, and it cannot authorise itself
    // without a stored address. It must REFUSE, and the refusal must name the
    // way out, because a user who is told only "no" reaches for the uninstall.
    const refused = await tryAsk(upgraded, {
      type: "recoverFromMnemonic",
      mnemonic: phrase,
      password: "a-different-password",
    });
    expect(refused.ok, "an install with no stored address must not be erased").toBeFalsy();
    expect(refused.error, "the refusal must say what to do next").toMatch(
      /Unlock the wallet once with its password/i,
    );
    // And it must not have half-done it.
    expect(Object.keys(await storage(upgraded)), "a refusal erases nothing").toContain(STATE_KEY);

    // ------------------------------------------------------- one unlock
    await w.unlock(PASSWORD);
    await w.waitForHome(WAITS.onboarding);
    const shown = await w.revealAddress();
    expect(shown, "the upgraded build must open the same account").toBe(expected);

    const disk = await inspect(upgraded, PASSWORD);
    expect(disk.mnemonic, "the upgrade must not have touched the seed").toBe(phrase);
    expect(
      disk.storedAddress,
      "one unlock is the documented migration: the address must now be on disk",
    ).toBe(expected);

    // Which turns the earlier refusal into a route rather than a dead end.
    const accepted = await tryAsk(upgraded, {
      type: "recoverFromMnemonic",
      mnemonic: phrase,
      password: PASSWORD,
    });
    expect(accepted.ok, "with the address back-filled, the phrase authorises the erase").toBe(true);
  } finally {
    await install?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(at, { recursive: true, force: true });
  }
});

test("a clean install of the current build writes only the keys this version documents", async () => {
  // The other end of the same question. Migration is only tractable if the key
  // set is known, so this pins it: a new key appearing here without a migration
  // story is what makes the next upgrade a surprise.
  const install = await launch();
  try {
    const page = await install.popup();
    await new Wallet(page).createWallet(PASSWORD);
    const keys = Object.keys(await storage(page)).sort();
    expect(keys, "a fresh install holds exactly the vault, its state and the address").toEqual([
      ADDRESS_KEY,
      STATE_KEY,
      "pocket.vault",
    ]);
    expect(keys.filter((k) => k.startsWith(OPENINGS_PREFIX))).toEqual([]);
  } finally {
    await install.close();
  }
});
