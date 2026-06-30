// 200% browser zoom. An accessibility requirement, not an edge case.
//
// What 200% actually does to a Chrome popup, derived rather than assumed:
// Chrome asks the page for a preferred size in CSS pixels, multiplies by the
// page zoom to get device-independent pixels, and caps the window at 800x600
// DIPs. The wallet's frame is 384x600 CSS px, so at 2x it asks for 768x1200
// DIPs. The width fits under the 800 cap and survives; the height is cut in
// half by the 600 cap. The page is left with 384x300 CSS pixels.
//
// So the interesting thing at 200% is not the width, it is that the frame is
// suddenly TWICE as tall as the window it lives in, and `ui/primitives.tsx`
// gives that frame a FIXED 600px height with `overflow: hidden`. What happens
// to a wallet whose whole scroll model assumes the frame fits is the subject of
// this file.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import { fund } from "../support/testnet";
import { expectLayoutHolds, expectReachable, FRAME, ZOOM_200 } from "./audit";

const PASSWORD = "a-strong-test-password";
const LONGEST_MEMO = "ZQXJ7WMKB4TVND2HRCPYFGS3".padEnd(28, "L");

/** How far the frame hangs out of the window, and what can scroll it back. */
async function scrollModel(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const se = document.scrollingElement as HTMLElement;
    const frame = document.querySelector("#root > div") as HTMLElement;
    const inner = (Array.from(document.querySelectorAll("div")) as HTMLElement[]).find(
      (e) => getComputedStyle(e).overflowY === "auto",
    );
    return {
      window: { width: window.innerWidth, height: window.innerHeight },
      frameHeight: Math.round(frame.getBoundingClientRect().height),
      documentScrollsBy: se.scrollHeight - se.clientHeight,
      contentScrollsBy: inner ? inner.scrollHeight - inner.clientHeight : 0,
    };
  });
}

// REVISED, deliberately, because the fix for this slice's own finding 5
// changed the property this test was written to hold.
//
// It asserted that the frame keeps a fixed 600px height and the DOCUMENT
// scrolls to reach the rest. That was true and it was the cause of finding 5:
// with the whole frame taller than the window, scrolling to the button that
// signs a payment scrolled the header off the top, so the user approved a
// transaction on a screen whose title they could no longer see. A sticky
// header cannot help when the element it is sticky inside is itself moving.
//
// The frame is now capped at the window (`maxHeight: 100vh`), so the CONTENT
// scrolls within it and the header stays. The property worth pinning is
// therefore the opposite one, and the reachability check it was really about
// is kept intact: everything below the fold must still be reachable.
test("at 200% zoom the frame fits its window and the content scrolls inside it", async ({
  wallet,
}) => {
  const page = wallet.page;
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await page.setViewportSize(ZOOM_200);

  const m = await scrollModel(page);
  // NOT `expect(m.window).toEqual(ZOOM_200)`. That was the first thing written
  // here and it could not fail: it asserts the viewport this test had just set,
  // against the constant it set it from. Both assertions below are properties
  // of the PRODUCT at that viewport, and both go red if the frame stops being
  // a fixed 600px box.
  expect(
    m.frameHeight,
    "the frame must not be taller than its window, or the header scrolls away with it",
  ).toBeLessThanOrEqual(m.window.height);
  // The one that matters. Nothing makes `html`/`body` scrollable on purpose, so
  // an `overflow: hidden` added up there some day would leave the bottom half
  // of every screen unreachable at 200% zoom and this line is what would say so.
  // The document itself must NOT scroll: that is what dragged the header off.
  // Reachability moves inside the frame, which is asserted by the tests below
  // that walk every control at this viewport.
  expect(
    m.documentScrollsBy,
    "the popup body must not scroll, or the header goes with it",
  ).toBe(0);
});

test("at 200% zoom every control on the tallest screens is still reachable", async ({ wallet }) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.lock();
  await wallet.openRecover();

  // The erase warning is the tallest screen reachable without money: three
  // bullets, two notices and two buttons, and its second button already sits
  // past the 600px line at 100%.
  await page.setViewportSize(ZOOM_200);
  await expectLayoutHolds(page, "recover/warning @ 200% zoom");
  await expectReachable(
    page.getByRole("button", { name: "I understand, continue" }),
    "recover/warning @ 200% zoom: I understand, continue",
  );
  await expectReachable(
    page.getByRole("button", { name: "Go back" }),
    "recover/warning @ 200% zoom: Go back",
  );
});

/**
 * The property the frame's own comment promises, checked at the one zoom level
 * where it is not free.
 *
 * `ui/primitives.tsx` explains the fixed height like this: "Chrome caps a
 * toolbar popup at 600px and then scrolls the BODY, which drags the header off
 * the top of the window. A fixed frame keeps the header put and lets the
 * content scroll under it, the same way on every screen."
 *
 * That is exactly the right thing to want. This asserts it is true, on a
 * signing screen, at 200% zoom: scroll down to the button you are about to
 * press and the title saying what you are approving is still on screen.
 */
test("at 200% zoom the screen's title is still on screen when its button is", async ({
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

  await page.setViewportSize(ZOOM_200);
  const approve = page.getByRole("button", { name: "Confirm and send" });
  await expectReachable(approve, "send/confirm @ 200% zoom: Confirm and send");

  // Having scrolled to the button, what is the user looking at? The header is
  // the only thing on this screen that names it.
  const header = page.getByText("Send", { exact: true }).first();
  const seen = await header.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top), bottom: Math.round(r.bottom), window: window.innerHeight };
  });
  expect(
    seen.bottom > 0 && seen.top < seen.window,
    `send/confirm @ 200% zoom: the "Send" header sits at ${seen.top}..${seen.bottom} in a ${seen.window}px window, so scrolling to the button that signs the payment scrolls away the title that says what screen you are on`,
  ).toBe(true);
});
