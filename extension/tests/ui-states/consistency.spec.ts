// The A10 set: four places where the same idea was rendered two ways, and one
// where the way out lost what had been typed.
//
// A10-15. The Move sheet titles itself "Shielding" at 24px, and the review it
// contains rendered the same string again immediately below at 12px uppercase.
// A10-04. That review's way out went to the operation picker rather than to the
// amount form, two steps back, and the amount is cleared only when the sheet
// closes, so a returning user met their own figure already filled in.
// A10-09. The unavailable row carried the same title weight and the same
// accent-filled mark as the live rows above it.
// A10-05. The wallet's own review says what an absent memo costs; the screen
// that authorises a site's transaction said "None."
//
// The private pocket is stubbed into its ready state, because these are
// assertions about how the popup draws a state, and reaching a real ready
// pocket costs a registration, a funding and two proofs.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";
const TO = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

/** answer `privatePocket` as a ready pocket, and build a shield summary. */
async function stubReady(page: Page, mergeAvailable: boolean): Promise<void> {
  await page.evaluate(
    ({ mergeAvailable, to }) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
        if (msg?.type === "privatePocket") {
          return {
            ok: true,
            data: {
              state: "ready",
              spendable: "12.0000000",
              receiving: "0.0000000",
              mergeAvailable,
            },
          };
        }
        if (msg?.type === "buildPrivateOp") {
          return {
            ok: true,
            data: {
              handle: "stub",
              summary: {
                kind: "shield",
                amount: "3.0000000",
                to,
                fee: "0.0000100",
                effects: ["Move 3.0000000 XLM from the public pocket into the private one"],
              },
            },
          };
        }
        return send(msg);
      };
    },
    { mergeAvailable, to: TO },
  );
}

test("the move review does not repeat the sheet's own title", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await stubReady(page, false);

  await wallet.openMove();
  await page.getByRole("button", { name: /Shield/ }).click();
  await page.getByRole("textbox", { name: /Amount/ }).fill("3");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  // The operation is named once on the screen, by the sheet that contains it.
  await expect(
    page.getByText(/^Shielding$/i),
    "the sheet title and the review's overline were the same word, stacked",
  ).toHaveCount(1);
});

test("leaving the move review returns to the form, not past it", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await stubReady(page, false);

  await wallet.openMove();
  await page.getByRole("button", { name: /Shield/ }).click();
  const amount = page.getByRole("textbox", { name: /Amount/ });
  await amount.fill("3");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  await page.getByRole("button", { name: "Back" }).click();
  await expect(
    amount,
    "Back from a review must land on the step before it, with what was typed still there",
  ).toHaveValue("3");
});

test("a row that cannot be pressed is not drawn like one that can", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await stubReady(page, false);

  await wallet.openMove();
  const live = page.getByRole("button", { name: "Shield" });
  await expect(live).toBeVisible({ timeout: WAITS.proving });
  const inert = page.getByText("Make spendable", { exact: true });
  await expect(inert).toBeVisible();

  const colours = await Promise.all(
    [live.getByText("Shield", { exact: true }), inert].map((l) =>
      l.evaluate((el) => getComputedStyle(el).color),
    ),
  );
  expect(
    colours[1],
    "the row that does nothing was set in the same ink as the two that do",
  ).not.toBe(colours[0]);
});

test("the dapp approval says what an absent memo costs", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // The popup reads a parked request when it mounts, so the stub has to be in
  // place before the mount rather than after it.
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      if (msg?.type === "pendingDappRequest") {
        return {
          ok: true,
          data: {
            id: "stub",
            origin: "https://example.test",
            summary: {
              decoded: true,
              source: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
              fee: "100",
              network: "testnet",
              effects: ["Payment of 1.0000000 XLM"],
            },
          },
        };
      }
      return send(msg);
    };
  });
  await page.reload();

  await expect(page.getByText("example.test")).toBeVisible({ timeout: WAITS.ledgerRead });
  await expect(
    page.getByText(/Exchanges usually require one; a deposit without it can be lost/),
    "the screen that knows least about what it is signing said the least about it",
  ).toBeVisible();
});
