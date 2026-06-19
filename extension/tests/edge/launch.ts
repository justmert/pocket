// T2's launcher. Minimal on purpose: a real Chrome, the real built extension,
// a throwaway profile per test so nothing is shared between workers.
//
// This is T2's temporary copy. tests/support/** belongs to T1; when T1's
// launcher lands this file is deleted and every spec here imports theirs.
import { test as base, chromium, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
export const EXT = resolve(here, "../../.output/chrome-mv3");

/** Long enough for scrypt on a loaded CI box, short enough to fail a hang. */
export const SLOW = 45_000;

export interface Pocket {
  ctx: BrowserContext;
  /** The extension id, i.e. the host of chrome-extension:// URLs. */
  id: string;
  /** A fresh popup page. Every call opens another one. */
  popup(): Promise<Page>;
}

export const test = base.extend<{ pocket: Pocket }>({
  pocket: async ({}, use) => {
    const dir = mkdtempSync(join(tmpdir(), "pocket-t2-"));
    const ctx = await chromium.launchPersistentContext(dir, {
      channel: "chromium",
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    });
    let [sw] = ctx.serviceWorkers();
    if (!sw) sw = await ctx.waitForEvent("serviceworker");
    const id = new URL(sw.url()).host;
    await use({
      ctx,
      id,
      popup: async () => {
        const page = await ctx.newPage();
        await page.goto(`chrome-extension://${id}/popup.html`);
        return page;
      },
    });
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  },
});

export { expect } from "@playwright/test";

export const PASSWORD = "a-strong-password";

/** Create a wallet and land on the home screen. Returns the recovery phrase. */
export async function onboard(page: Page, password = PASSWORD): Promise<string> {
  const { expect } = await import("@playwright/test");
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("textbox", { name: "Confirm password" }).fill(password);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Write this down")).toBeVisible({ timeout: SLOW });
  const words = await page
    .locator("span")
    .filter({ hasText: /^\d+\.\s\w+\s*$/ })
    .allInnerTexts();
  const phrase = words.map((w) => w.replace(/^\d+\.\s*/, "").trim()).join(" ");
  await page.getByRole("button", { name: "I have written it down" }).click();
  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: SLOW });
  return phrase;
}

/** The wallet's own address, read from the Receive panel exactly as a user does. */
export async function receiveAddress(page: Page): Promise<string> {
  const { expect } = await import("@playwright/test");
  await page.getByRole("button", { name: "Receive" }).click();
  await expect(page.getByText("Your address")).toBeVisible();
  const shown = await page.locator("div[style*='break-all']").first().innerText();
  await page.getByRole("button", { name: "Receive" }).click();
  return shown.replace(/\s/g, "");
}

/**
 * Fund an account for real. Friendbot, not a stub: the balance read under test
 * is the wallet's own RPC call and must see a real ledger entry.
 */
export async function fund(address: string): Promise<void> {
  const res = await fetch(`https://friendbot.stellar.org?addr=${address}`);
  if (!res.ok) {
    const body = await res.text();
    // Already funded is not a failure; anything else is.
    if (!body.includes("op_already_exists") && !body.includes("createAccountAlreadyExist")) {
      throw new Error(`friendbot refused to fund ${address}: ${res.status} ${body.slice(0, 300)}`);
    }
  }
}

/** Open Send and fill the compose form. Leaves the user on compose. */
export async function compose(
  page: Page,
  fields: { to?: string; amount?: string; memo?: string },
): Promise<void> {
  const { expect } = await import("@playwright/test");
  const recipient = page.getByRole("textbox", { name: "Recipient" });
  if (!(await recipient.isVisible())) {
    await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
    await page.getByRole("button", { name: "Send" }).click();
  }
  await expect(recipient).toBeVisible();
  if (fields.to !== undefined)
    await page.getByRole("textbox", { name: "Recipient" }).fill(fields.to);
  if (fields.amount !== undefined)
    await page.getByRole("textbox", { name: "Amount (XLM)" }).fill(fields.amount);
  if (fields.memo !== undefined)
    await page.getByRole("textbox", { name: "Memo (optional)" }).fill(fields.memo);
}
