// Phase F's resilience tier: the three things a 384px column breaks under.
//
// A narrow, fixed-width popup is where translated copy, long figures and a
// mirrored reading order all fail first, and all three failures are cheap to
// find and cheap to fix. None of them can be reached by looking at the product
// in English at a normal balance, which is the only way it is ever looked at.
//
// The inflation is applied to the rendered text rather than to a locale,
// because the product ships one locale and the question is whether the LAYOUT
// survives longer strings, not whether a translation exists.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";
import { expectLayoutHolds, FRAME, settle } from "./audit";

const PASSWORD = "a-strong-test-password";

/**
 * grow every run of visible text by forty percent, in place.
 *
 * words are lengthened rather than duplicated: a duplicated word wraps at the
 * space it already had, which is the case that already works. Lengthening a
 * word is what a german or finnish compound does to a button.
 */
async function inflate(page: Page, factor = 1.4): Promise<void> {
  await page.evaluate((factor) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
    for (const n of nodes) {
      const v = n.nodeValue ?? "";
      if (!/[A-Za-z]{3}/.test(v)) continue;
      n.nodeValue = v.replace(/[A-Za-z]{3,}/g, (w) => {
        const extra = Math.round(w.length * (factor - 1));
        return w + w.slice(1, 1 + extra).toLowerCase();
      });
    }
  }, factor);
}

test("every screen holds its layout with forty percent more text", async ({ wallet }) => {
  test.setTimeout(5 * 60_000);
  const page = wallet.page;
  await page.setViewportSize(FRAME);

  // Inflation rewrites every text node, which includes the accessible name of
  // every control: "Back" becomes "Backack" and cannot be found by name again.
  // So the flow is only ever DRIVEN on real copy, and each screen is inflated
  // as the last thing that happens to it before it is measured. A reload puts
  // the real strings back.
  await inflate(page);
  await expectLayoutHolds(page, "onboarding/choose with inflated copy");

  await page.reload();
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await settle(page);
  await inflate(page);
  await expectLayoutHolds(page, "onboarding/create with inflated copy");

  await page.reload();
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await inflate(page);
  await expectLayoutHolds(page, "home with inflated copy");

  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Send", exact: true }).click();
  await settle(page);
  await inflate(page);
  await expectLayoutHolds(page, "send/compose with inflated copy");
});

test("the largest figure stellar can hold still fits its column", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await page.setViewportSize(FRAME);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // Stroops are an int64, so this is the largest balance that can exist. It is
  // also the longest string the amount type can ever be handed.
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      if (msg?.type === "balances") {
        return {
          ok: true,
          data: [
            {
              id: "native",
              code: "XLM",
              amount: "922337203685.4775807",
              total: "922337203685.4775807",
              reserved: "0.0000000",
              authorized: true,
            },
          ],
        };
      }
      return send(msg);
    };
  });
  await page.reload();
  await expect(page.getByText(/922,337,203,685/)).toBeVisible({ timeout: WAITS.ledgerRead });
  await expectLayoutHolds(page, "home at the largest balance an int64 can hold");
});

test("a mirrored reading order does not push anything off screen", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await page.setViewportSize(FRAME);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  await page.evaluate(() => {
    document.documentElement.setAttribute("dir", "rtl");
  });
  await settle(page);
  // `expectLayoutHolds` carries a right-edge check and a direction-agnostic one.
  // Mirrored, it is the second that does the work: an element wider than its own
  // box, and a document wider than its window, are both still true when the
  // spill runs the other way. The right-edge list simply stays empty here.
  await expectLayoutHolds(page, "home mirrored");

  await page.getByRole("button", { name: "Receive" }).click();
  await settle(page);
  // The address is the case that matters: it is the one string in the product
  // that must never be reordered, whatever direction the page reads in.
  await expectLayoutHolds(page, "receive mirrored");
  const shown = await page.getByText(/^G[A-Z2-7]{55}$/).first().innerText();
  expect(shown.replace(/\s/g, ""), "a mirrored page reordered an address").toMatch(
    /^G[A-Z2-7]{55}$/,
  );
});
