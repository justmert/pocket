// A5-01: what the destructive paths were not saying.
//
// Two doors reach the same irreversible erase. Settings said "Rebuilding
// them needs your history from an archive", which reads as though a rebuild
// exists; the locked screen's door read the config and said which of the two
// situations this build is in. The softer sentence was on the door more people
// reach.
//
// A2-02 was the third password screen saying nothing about what the password
// is for. That sentence ("This password unlocks this device. It is not a
// backup.") is gone from all three screens, so the test that walked them is
// gone with it.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

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
  await page.getByRole("menuitem", { name: "Lock" }).click();
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
