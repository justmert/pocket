import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The receiving half of a confidential transfer, which nothing had ever tested.
//
// Every component of the sending path was proven: the proof verifies, the
// transfer lands, both auditor channels populate. Nobody had opened the wallet
// that RECEIVED one. When they did, it read "Records do not match the ledger"
// and the money was on chain and unreachable, because decryptIncomingTransfer
// was written, tested, exported and called by nothing.
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");
const PASSWORD = "a strong test password";
const FRIENDBOT = "https://friendbot.stellar.org";

interface Wallet {
  ctx: BrowserContext;
  page: Page;
  dir: string;
  address: string;
}

async function launchWallet(): Promise<Wallet> {
  const dir = mkdtempSync(join(tmpdir(), "pocket-inbound-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);

  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
  await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "I have written it down" }).click();
  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Receive" }).click();
  const address = (await page.locator("div[style*='break-all']").innerText()).replace(/\s/g, "");
  const funded = await fetch(`${FRIENDBOT}?addr=${address}`);
  expect(funded.ok, `friendbot must fund ${address}`).toBe(true);
  await page.reload();
  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: 30_000 });
  return { ctx, page, dir, address };
}

/** Register, shield and merge, so the wallet can send. */
async function fundPrivate(w: Wallet, amount: string): Promise<void> {
  await w.page.getByRole("button", { name: /private pocket/i }).click();
  await expect(w.page.getByText(/Not set up yet/)).toBeVisible({ timeout: 60_000 });
  await w.page.getByRole("button", { name: "Set up the private pocket" }).click();
  await expect(w.page.getByText(/What this does/)).toBeVisible({ timeout: 180_000 });
  await w.page.getByRole("button", { name: "Approve" }).click();
  await expect(w.page.getByText(/Confirmed on the ledger/)).toBeVisible({ timeout: 240_000 });

  await expect(w.page.getByText(/SPENDABLE/)).toBeVisible({ timeout: 120_000 });
  await w.page.getByRole("button", { name: "Move in" }).click();
  await w.page.getByRole("textbox", { name: "Amount" }).fill(amount);
  await w.page.getByRole("button", { name: "Review" }).click();
  await expect(w.page.getByText(/deposit amount is PUBLIC/)).toBeVisible({ timeout: 120_000 });
  await w.page.getByRole("button", { name: "Approve" }).click();
  await expect(w.page.getByText(/Made spendable in a second transaction/)).toBeVisible({
    timeout: 240_000,
  });
}

test("a received confidential transfer is credited, not reported as diverged", async () => {
  test.setTimeout(900_000);
  const sender = await launchWallet();
  const recipient = await launchWallet();

  try {
    // Both need a registered pocket: a transfer needs the recipient's viewing
    // key, which only exists once they have registered.
    await fundPrivate(sender, "30");
    await fundPrivate(recipient, "10");

    // Send privately, sender to recipient.
    await sender.page.getByRole("button", { name: "Send privately" }).click();
    await sender.page.getByRole("textbox", { name: "To", exact: true }).fill(recipient.address);
    await sender.page.getByRole("textbox", { name: "Amount" }).fill("7");
    await sender.page.getByRole("button", { name: "Review" }).click();
    await expect(sender.page.getByText(/AMOUNT is hidden/)).toBeVisible({ timeout: 120_000 });
    await sender.page.getByRole("button", { name: "Approve" }).click();
    await expect(sender.page.getByText(/Confirmed on the ledger/)).toBeVisible({
      timeout: 240_000,
    });

    // THE ASSERTION. Reopen the recipient's pocket and look.
    await recipient.page.reload();
    await expect(recipient.page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: 30_000 });
    await recipient.page.getByRole("button", { name: /private pocket/i }).click();

    // It must NOT say the records disagree with the ledger. That was the bug:
    // the credit is on chain, the device knows nothing, and the pocket refuses
    // to spend from a state it cannot verify.
    await expect(recipient.page.getByText(/Records do not match the ledger/)).toHaveCount(0);
    await expect(recipient.page.getByText(/SPENDABLE/)).toBeVisible({ timeout: 120_000 });

    // And the money must be there, in the receiving side, one signature from
    // spendable.
    await expect(recipient.page.getByText(/RECEIVING/)).toBeVisible();
    await expect(recipient.page.getByRole("button", { name: "Make spendable" })).toBeVisible({
      timeout: 60_000,
    });
    console.log(`  recipient ${recipient.address.slice(0, 8)}… credited an inbound transfer`);
  } finally {
    await sender.ctx.close();
    await recipient.ctx.close();
    rmSync(sender.dir, { recursive: true, force: true });
    rmSync(recipient.dir, { recursive: true, force: true });
  }
});
