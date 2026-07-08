// D-002: the wallet does not offer an operation it already knows cannot succeed.
//
// Found by hand, in exploratory session 1, not by any tier. A brand new unfunded
// account showed "Not open yet" and "This account does not exist on the network
// yet" — and the bottom bar still offered "Send privately", which opened a full
// compose form. Filling it in and pressing Review spent two seconds on
// "Checking" and then said "Something went wrong. Try again, and check your
// connection."
//
// Three separate wrongs in one flow: an action offered that cannot work, a form
// that accepts a destination and an amount for an account that does not exist,
// and a refusal blamed on the user's connection. This file guards the first,
// which is the one that makes the other two unreachable.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

async function stubPocket(page: Page, pocket: Record<string, unknown> | null): Promise<void> {
  await page.addInitScript((p) => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      if (msg?.type === "privatePocket") {
        return p === null ? { ok: false, error: "no pocket" } : { ok: true, data: p };
      }
      if (msg?.type === "status") {
        const real = await send(msg);
        if (real?.ok) return { ok: true, data: { ...real.data, privateAvailable: true } };
        return real;
      }
      return send(msg);
    };
  }, pocket);
}

/** every state in which there is nothing to send from. */
const NOT_SPENDABLE = ["unavailable", "unfunded", "unregistered", "archived", "needsRecovery", "diverged"];

for (const state of NOT_SPENDABLE) {
  test(`the private send explains itself rather than offering a form while the pocket is "${state}"`, async ({ wallet }) => {
    test.setTimeout(4 * 60_000);
    const page = wallet.page;
    await stubPocket(page, { state, message: "x" });
    await wallet.createWallet(PASSWORD);
    await page.reload();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPocket("Private pocket");

    const send = page.getByRole("button", { name: "Send privately" });
    await expect(send, "the slot must stay in place: the bar has five in both pockets").toBeVisible();
    await send.click();

    // The sheet opens and ANSWERS. What must not happen is a compose form: a
    // destination and an amount accepted for an account that cannot spend.
    const sheet = page.locator("[role='dialog']");
    await expect(sheet).toHaveCount(1);
    await expect(
      sheet.getByRole("textbox", { name: "To", exact: true }),
      `a compose form opened while the private pocket was "${state}" — the wallet offered to send from an account it already knows cannot`,
    ).toHaveCount(0);
    await expect(
      sheet.getByRole("button", { name: /^Review$/ }),
      "a review control was offered for an operation that cannot be built",
    ).toHaveCount(0);

    // And it says which state it is in, rather than one sentence for all six.
    const said = await sheet.innerText();
    expect(said.length, "the sheet opened and explained nothing").toBeGreaterThan(30);
    expect(
      said,
      "the explanation must name a route out, not just a refusal",
    ).toMatch(/Open the private pocket/i);
  });
}

test("the private send is live again as soon as the pocket is ready", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  // The other half of the assertion: a guard that is always on is not a guard,
  // it is a removed feature.
  await stubPocket(page, { state: "ready", spendable: "5.0000000" });
  await wallet.createWallet(PASSWORD);
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPocket("Private pocket");

  const send = page.getByRole("button", { name: "Send privately" });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.locator("[role='dialog']")).toHaveCount(1);
});

test("the public send is never affected by the private pocket's state", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await stubPocket(page, { state: "unregistered" });
  await wallet.createWallet(PASSWORD);
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);

  // The public pocket is a different account with a different balance and the
  // private pocket's state says nothing about it.
  const send = page.getByRole("button", { name: "Send", exact: true });
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.locator("[role='dialog']")).toHaveCount(1);
});
