// The layout mode the whole suite had never entered: a toolbar popup's FIRST
// layout.
//
// Every other spec here opens popup.html as a tab, where the viewport is the
// window and is already the size it will stay. A toolbar popup is the opposite:
// Chrome gives it a 25x25 minimum and an 800x600 maximum and then sizes it FROM
// the document, so the first layout happens in a viewport a few pixels tall and
// the document's own measurement is what Chrome grows the window to.
//
// Anything viewport-relative in the frame's height therefore closes a loop:
// `max-height: 100vh` resolved against that first viewport, crushed the frame,
// and Chrome sized the popup to the crushed frame. Shipped, that was a wallet
// that opened as a 3px sliver of its own header with nothing in the console,
// and it passed every test in this repository.
import { test, expect, chromium } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { EXTENSION_PATH } from "../support/extension";
import { FRAME } from "./audit";

/**
 * Chrome's popup maximum width and MINIMUM height: the shape of the viewport
 * the document is first laid out in, before Chrome has sized anything.
 */
const FIRST_LAYOUT = { width: 800, height: 25 } as const;

test("the frame asks for its full height in the viewport a popup is first laid out in", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), "pocket-popup-sizing-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    // Set on the context, so the page is BORN this size. Calling
    // setViewportSize afterwards would fire a resize, which is the platform
    // saying it has settled, and is a different situation entirely.
    viewport: { ...FIRST_LAYOUT },
    timeout: 300_000,
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    await expect(page.getByText("Two pockets on Stellar")).toBeVisible();

    const frame = page.locator("#root > div").first();
    const box = await frame.boundingBox();
    expect(box, "the frame must be laid out at all").not.toBeNull();

    // The whole point: what the document reports here is what Chrome makes the
    // popup. A frame that shrinks to the viewport tells Chrome the wallet is
    // 25px tall, and Chrome believes it.
    expect(
      Math.round(box!.height),
      "the frame must not shrink to the viewport it is first measured in",
    ).toBe(FRAME.height);
  } finally {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
});

test("the frame still gives way once the window itself is genuinely short", async () => {
  // The other half, and the reason the ceiling exists at all. Once Chrome has
  // settled on a size it reports it by resizing, and at 200% zoom that size is
  // half the popup maximum. The frame must follow the window down, or the BODY
  // scrolls instead of the frame and the sticky header goes off the top with
  // it, taking the title of the screen you are signing on.
  const profileDir = mkdtempSync(join(tmpdir(), "pocket-popup-zoom-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    viewport: { width: FRAME.width, height: FRAME.height },
    timeout: 300_000,
  });
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent("serviceworker");
    const page = await context.newPage();
    await page.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    await expect(page.getByText("Two pockets on Stellar")).toBeVisible();

    // What 200% zoom leaves of a 600px popup.
    await page.setViewportSize({ width: FRAME.width, height: 300 });

    const frame = page.locator("#root > div").first();
    await expect
      .poll(async () => Math.round((await frame.boundingBox())!.height), {
        message: "the frame must follow a genuinely short window down",
        timeout: 10_000,
      })
      .toBe(300);
  } finally {
    await context.close();
    rmSync(profileDir, { recursive: true, force: true });
  }
});
