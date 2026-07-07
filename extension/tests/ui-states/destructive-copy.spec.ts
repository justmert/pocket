// A2-02 and A5-01: the two things the destructive paths were not saying.
//
// A2-02. "This password unlocks this device. It is not a backup." was under the
// create form and nowhere else. Someone who imports a phrase, or who erases and
// restores, sets a password on a screen that never says what it is for, and can
// reasonably conclude the password is now the thing to keep.
//
// A5-01. Two doors reach the same irreversible erase. Settings said "Rebuilding
// them needs your history from an archive", which reads as though a rebuild
// exists; the locked screen's door read the config and said which of the two
// situations this build is in. The softer sentence was on the door more people
// reach.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";
const DEVICE_LOCAL = /This password unlocks this device\. It is not a backup\./;
/** a phrase that is valid to enter; nothing here ever submits it. */
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";

test("every screen that sets a password says what the password is not", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;

  // 1. create.
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await expect(page.getByText(DEVICE_LOCAL), "the create form states it").toBeVisible();

  // 2. import.
  await page.getByRole("button", { name: /Back|Cancel/ }).first().click();
  await page.getByRole("button", { name: /recovery phrase/i }).click();
  await expect(
    page.getByText(DEVICE_LOCAL),
    "the import form sets a password too, and said nothing about it",
  ).toBeVisible();

  // 3. erase and restore, which is reached from the locked screen.
  await page.getByRole("textbox", { name: /Recovery phrase/i }).fill(PHRASE);
  await page.getByRole("textbox", { name: "New password", exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Import wallet" }).click();
  await wallet.waitForHome(WAITS.ledgerRead);
  await page.getByRole("button", { name: "Lock wallet" }).click();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await page.getByRole("button", { name: "I understand, continue" }).click();
  await expect(
    page.getByText(DEVICE_LOCAL),
    "erase and restore sets a password too, and said nothing about it",
  ).toBeVisible();
});

test("both doors to erasing this wallet describe the same loss", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // The door in settings.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: /Erase this wallet/i }).click();
  const fromSettings = await page
    .getByText(/private balances are opened by keys held only here/i)
    .first()
    .innerText();

  // The door on the locked screen. Settings is its own tab and Lock lives on
  // home, so the sheet closes and the nav goes back before Lock is reachable.
  await page.keyboard.press("Escape");
  await expect(page.locator("[role='dialog']")).toHaveCount(0);
  await page.getByRole("button", { name: "Home", exact: true }).click();
  await page.getByRole("button", { name: "Lock wallet" }).click();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  const fromLocked = await page
    .getByText(/private balances are opened by keys held only here/i)
    .first()
    .innerText();

  expect(
    fromSettings.replace(/\s+/g, " ").trim(),
    "two doors to the same irreversible act described its cost differently",
  ).toBe(fromLocked.replace(/\s+/g, " ").trim());

  // And whichever sentence it is, it must be the one that matches this build
  // rather than the one that implies a rebuild always exists.
  expect(fromSettings).toMatch(/rebuilt afterwards by replaying|cannot be rebuilt yet/);
});
