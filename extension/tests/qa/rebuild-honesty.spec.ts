// D-009 and D-010: the wallet does not offer a rebuild it cannot perform.
//
// Found by two independent re-audit lanes. A shipped build has no archive —
// `archiveUrl` comes from `import.meta.env.VITE_ARCHIVE_URL`, which only
// `.env.development` sets and `wxt build` does not load — so `rebuildFromHistory`
// refuses on its first line, at day 1 and at day 100 alike. The copy branched on
// that config from batch 6 onwards. The CONTROLS did not, so a user was told
// "your balances cannot be rebuilt" and handed a button labelled "Rebuild from
// history", and could only learn which was true by pressing it.
//
// D-010 is the sharper half. The dormant state's rebuild could never work even
// with an archive: `rebuildFromHistory` reads the confidential account before it
// reads any archive, and for an archived entry that read returns null — the very
// condition that makes the state archived. The button answered "This account has
// no private pocket yet." to someone holding a private balance and looking at it.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

async function stubPocket(page: Page, pocket: Record<string, unknown>): Promise<void> {
  await page.addInitScript((p) => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      if (msg?.type === "privatePocket") return { ok: true, data: p };
      if (msg?.type === "status") {
        const real = await send(msg);
        if (real?.ok) return { ok: true, data: { ...real.data, privateAvailable: true } };
        return real;
      }
      return send(msg);
    };
  }, pocket);
}

test("the dormant pocket offers no rebuild, because that route denies the account exists", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await stubPocket(page, { state: "archived", spendable: "8.0000000", message: "This pocket went dormant." });
  await wallet.createWallet(PASSWORD);
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPocket("Private pocket");
  await wallet.openMove();

  const sheet = page.locator("[role='dialog']");
  await expect(sheet.getByText("Dormant").first()).toBeVisible({ timeout: WAITS.ledgerRead });

  // Reactivate stays: it is the route that can actually run.
  await expect(sheet.getByRole("button", { name: /^Reactivate$/ })).toBeVisible();

  // The rebuild does not, in any wording.
  await expect(
    sheet.getByRole("button", { name: /rebuild/i }),
    "the dormant state offered a rebuild that answers 'this account has no private pocket yet' to someone holding a private balance",
  ).toHaveCount(0);
  await expect(
    sheet.getByText(/rebuilt from your history/i),
    "the dormant state promised a rebuild route that cannot run",
  ).toHaveCount(0);

  // And it still says where the money is, rather than going quiet.
  await expect(sheet.getByText(/on the ledger/i)).toBeVisible();
});

for (const state of ["needsRecovery", "diverged"] as const) {
  test(`the "${state}" state states why it cannot rebuild instead of offering a button`, async ({
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const page = wallet.page;
    await stubPocket(page, { state, message: "This device's record is behind the contract." });
    await wallet.createWallet(PASSWORD);
    await page.reload();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPocket("Private pocket");
    await wallet.openMove();

    const sheet = page.locator("[role='dialog']");
    await expect(sheet.getByText(/Needs rebuilding|Out of step/).first()).toBeVisible({
      timeout: WAITS.ledgerRead,
    });

    // This build has no archive, so the control is absent and the reason is on
    // screen. A primary button three lines under a sentence saying it cannot be
    // done is the product arguing with itself.
    await expect(
      sheet.getByRole("button", { name: /rebuild/i }),
      "a rebuild was offered on a build that has no archive to replay from",
    ).toHaveCount(0);
    await expect(
      sheet.getByText(/this build has none configured|has none configured/i),
      "the state must say why there is no way forward from here",
    ).toBeVisible();
    await expect(
      sheet.getByText(/not lost|on the ledger/i),
      "a user in this state needs to know the money still exists",
    ).toBeVisible();
  });
}

test("settings does not offer a rebuild this build cannot perform", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await page.getByRole("button", { name: "Settings" }).click();

  // It was gated only on the network having a confidential deployment, which is
  // always true on testnet — so it was shown to every user, including wallets
  // with no private pocket at all.
  await expect(
    page.getByRole("button", { name: /rebuild/i }),
    "settings offered a rebuild to a build with no archive, and to a wallet with no private pocket",
  ).toHaveCount(0);
});
