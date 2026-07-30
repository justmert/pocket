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
// The rebuild moved both of the old findings and added one of its own.
//
//   FINDING 1 is FIXED, and the test that found it is kept as the proof:
//   `ui/flow.tsx` now sets `overflow-wrap: anywhere` on the effects list, and
//   the same 28-byte unbroken memo it used to lose is legible down to 160px.
//
//   FINDING 2 moved. Send and Receive are bar slots now and the bar holds all
//   the way down, because its tiles shrink to their icons. What gives way
//   instead is the ACCOUNT ROW above them, and that is finding 3.
//
//   FINDING 3 is new and is why three tests in this file are red. The home
//   screen's account row is a flex row of a 44px avatar, an identity column,
//   and two 40px icon buttons, with 14px between them: 166px of fixed width
//   inside a frame that goes down to 160. The identity column is the only
//   part that can give, so it takes all of it. Measured: at 266px it is 64px
//   wide and needs 85 to 93, so the shortened address is cut off in place; at
//   200px it is squeezed to ZERO and the account name and address are gone
//   entirely; at 160px the fixed parts themselves run past the right edge, and
//   the refresh button's own right edge parks at 184 in a 160px window.
//
//   Two of those three are red for finding 3 ALONE. Their own subject holds,
//   and each says so where it is measured: the home screen sits behind the send
//   sheet, so a sweep of the whole document finds it there too.
import { test, expect } from "../support/fixtures";
import { ADDRESS_RE, WAITS } from "../support/wallet";
import { fund } from "../support/testnet";
import {
  atEveryViewport,
  expectLayoutHolds,
  expectReachable,
  forEachViewport,
  openRecover,
  FRAME,
  NARROW_VIEWPORTS,
  REQUIRED_VIEWPORTS,
} from "./audit";

const PASSWORD = "a-strong-test-password";
const LONGEST_MEMO = "ZQXJ7WMKB4TVND2HRCPYFGS3".padEnd(28, "L");

/**
 * FINDING 4. Red at 160px, and left red.
 *
 * `Header` sets a screen's title in the 24px display face with no
 * `overflow-wrap`, so "Erase and restore" cannot break and needs 135px where
 * the frame gives it 124. Eleven pixels of the title of the one screen that
 * destroys a wallet are cut off in place, at Chrome's maximum zoom, with
 * nothing to scroll to. The splash, the import form and the unlock screen all
 * survive the same width.
 */
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
  await openRecover(page);
  await atEveryViewport(page, "recover/warning", NARROW_VIEWPORTS);
});

test("the 24 backup words stay legible at every width Chrome can zoom to", async ({ wallet }) => {
  const page = wallet.page;
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({ timeout: WAITS.onboarding });
  await page.getByRole("button", { name: "Show the phrase" }).click();

  // A grid of monospace words is the layout most likely to give way first, and
  // this is the one screen in the wallet that is shown ONCE.
  //
  // FINDING 5, which `onboarding.spec.ts` states in full because it starts at
  // 360px, above every width in this file. The word grid's tracks are too narrow
  // for a two-digit ordinal beside an eight-letter word, so whichever of the 24
  // happens to be longest is shaved by two or three pixels with no
  // `overflow-wrap` to break it and nothing to scroll to.
  //
  // Red or green here depending on the phrase the wallet just generated, which
  // is the finding rather than flakiness in the test: the words are random, so
  // the same screen is legible for one user and clipped for the next.
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
 * FINDING 2 is FIXED, and FINDING 3 is what this test now reports.
 *
 * The two actions used to be buttons in a `1fr 1fr` grid whose items kept their
 * automatic min-content width, so below about 212px they stopped shrinking and
 * overflowed the grid instead. They are now the second and third of five slots
 * on the floating bar, and the bar holds: its four tiles are ordinary flex
 * items that shrink to their 22px icons, so Send and Receive are both fully on
 * screen and hittable at every width down to 160. Those two assertions are what
 * the test is named for and they are green.
 *
 * The sweep underneath them is not. It reports finding 3, the account row,
 * described at the top of this file: cut off in place at 266px, squeezed to
 * nothing at 200px, and spilling past the right edge at 160px. Left red. It is
 * the first thing on the home screen and it is what tells someone WHICH account
 * the balance under it belongs to.
 */
test("the home screen's two actions stay inside the window at every width", async ({ wallet }) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await fund(address);
  await wallet.reopen();
  await wallet.waitForHome();

  await forEachViewport(page, NARROW_VIEWPORTS, async (vp) => {
    await expectReachable(wallet.nav("Send"), `home @ ${vp.name}: Send`);
    await expectReachable(wallet.nav("Receive"), `home @ ${vp.name}: Receive`);
    await expectLayoutHolds(page, `home/loaded @ ${vp.name}`);
  });
});

/**
 * FINDING 1, now the proof that it is FIXED.
 *
 * The confirm step states its effects in a `<ul>`, and one of those effects
 * quotes the memo. A memo is commonly a single unbroken token (every exchange
 * deposit memo is), Stellar allows 28 bytes of one, and 28 bytes plus
 * `Attach the memo ""` needs 273px. That list used to set no `overflow-wrap`,
 * so below 326px of window the frame clipped it, the CONTENT column's
 * horizontal scrollWidth did not grow because ink overflow is not layout
 * overflow, and the characters were simply gone with nothing to scroll.
 *
 * `ui/flow.tsx` now sets `overflowWrap: "anywhere"` on that list, with a comment
 * saying why. This test is what says the comment is true, at every width down to
 * Chrome's maximum zoom.
 *
 * Asserted on the effect line specifically, not on a screenshot: what made it a
 * defect is that a SIGNING screen stated an effect the user could not finish
 * reading, at a width the browser's own zoom control reaches.
 */
test("the memo the confirm step says it will attach is readable at every width", async ({
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
  await expect(page.getByText("Sending", { exact: true })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // The memo assertion below is green at every one of these widths, which is
  // finding 1 fixed. The layout sweep after it is red from 266px down, and it
  // is reporting the home screen BEHIND the sheet: a sheet does not cover the
  // account row, and content that is still on screen still has to fit.
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
  await page.getByLabel("To", { exact: true }).fill(RUBBISH);
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

  // The refusal itself holds at every width, which is what this test is for.
  // The sweep is red from 266px down and, as in the test above, what it finds
  // is finding 3 on the home screen behind the sheet, not anything about the
  // paste or the notice.
  await forEachViewport(page, [...REQUIRED_VIEWPORTS, ...NARROW_VIEWPORTS], async (vp) => {
    await expectReachable(notice, `send/compose (bad paste) @ ${vp.name}: the refusal`);
    await expectLayoutHolds(page, `send/compose (bad paste) @ ${vp.name}`);
  });
});

/**
 * The address block, by contrast, holds. `wordBreak: break-all` in
 * `ui/Address.tsx` is doing real work and this is what proves it: the same 56
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
  await wallet.nav("Receive").click();
  await expect(page.getByRole("dialog", { name: "Receive" })).toBeVisible();

  for (const vp of NARROW_VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const block = page.getByText(ADDRESS_RE).first();
    await expectReachable(block, `home/receive @ ${vp.name}: the address block`);
    // Truncation is not an option on this sheet by design, so the only way to
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
