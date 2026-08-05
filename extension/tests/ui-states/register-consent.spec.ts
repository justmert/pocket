// A1-01 / A2-07: the register review offered a way out labelled "Back", on a
// step whose first transaction is already on the ledger and whose auditor
// binding is permanent. Returning to the menu then re-offered the same decision
// in the present tense, as though nothing had happened.
//
// The screen is driven from a stubbed worker rather than a real registration,
// because the point is what the popup SAYS about a transaction that has already
// been sent, and paying a real fee to assert a string would be the wrong trade.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

test("the register review never calls its way out a cancel", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // The worker answers as it does once the first transaction has landed: a
  // handle, and a summary of the SECOND transaction.
  await wallet.page.evaluate(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: {
      type?: string;
      op?: { kind?: string };
    }) => {
      if (msg?.type === "privatePocket") {
        return {
          ok: true,
          data: {
            state: "unregistered",
            message: "Setting up a private pocket is a one-time, publicly visible transaction.",
          },
        };
      }
      if (msg?.type === "buildPrivateOp" && msg.op?.kind === "register") {
        return {
          ok: true,
          data: {
            handle: "stub",
            summary: {
              kind: "register",
              fee: "0.0000100",
              effects: [
                "Create a confidential account for this address",
                "Bind your OWN auditor key, derived from your recovery phrase",
              ],
            },
          },
        };
      }
      return send(msg);
    };
  });

  await wallet.openMove();
  await wallet.page.getByRole("button", { name: "Set up the private pocket" }).click();
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  // What has already happened is stated on the screen that could otherwise be
  // read as "nothing has happened yet".
  await expect(
    wallet.page.getByText(/auditor key is already registered on the ledger/i),
    "the review must say what pressing the previous button already did",
  ).toBeVisible();

  // And the way out is not called Back, because there is nothing to go back to.
  await expect(
    wallet.page.getByRole("button", { name: "Back" }),
    "a step that has already spent something irreversible may not offer a cancel",
  ).toHaveCount(0);
  const out = wallet.page.getByRole("button", { name: "Leave this for now" });
  await expect(out).toBeVisible();

  // Leaving returns to the menu, and the menu must not re-offer the first
  // transaction as though it were still to come.
  await out.click();
  await expect(
    wallet.page.getByText(/first of the two transactions has already been sent/i),
    "the menu must not describe a sent transaction in the future tense",
  ).toBeVisible();
  await expect(wallet.page.getByText(/sends the first one straight away/i)).toHaveCount(0);
  await expect(wallet.page.getByRole("button", { name: "Finish setting up" })).toBeVisible();
});
