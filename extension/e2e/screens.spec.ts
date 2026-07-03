import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { deriveEd25519 } from "../src/core/keys/sep5";

// Screen behaviour that a screenshot cannot catch: what a button submits, and
// what the one-and-only showing of the recovery phrase actually puts on the
// clipboard.
const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, "../.output/chrome-mv3");
const PASSWORD = "a-strong-password";

async function launch(): Promise<{ ctx: BrowserContext; id: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pocket-screens-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  return { ctx, id: new URL(sw.url()).host, dir };
}

async function popup(ctx: BrowserContext, id: string): Promise<Page> {
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
  return page;
}

/** The 24 words as a user gets them out of the backup step by selecting them. */
async function selectedPhrase(page: Page): Promise<string> {
  return await page.evaluate(() => {
    const cell = [...document.querySelectorAll("span")].find((s) =>
      /^\d+\.\s\w+$/.test((s.textContent || "").trim()),
    );
    if (!cell?.parentElement) throw new Error("no word grid on screen");
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(cell.parentElement);
    sel.addRange(range);
    const text = sel.toString().replace(/\s+/g, " ").trim();
    sel.removeAllRanges();
    return text;
  });
}

test("the phrase the backup step hands over is one that restores the wallet", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    await page.getByRole("button", { name: "Create a new wallet" }).click();
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create wallet" }).click();
    await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });

    // Watch what the copy button hands to the clipboard. Reading the OS
    // clipboard back needs a permission this extension deliberately does not
    // request, so the assertion is made at the API boundary.
    await page.evaluate(() => {
      (window as unknown as { __copied?: string }).__copied = undefined;
      const real = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (s: string) => {
        (window as unknown as { __copied?: string }).__copied = s;
        return real(s);
      };
    });
    await page.getByRole("button", { name: /^Copy/ }).click();
    const copied = await page.evaluate(
      () => (window as unknown as { __copied?: string }).__copied ?? "",
    );

    // Both routes out of this screen must agree, and both must be usable.
    const selected = await selectedPhrase(page);
    expect(selected).toBe(copied);
    expect(copied.split(" ")).toHaveLength(24);
    // The defect this test exists for: the numbering used to be part of the
    // copied text, and the words were not even separated, so what a user
    // saved was "1. elevator2. surround3. noble".
    expect(copied).not.toMatch(/\d/);
    expect(validateMnemonic(copied, wordlist)).toBe(true);

    // And it is not merely well-formed: it derives the account this wallet is
    // about to use. Same derivation the extension itself uses.
    await page.getByRole("button", { name: "I have written it down" }).click();
    await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Receive" }).click();
    const shown = (await page.getByText(/^G[A-Z2-7]{55}$/).first().innerText()).replace(/\s/g, "");
    const derived = deriveEd25519(mnemonicToSeedSync(copied), 0).publicKey();
    expect(derived).toBe(shown);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cancel never submits a form, and the submit button still does", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    await page.getByRole("button", { name: "Create a new wallet" }).click();
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create wallet" }).click();
    await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "I have written it down" }).click();
    await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Lock wallet" }).click();

    // Enter in the password field must still unlock: the fix that stops Cancel
    // submitting is a default of type="button", which silently breaks every
    // form that relied on the old implicit submit.
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });

    // Clicking Unlock must work too.
    await page.getByRole("button", { name: "Lock wallet" }).click();
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });

    // Now the erase-and-restore form, where a stray submit destroys the wallet.
    // Fill it with everything a real erase needs, then press Cancel.
    await page.getByRole("button", { name: "Lock wallet" }).click();
    await page.getByRole("button", { name: "Forgot your password?" }).click();
    await page.getByRole("button", { name: "I understand, continue" }).click();
    const phrase = Array.from({ length: 24 }, () => "abandon").join(" ");
    await page.getByRole("textbox", { name: /Recovery phrase/ }).fill(phrase);
    await page.getByRole("textbox", { name: "New password", exact: true }).fill(PASSWORD);
    await page.getByRole("textbox", { name: "Confirm new password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Cancel" }).click();

    // Cancel means cancel: back on the unlock screen, nothing erased, and the
    // original password still opens the wallet.
    await expect(page.getByText(/Enter your password to continue/)).toBeVisible();
    await expect(page.getByText(/Restoring/)).toHaveCount(0);
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the private pocket's actions are reachable in a 600px popup", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    // Chrome caps a toolbar popup at 600px tall. Anything below that is not
    // awkward, it is unclickable.
    await page.setViewportSize({ width: 360, height: 600 });
    await page.getByRole("button", { name: "Create a new wallet" }).click();
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create wallet" }).click();
    await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });

    // The backup step is the tallest screen in onboarding.
    await expect(page.getByRole("button", { name: "I have written it down" })).toBeInViewport();
    await page.getByRole("button", { name: "I have written it down" }).click();
    await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });

    await expect(page.getByRole("button", { name: "Send" })).toBeInViewport();
    await expect(page.getByRole("button", { name: "Set up private pocket" })).toBeInViewport();

    // Receive expands the home screen by a full address block.
    await page.getByRole("button", { name: "Receive" }).click();
    await expect(page.getByRole("button", { name: "Set up private pocket" })).toBeInViewport();
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
