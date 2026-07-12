// Phase F's reactivity tier.
//
// Two properties, both of which a wallet gets to be wrong about exactly once: a
// value that changes must change IN PLACE rather than by rebuilding the subtree
// around it, and a value the wallet has not been told is true must not be shown
// as though it were.
//
// The remount half is not cosmetic. A component declared inside another
// component is a new type on every render, so React unmounts and remounts the
// whole subtree: the odometer restarts from zero, focus is lost, and any
// entrance animation replays as though the screen had just opened. The only way
// to assert it did not happen is to mark a live DOM node and check the same node
// survived the update.
//
// Everything here reads the EXACT node — the visually hidden span carrying the
// unsplit figure — rather than what is on screen. The visible rendering is an
// odometer, so each digit column holds all ten digits and its text is never the
// value: `getByText("7")` would match a column, not a balance.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

/** answer `balances` with whatever the test currently wants it to be. */
async function stubBalance(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __xlm: string };
    w.__xlm = "10.0000000";
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
              amount: w.__xlm,
              total: w.__xlm,
              reserved: "0.0000000",
              authorized: true,
            },
          ],
        };
      }
      return send(msg);
    };
  });
}

/** the hidden span whose text is exactly this figure, if it is on the page. */
const EXACT = (figure: string) => `span:text-is("${figure} XLM")`;

test("a balance that changes changes in place, without rebuilding around it", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await stubBalance(page);
  await wallet.createWallet(PASSWORD);
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await expect(page.locator(EXACT("10.0000000")).first()).toBeAttached({
    timeout: WAITS.ledgerRead,
  });

  // Mark the node carrying the figure. If the subtree is rebuilt the mark goes
  // with it, because a fresh element cannot carry a property set on an old one.
  const marked = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("span")).find(
      (s) => (s.textContent ?? "").trim() === "10.0000000 XLM",
    );
    if (!el) return false;
    (el as unknown as { __mark: number }).__mark = 1;
    return true;
  });
  expect(marked, "the home balance must be on screen before it can be watched").toBe(true);

  // Change it at the source, then make the popup re-read: opening the move sheet
  // refreshes, because the menu it shows is a function of state the ledger owns.
  await page.evaluate(() => {
    (window as unknown as { __xlm: string }).__xlm = "42.0000000";
  });
  await wallet.openMove();
  await page.keyboard.press("Escape");
  await expect(page.locator(EXACT("42.0000000")).first()).toBeAttached({
    timeout: WAITS.ledgerRead,
  });

  const survived = await page.evaluate(() => {
    const el = Array.from(document.querySelectorAll("span")).find(
      (s) => (s.textContent ?? "").trim() === "42.0000000 XLM",
    );
    return Boolean(el && (el as unknown as { __mark?: number }).__mark === 1);
  });
  expect(
    survived,
    "the balance was replaced rather than updated: the node carrying it is a different node, so the subtree was remounted",
  ).toBe(true);
});

test("nothing is shown as spent until the ledger has said so", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await stubBalance(page);
  await wallet.createWallet(PASSWORD);

  // The build succeeds and the submit fails, which is the shape an optimistic
  // update would be caught by: if the popup had decremented the balance on
  // approval, this is where it would be wrong and stay wrong.
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      if (msg?.type === "buildPayment") {
        return {
          ok: true,
          data: {
            xdr: "stub",
            summary: {
              decoded: true,
              to: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
              amount: "3.0000000",
              assetCode: "XLM",
              fee: "100",
              network: "testnet",
              effects: ["Send 3.0000000 XLM"],
            },
          },
        };
      }
      if (msg?.type === "confirmPayment") {
        return { ok: false, error: "The network refused this transaction." };
      }
      return send(msg);
    };
  });
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);

  await page.getByRole("button", { name: "Send" }).click();
  await page
    .getByRole("textbox", { name: "To", exact: true })
    .fill("GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H");
  await page.getByRole("textbox", { name: /Amount/ }).fill("3");
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();

  await expect(page.getByText(/network refused/i)).toBeVisible({ timeout: WAITS.proving });
  await page.keyboard.press("Escape");

  // Ten, not seven. The wallet was never told the payment landed.
  await expect(
    page.locator(EXACT("7.0000000")),
    "a refused payment left the balance showing what it would have been",
  ).toHaveCount(0);
  await expect(page.locator(EXACT("10.0000000")).first()).toBeAttached();
});
