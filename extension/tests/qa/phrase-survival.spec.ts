// D-006: the phrase screen intercepts an accidental close.
//
// `create` installs the vault before the words are ever drawn, so from the
// moment the spinner stops there is a complete, unlocked wallet on disk and the
// 24 words exist only in one React component. Moving onboarding to a tab closed
// the accident of losing that window to a blur. It does not close Ctrl+W, a
// middle-click on the tab strip, "close tabs to the right", quitting the browser
// for the night, or a crash — and none of those is a decision about the phrase.
//
// Chrome's own "Leave site?" dialog is not the wallet's words and cannot be made
// to be. What it does is convert an accidental close into a deliberate one,
// which is exactly the line escalation E1 draws: what stays open is the user who
// chooses to walk away, not the user whose hand slipped.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

test("the phrase screen holds the window against an accidental close", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;

  // Record what the page does with beforeunload rather than trying to drive
  // Chrome's native dialog, which a test runner auto-dismisses. A listener that
  // calls preventDefault is exactly what makes Chrome ask.
  await page.addInitScript(() => {
    const w = window as unknown as { __unloadGuards: number; __prevented: number };
    w.__unloadGuards = 0;
    w.__prevented = 0;
    const add = window.addEventListener.bind(window);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).addEventListener = (type: string, fn: any, opts?: any) => {
      if (type === "beforeunload") w.__unloadGuards += 1;
      return add(type, fn, opts);
    };
  });
  await page.reload();

  // Nothing to protect yet: the choose screen holds no secret.
  await expect(page.getByRole("button", { name: "Create a new wallet" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  expect(
    await page.evaluate(() => (window as unknown as { __unloadGuards: number }).__unloadGuards),
    "the first screen has nothing worth holding a window for",
  ).toBe(0);

  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({ timeout: WAITS.onboarding });

  expect(
    await page.evaluate(() => (window as unknown as { __unloadGuards: number }).__unloadGuards),
    "the one screen holding an unrecorded recovery phrase does not hold its window",
  ).toBeGreaterThan(0);

  // And the guard actually refuses: dispatching the event must leave it
  // cancelled, which is what makes Chrome show its dialog.
  const cancelled = await page.evaluate(() => {
    const e = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(cancelled, "the listener exists but does not ask Chrome to stop").toBe(true);

  // It still holds through the verification step, because the words are still
  // only in memory until the check passes.
  // both onward controls are dead until the words have been deliberately
  // revealed, which is the batch-2 gate and is asserted elsewhere.
  await wallet.showPhrase();
  const phrase = await wallet.readBackupPhrase();
  await page.getByRole("button", { name: "I have written it down" }).click();
  await expect(page.getByText("Check what you wrote")).toBeVisible();
  expect(
    await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
    "the check step still holds the only copy of the phrase and must hold the window too",
  ).toBe(true);

  // Once the words are confirmed, the wallet has what it needs and the window
  // is free. A guard that never lets go is its own defect.
  await wallet.answerBackupCheck(phrase);
  await wallet.waitForHome(WAITS.ledgerRead);
  expect(
    await page.evaluate(() => {
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      return e.defaultPrevented;
    }),
    "the wallet went on holding the window after the phrase was confirmed",
  ).toBe(false);
});

test("the phrase screen says what not to do, rather than promising the page will stay", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({ timeout: WAITS.onboarding });

  // "This page stays open while you write them down" was true of a blur and of
  // nothing else. A user who reads it as "the words are safe while I find a pen"
  // has been told the opposite of what they need.
  await expect(
    page.getByText(/stays open while you write/i),
    "the screen promised a durability the platform does not provide",
  ).toHaveCount(0);
  await expect(page.getByText(/do not close this tab until you have confirmed the words/i)).toBeVisible();
});
