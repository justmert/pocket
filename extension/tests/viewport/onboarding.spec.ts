// Onboarding, Unlock and Recover, at the popup ceiling.
//
// These are the screens a user meets before the wallet has any money in it, so
// they are the ones a broken layout locks someone out of entirely: there is no
// "scroll down and find it" when the control you cannot reach is the one that
// creates the wallet.
//
// Every screen is checked at each required viewport and the failure message
// names which one broke it. Narrower widths than the frame's own are
// `narrow.spec.ts`, which is where they turned into findings.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import {
  expectLayoutHolds,
  expectReachable,
  openRecover,
  FRAME,
  REQUIRED_VIEWPORTS,
} from "./audit";

const PASSWORD = "a-strong-test-password";

/** Real, valid, and the longest words BIP-39 has, so the grid is under load. */
const LONG_PHRASE =
  "irresponsible irresponsible irresponsible irresponsible " +
  "irresponsible irresponsible irresponsible irresponsible " +
  "irresponsible irresponsible irresponsible irresponsible " +
  "irresponsible irresponsible irresponsible irresponsible " +
  "irresponsible irresponsible irresponsible irresponsible " +
  "irresponsible irresponsible irresponsible irresponsible";

const VIEWPORTS = REQUIRED_VIEWPORTS;

/** Run one screen's layout contract at every viewport in the matrix. */
async function atEveryViewport(
  page: import("@playwright/test").Page,
  screen: string,
  settle: () => Promise<void>,
): Promise<void> {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settle();
    await expectLayoutHolds(page, `${screen} @ ${vp.name}`);
  }
}

test("the first screen's two ways in are both reachable at every viewport", async ({ wallet }) => {
  const page = wallet.page;
  await atEveryViewport(page, "onboarding/splash", async () => {
    await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  });

  // Named explicitly as well as swept, because these two are the only controls
  // that exist before a wallet does: unreachable here is unreachable forever.
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectReachable(
      page.getByRole("button", { name: "Create a new wallet" }),
      `splash @ ${vp.name}: Create a new wallet`,
    );
    await expectReachable(
      page.getByRole("button", { name: "I have a recovery phrase" }),
      `splash @ ${vp.name}: I have a recovery phrase`,
    );
  }
});

test("the create form stays reachable with its rule on screen", async ({ wallet }) => {
  const page = wallet.page;
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await page.getByRole("button", { name: "Create a new wallet" }).click();

  // The tallest the form ever gets: the mismatch notice, which is what a user
  // typing a short password into the first field and a different one into the
  // second actually sees. The length rule is the field's own placeholder now.
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByLabel("Confirm password").fill("different");
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();

  await atEveryViewport(page, "onboarding/create (the rule shown)", async () => {
    await expect(page.getByRole("button", { name: "Create wallet" })).toBeAttached();
  });
});

/**
 * FINDING. Red at 360x600, the brief's floor, and left red.
 *
 * The word grid is `repeat(auto-fit, minmax(88px, 1fr))` with a 6px gap. At
 * 384px of frame that resolves to three tracks of about 103px and at 360px to
 * three of about 95px. A cell is a flex row of an unselectable ordinal and the
 * word, in 14px monospace with no `overflow-wrap`, so a two-digit ordinal plus
 * an eight-letter word needs about 98px. At 384 it fits. At 360 it does not,
 * and the frame clips what hangs over: measured, 3px of the last glyph of
 * "10.dinosaur" simply gone.
 *
 * WHICH words is luck, and that is the worst part of it rather than a reason to
 * discount it. The phrase is random, so this screen is legible for one user and
 * shaved for the next, and the same run of this test is green or red depending
 * on the phrase the wallet just generated. It is the one screen shown ONCE, the
 * words on it are the only way back into the wallet, and a character lost here
 * is not discovered until the day it is needed.
 */
test("all 24 backup words and both buttons are reachable at every viewport", async ({ wallet }) => {
  const page = wallet.page;
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({
    timeout: WAITS.onboarding,
  });
  await page.getByRole("button", { name: "Show the phrase" }).click();

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });

    // The phrase is shown ONCE. A word clipped by the frame, or cut off inside
    // its own cell, is a wallet the user cannot restore, and it would not be
    // discovered until the day they needed it. So every one of the 24 is
    // checked individually, and BEFORE the whole-screen sweep: the sweep would
    // otherwise report the same loss first and this loop would never speak,
    // which is how an assertion ends up looking verified without being.
    const cells = wallet.backupWordCells();
    await expect(cells, `backup @ ${vp.name}: 24 words`).toHaveCount(24);
    for (let i = 0; i < 24; i++) {
      await expectReachable(cells.nth(i), `backup @ ${vp.name}: word ${i + 1}`);
    }
    await expectLayoutHolds(page, `onboarding/backup @ ${vp.name}`);
  }
});

test("the import form holds a full 24-word phrase without spilling sideways", async ({
  wallet,
}) => {
  const page = wallet.page;
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await page.getByRole("button", { name: "I have a recovery phrase" }).click();
  await page.getByLabel("Recovery phrase").fill(LONG_PHRASE);
  await page.getByLabel("New password", { exact: true }).fill("short");
  await expect(page.getByLabel("New password", { exact: true })).toHaveAttribute(
    "aria-invalid",
    "true",
  );

  await atEveryViewport(page, "onboarding/import (24 long words typed)", async () => {
    await expect(page.getByRole("button", { name: "Restore wallet" })).toBeAttached();
  });
});

test("the unlock screen keeps its field and both ways forward reachable", async ({ wallet }) => {
  const page = wallet.page;
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);
  await wallet.lock();

  await atEveryViewport(page, "unlock", async () => {
    await expect(wallet.lockedNotice()).toBeVisible();
  });

  // With the wrong-password error on screen, which is the taller variant and
  // the one a user is most likely to be looking at.
  await page.setViewportSize(FRAME);
  await page.getByLabel("Password", { exact: true }).fill("not-the-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  // The refusal is the screen's one `role="alert"`. Located that way rather
  // than by hunting a div containing the word "password": the screen also
  // carries a password field and a "Forgot your password?" button, so that
  // hunt could land on either and pass while the error was nowhere on screen.
  const error = page.getByRole("alert");
  await expect(error).toBeVisible();
  await atEveryViewport(page, "unlock (wrong password)", async () => {
    await expect(page.getByRole("button", { name: "Unlock" })).toBeAttached();
  });
});

test("the erase warning page and its form both keep their buttons reachable", async ({
  wallet,
}) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.lock();
  await openRecover(page);

  // The warning page: two bullets, one notice, two buttons. The most copy
  // the wallet shows before it has any money in it.
  await atEveryViewport(page, "recover/warning", async () => {
    await expect(page.getByRole("button", { name: "I understand, continue" })).toBeAttached();
  });

  await page.setViewportSize(FRAME);
  await page.getByRole("button", { name: "I understand, continue" }).click();

  // The form at its tallest: both of its hints on screen at once, which is what
  // a half-typed phrase and mismatched passwords produce.
  await page.getByLabel(/Recovery phrase/).fill("one two three");
  await page.getByLabel("New password", { exact: true }).fill("short");
  await page.getByLabel("Confirm new password").fill("different");
  await expect(page.getByText("Must be 12, 15, 18, 21 or 24 words.")).toBeVisible();
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();

  await atEveryViewport(page, "recover/form (both hints shown)", async () => {
    await expect(page.getByRole("button", { name: "Erase and restore" })).toBeAttached();
  });
});
