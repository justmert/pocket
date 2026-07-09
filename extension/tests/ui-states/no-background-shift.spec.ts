// Opening a sheet must not move the screen behind it.
//
// This shipped once. `Sheet` focuses its first field (or itself) so the next
// keystroke lands in the form, and focusing an element makes the browser scroll
// its scrollable ancestor to reveal it. The sheet sits at `bottom: 0` inside the
// frame's scroll container, so revealing it dragged everything above it out of
// view: measured at the real frame, the title went from y=18 to y=-465 and the
// bottom bar from y=520 to y=37, one frame after the sheet mounted. Behind a 6px
// blur that reads as the backdrop tearing.
//
// `focus({ preventScroll: true })` is the fix, and this is what keeps it fixed.
// Geometry, not appearance: a screenshot at rest cannot see a lurch that settles
// before the shot is taken.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

/** The rects of things that live BEHIND a sheet, by held reference. */
async function watchBehind(page: Page): Promise<void> {
  await page.evaluate(() => {
    // Resolved once, before any sheet exists, and kept. Re-running a selector
    // per sample silently retargets: a sheet header is an h1 too, so "the title
    // moved" would really be two different elements.
    const w = window as unknown as { __behind?: Record<string, Element | null> };
    w.__behind = {
      title: document.querySelector("h1"),
      nav: document.querySelector("nav"),
    };
  });
}

async function rectsBehind(page: Page): Promise<Record<string, number[]>> {
  return page.evaluate(() => {
    const w = window as unknown as { __behind: Record<string, Element | null> };
    const out: Record<string, number[]> = {};
    for (const [k, el] of Object.entries(w.__behind)) {
      if (!el || !el.isConnected) continue;
      const r = el.getBoundingClientRect();
      out[k] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)];
    }
    return out;
  });
}

/** Every sheet reachable without funding an account, and how a person opens it. */
const SHEETS: { name: string; open: (page: Page) => Promise<void> }[] = [
  {
    name: "receive",
    open: (page) => page.getByRole("button", { name: "Receive", exact: true }).click(),
  },
  {
    name: "move",
    open: (page) => page.getByRole("button", { name: "Move", exact: true }).click(),
  },
  {
    name: "network",
    open: async (page) => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: /^Network/ }).click();
    },
  },
  {
    name: "connected sites",
    open: async (page) => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: /^Connected sites/ }).click();
    },
  },
  {
    name: "erase",
    open: async (page) => {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: /^Erase this wallet/ }).click();
    },
  },
];

for (const sheet of SHEETS) {
  test(`opening the ${sheet.name} sheet does not move the screen behind it`, async ({ wallet }) => {
    test.setTimeout(WAITS.onboarding + 90_000);
    const page = wallet.page;
    // The real frame. Above 800px the stylesheet centres a 384px frame instead,
    // which is the tab layout and not what a user sees from the toolbar. The
    // scroll container differs between the two, and the scroll container is
    // exactly what this test is about.
    await page.setViewportSize({ width: 384, height: 600 });
    await wallet.createWallet(PASSWORD);
    await wallet.waitForHome();

    await sheet.open(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    await watchBehind(page);
    const before = await rectsBehind(page);
    await page.getByRole("button", { name: /close/i }).first().click();
    await expect(page.getByRole("dialog")).toBeHidden();

    // Reopen with the screen behind already measured, which is the moment the
    // lurch happened: one frame after mount, while the card is still sliding.
    await watchBehind(page);
    const settled = await rectsBehind(page);
    await sheet.open(page);
    await expect(page.getByRole("dialog")).toBeVisible();
    const during = await rectsBehind(page);

    expect(Object.keys(settled).length, "found nothing behind the sheet to measure").toBeGreaterThan(
      0,
    );
    for (const [key, base] of Object.entries(settled)) {
      expect(during[key], `${key} vanished while the sheet opened`).toBeDefined();
      expect(during[key], `${key} moved while the ${sheet.name} sheet opened`).toEqual(base);
    }
    // `before` is only read to prove the first open was real; if it found
    // nothing, the selectors are wrong and the assertions above are vacuous.
    expect(Object.keys(before).length).toBeGreaterThan(0);
  });
}
