// Narrower than the frame's own 384px: how far the wallet can be squeezed
// before it starts losing content, and what it loses first.
//
// This is not a hypothetical. `ui/primitives.tsx` gives the frame
// `width: 384` inside `#root {display: flex}` and never sets `flex-shrink: 0`,
// so the frame is FLUID: it gives ground to a narrower window instead of
// forcing one. Measured, it tracks the window exactly, all the way down.
//
// Where a narrower window comes from, and it is the browser's own control:
// Chrome sizes a toolbar popup by asking the page for its preferred size in
// CSS pixels, multiplying by the page zoom, and capping the result at 800x600
// device-independent pixels. So the CSS width the page is left with is
// min(384, 800/zoom):
//
//     zoom   100%   200%   250%   300%   400%   500%
//     CSS px  384    384    320    266    200    160
//
// 200% is the accessibility requirement and the width survives it, which is
// why `REQUIRED_VIEWPORTS` keeps 384 there and only halves the height. Past
// 250% the width is what gives, and that is what this file measures.
//
// Two of these tests are RED and are left red. They are findings 1 and 2 in
// `_test/T8.md`, not assertions to be relaxed until the suite is green.
import { test, expect } from "../support/fixtures";
import { ADDRESS_RE, WAITS } from "../support/wallet";
import { fund } from "../support/testnet";
import {
  atEveryViewport,
  expectLayoutHolds,
  expectReachable,
  forEachViewport,
  FRAME,
  NARROW_VIEWPORTS,
  REQUIRED_VIEWPORTS,
} from "./audit";

const PASSWORD = "a-strong-test-password";
const LONGEST_MEMO = "ZQXJ7WMKB4TVND2HRCPYFGS3".padEnd(28, "L");

test("the screens before a wallet exists survive every width Chrome can zoom to", async ({
  wallet,
}) => {
  const page = wallet.page;
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await atEveryViewport(page, "onboarding/splash", NARROW_VIEWPORTS);

  await page.setViewportSize(FRAME);
  await page.getByRole("button", { name: "I have a recovery phrase" }).click();
  await page.getByLabel("Recovery phrase").fill("irresponsible ".repeat(24).trim());
  await atEveryViewport(page, "onboarding/import", NARROW_VIEWPORTS);

  await page.setViewportSize(FRAME);
  await page.reload();
  await wallet.createWallet(PASSWORD);
  await wallet.lock();
  await atEveryViewport(page, "unlock", NARROW_VIEWPORTS);

  await page.setViewportSize(FRAME);
  await wallet.openRecover();
  await atEveryViewport(page, "recover/warning", NARROW_VIEWPORTS);
});

test("the 24 backup words stay legible at every width Chrome can zoom to", async ({ wallet }) => {
  const page = wallet.page;
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Write this down")).toBeVisible({ timeout: WAITS.onboarding });

  // A three-column grid of monospace words is the layout most likely to give
  // way first, and this is the one screen in the wallet that is shown ONCE.
  await forEachViewport(page, NARROW_VIEWPORTS, async (vp) => {
    // Per word first, so the failure names the word rather than the grid.
    const cells = wallet.backupWordCells();
    await expect(cells, `backup @ ${vp.name}`).toHaveCount(24);
    for (let i = 0; i < 24; i++) {
      await expectReachable(cells.nth(i), `backup @ ${vp.name}: word ${i + 1}`);
    }
    await expectLayoutHolds(page, `onboarding/backup @ ${vp.name}`);
  });
});

/**
 * FINDING 2. Red below 194px.
 *
 * Send and Receive sit in a `1fr 1fr` grid whose items keep their automatic
 * min-content width, so below about 212px they stop shrinking and start
 * overflowing the grid instead. The frame's `overflow: hidden` then cuts what
 * hangs off the right, and because that overflow never reaches the document
 * there is no horizontal scrollbar either. Measured: Receive's right edge
 * parks at 194px whatever the window does.
 */
test("the home screen's two actions stay inside the window at every width", async ({ wallet }) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await fund(address);
  await wallet.reopen();
  await wallet.waitForHome();

  await forEachViewport(page, NARROW_VIEWPORTS, async (vp) => {
    await expectReachable(
      page.getByRole("button", { name: "Send", exact: true }),
      `home @ ${vp.name}: Send`,
    );
    await expectReachable(
      page.getByRole("button", { name: "Receive" }),
      `home @ ${vp.name}: Receive`,
    );
    await expectLayoutHolds(page, `home/loaded @ ${vp.name}`);
  });
});

/**
 * FINDING 1. Red at and below 326px.
 *
 * The confirm screen states its effects in a `<ul>` with no `overflow-wrap`,
 * and one of those effects quotes the memo. A memo is commonly a single
 * unbroken token (every exchange deposit memo is), Stellar allows 28 bytes of
 * one, and 28 bytes plus `Attach the memo ""` needs 273px. Below 326px of
 * window that does not fit, the frame clips it, and the CONTENT column's
 * horizontal scrollWidth does not grow because ink overflow is not layout
 * overflow, so there is nothing to scroll. The characters are simply gone.
 *
 * Asserted on the effect line specifically, not on a screenshot: what makes it
 * a defect is that a SIGNING screen states an effect the user cannot finish
 * reading, at a width the browser's own zoom control reaches.
 */
test("the memo the confirm screen says it will attach is readable at every width", async ({
  wallet,
}) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await fund(address);
  await wallet.reopen();
  await wallet.waitForHome();
  await wallet.openSend();
  await wallet.composePayment({ to: address, amount: "1.5", memo: LONGEST_MEMO });
  await expect(page.getByText("Sending to")).toBeVisible({ timeout: WAITS.ledgerRead });

  await forEachViewport(page, NARROW_VIEWPORTS, async (vp) => {
    const effect = page.locator("li").filter({ hasText: "Attach the memo" });
    const cut = await effect.evaluate((el) => ({
      needs: el.scrollWidth,
      has: el.clientWidth,
    }));
    expect(
      cut.needs - cut.has,
      `send/confirm @ ${vp.name}: the effect line needs ${cut.needs}px and was given ${cut.has}px, so ${cut.needs - cut.has}px of the memo it is asking you to approve is cut off, with nothing to scroll`,
    ).toBeLessThanOrEqual(1);

    await expectLayoutHolds(page, `send/confirm @ ${vp.name}`);
  });
});

/**
 * A single token far longer than any field is wide, in the field most likely to
 * receive one: a pasted address.
 *
 * Two ways a layout dies on this, and the second is the one that catches people
 * out. The FIELD could stretch, and does not: an `<input>` scrolls its own
 * value, which is why the audit exempts fields from the overflow check. The
 * ERROR could quote it back, and that is what turns a bad paste into an
 * unbreakable 400-character run inside a `Notice` that has no `overflow-wrap`.
 *
 * The wallet gets both right, and the second one is not luck: `describeError`
 * maps an invalid address to a fixed sentence rather than echoing the input,
 * and `dispatch.ts` explains at length that reflecting an attacker-influenced
 * string to the user is what the allowlist exists to prevent. That is a
 * security decision with a layout consequence, and this test asserts the
 * consequence.
 */
test("a 400-character paste in the recipient field breaks no layout and is not echoed back", async ({
  wallet,
}) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await fund(address);
  await wallet.reopen();
  await wallet.waitForHome();
  await wallet.openSend();

  const RUBBISH = "G".repeat(400);
  await page.getByLabel("Recipient").fill(RUBBISH);
  await page.getByLabel("Amount (XLM)").fill("1");
  await page.getByRole("button", { name: "Review" }).click();

  const notice = page.getByText(/does not look like a Stellar address/);
  await expect(notice).toBeVisible({ timeout: WAITS.ledgerRead });
  // The property that keeps the notice a fixed height: it says what is wrong,
  // it does not repeat what was typed.
  expect(
    await page.locator("body").innerText(),
    "the refusal must not quote the 400 characters back",
  ).not.toContain("GGGGGGGGGGGGGGGGGGGG");

  await forEachViewport(page, [...REQUIRED_VIEWPORTS, ...NARROW_VIEWPORTS], async (vp) => {
    await expectReachable(notice, `send/compose (bad paste) @ ${vp.name}: the refusal`);
    await expectLayoutHolds(page, `send/compose (bad paste) @ ${vp.name}`);
  });
});

/**
 * The address block, by contrast, holds. `wordBreak: break-all` in
 * `AddressBlock` is doing real work and this is what proves it: the same 56
 * characters, complete, at every width down to Chrome's maximum zoom.
 */
test("a full 56-character address stays complete and inside the frame at every width", async ({
  wallet,
}) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await fund(address);
  await wallet.reopen();
  await wallet.waitForHome();
  await page.getByRole("button", { name: "Receive" }).click();
  await expect(page.getByText("Your address")).toBeVisible();

  for (const vp of NARROW_VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const block = page.getByText(ADDRESS_RE).first();
    await expectReachable(block, `home/receive @ ${vp.name}: the address block`);
    // Truncation is not an option on this screen by design, so the only way to
    // pass is to WRAP. Reading it back proves it wrapped rather than that it
    // was quietly shortened to something that fits.
    expect(
      (await block.innerText()).replace(/\s/g, ""),
      `home/receive @ ${vp.name}: all 56 characters`,
    ).toBe(address);
    const overflow = await block.evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(
      overflow,
      `home/receive @ ${vp.name}: the block is wider than its column`,
    ).toBeLessThanOrEqual(1);
  }
});
