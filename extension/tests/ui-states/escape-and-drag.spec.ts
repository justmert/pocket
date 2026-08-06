// Two ways to leave a sheet, and what they must not take with them.
//
// Both were found by reading, and neither could be reproduced in a unit test:
// the suite runs in node with no jsdom, so no pointer event and no keypress can
// be dispatched at all. This file is why they are pinned rather than argued
// about.
//
//   Escape. A Sheet closes on Escape and so does an InfoTip, both listening on
//   `window`. The tip is the thing on top, but the sheet's listener registers
//   first (it is already open) and runs first, so one press aimed at the 'i'
//   also closed the sheet under it. On a confirm sheet that discards the staged
//   transaction the tip was explaining.
//
//   Drag. The sheet's entrance, exit and drag are one transform in pixels. On a
//   >90px pull the release branch called `onClose()` and never reset that
//   transform, so a sheet whose `onClose` declines stayed parked at the drag
//   offset inside a 384x600 frame with `overflow: hidden`, with its own buttons
//   below the bottom edge.
//
// Driven through Settings rather than a confirm sheet, because both properties
// belong to `Sheet` and `InfoTip` themselves and these need no funded account: a
// Continue that is correctly greyed out on an empty wallet would make the test
// about funding rather than about sheets.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

/** Settings > Auto-lock: a sheet reachable with no balance. */
async function openAutoLock(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: /Auto-lock/ })
    .first()
    .click();
  await expect(page.locator("[role='dialog']")).toHaveCount(1, { timeout: WAITS.ledgerRead });
}

/** Settings > Network: the same, and it still carries an InfoTip. */
async function openNetwork(page: import("@playwright/test").Page) {
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: /^Network/ })
    .first()
    .click();
  await expect(page.locator("[role='dialog']")).toHaveCount(1, { timeout: WAITS.ledgerRead });
}

test("Escape aimed at a tooltip does not close the sheet underneath it", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await openNetwork(page);

  // The bubble is portaled to document.body, which is exactly what makes the
  // two Escape listeners siblings on `window` rather than nested.
  const tip = page.getByRole("button", { name: /About switching networks/i }).first();
  await expect(tip).toBeVisible();
  // HOVER, not click. A click is a toggle, and moving the mouse onto the
  // control opens the tip on the way in, so clicking opens and then closes it:
  // the press below would then be aimed at nothing and the test would report a
  // defect that is really its own doing.
  await tip.hover();
  await expect(page.locator("[role='tooltip']")).toHaveCount(1);
  await expect(tip, "the tip is not actually open, so Escape has no target").toHaveAttribute(
    "aria-expanded",
    "true",
  );

  await page.keyboard.press("Escape");

  await expect(page.locator("[role='tooltip']"), "the tip ignored Escape").toHaveCount(0);
  await expect(
    page.locator("[role='dialog']"),
    "Escape aimed at the tooltip also closed the sheet under it",
  ).toHaveCount(1);

  // A second press, with nothing on top, does close the sheet: the fix must not
  // have taken Escape away from the sheet altogether.
  await page.keyboard.press("Escape");
  await expect(page.locator("[role='dialog']")).toHaveCount(0, { timeout: WAITS.ledgerRead });
});

test("a dragged sheet never ends up open and displaced", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await openAutoLock(page);

  const sheet = page.locator("[role='dialog']");
  const before = await sheet.boundingBox();
  expect(before).not.toBeNull();

  // Pull the grab handle down past the 90px dismiss threshold and release.
  await page.mouse.move(before!.x + before!.width / 2, before!.y + 8);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + 160, { steps: 12 });
  await page.mouse.up();

  // Either it closed, or it sprang back. The failure being pinned is the third
  // outcome: still open, still displaced, with its own controls pushed off the
  // bottom of a frame that does not scroll.
  await page.waitForTimeout(700);
  if ((await sheet.count()) > 0) {
    const after = await sheet.boundingBox();
    expect(
      after!.y,
      "the sheet stayed open and stayed dragged down, so its own buttons are off the bottom of the frame",
    ).toBeLessThanOrEqual(before!.y + 2);
  }
});

test("a sheet released short of the threshold springs back", async ({ wallet }) => {
  // The other half of the same branch. Without it a fix that simply never
  // dismisses would pass the test above.
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await openAutoLock(page);

  const sheet = page.locator("[role='dialog']");
  const before = await sheet.boundingBox();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + 8);
  await page.mouse.down();
  await page.mouse.move(before!.x + before!.width / 2, before!.y + 40, { steps: 6 });
  await page.mouse.up();

  await page.waitForTimeout(700);
  await expect(sheet, "a 40px pull dismissed the sheet").toHaveCount(1);
  const after = await sheet.boundingBox();
  expect(after!.y).toBeLessThanOrEqual(before!.y + 2);
});
