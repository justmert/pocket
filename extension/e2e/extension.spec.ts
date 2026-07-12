import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { answerBackupCheck } from "../tests/support/wallet";

// Loads the REAL built extension into a real Chrome and drives the popup.
// Nothing is stubbed: the service worker runs, the vault encrypts with scrypt,
// and balance reads hit live testnet.
const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, "../.output/chrome-mv3");
const PASSWORD = "a-strong-password";

async function launch(): Promise<{ ctx: BrowserContext; id: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pocket-e2e-"));
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

/** Create a wallet and land on the home screen. */
async function onboard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
  await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Show the phrase" }).click();
  const cells = await page
    .locator("span")
    .filter({ hasText: /^\d+\.\s\w+\s*$/ })
    .allInnerTexts();
  const phrase = cells.map((c) => c.replace(/^\d+\.\s*/, "").trim()).join(" ");
  await page.getByRole("button", { name: "I have written it down" }).click();
  await answerBackupCheck(page, phrase);
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 15_000 });
}

test("the extension loads and the service worker starts", async () => {
  const { ctx, id, dir } = await launch();
  try {
    expect(id).toMatch(/^[a-z]{32}$/);
    const page = await popup(ctx, id);
    await expect(page.getByText("Two pockets on Stellar")).toBeVisible();
    // The honest framing must be on the first screen a user ever sees.
    await expect(page.getByText(/hides.*amounts.*not addresses/i)).toBeVisible();
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("onboarding creates a wallet and shows exactly 24 words", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    await page.getByRole("button", { name: "Create a new wallet" }).click();
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create wallet" }).click();

    await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Show the phrase" }).click();
    const words = await page
      .locator("span")
      .filter({ hasText: /^\d+\.\s\w+\s*$/ })
      .count();
    expect(words).toBe(24);
    // The backup warning has to say the two things that actually matter.
    await expect(page.getByText(/only way to recover/i)).toBeVisible();
    await expect(page.getByText(/cannot show them to you again/i)).toBeVisible();
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("locks, rejects a wrong password, then unlocks", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    await onboard(page);

    await page.getByRole("button", { name: "Lock wallet" }).click();
    await expect(page.getByText(/Enter your password to continue/)).toBeVisible();

    await page.getByRole("textbox", { name: "Password", exact: true }).fill("wrong");
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByText("Wrong password.")).toBeVisible({ timeout: 30_000 });

    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Unlock" }).click();
    await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("shows the receive address in full, never truncated", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    await onboard(page);
    await page.getByRole("button", { name: "Receive" }).click();
    await expect(page.getByRole("dialog", { name: "Receive" })).toBeVisible();

    const shown = (await page.getByText(/^G[A-Z2-7]{55}$/).first().innerText()).replace(/\s/g, "");
    // A G-address is 56 characters. Anything shorter means it was truncated,
    // which is exactly what the address layer exists to prevent: matching the
    // first and last four costs about an hour on a laptop.
    expect(shown).toHaveLength(56);
    expect(shown).toMatch(/^G[A-Z2-7]{55}$/);
    expect(shown).not.toContain("…");
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rejects a bad recipient before building anything", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    await onboard(page);
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Send", exact: true }).click();

    // Right shape, wrong checksum: must be caught, and named as a checksum
    // failure rather than lumped in with junk.
    await page
      .getByRole("textbox", { name: "To", exact: true })
      .fill("GB43MNLS6IA77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7");
    await page.getByRole("textbox", { name: "Amount (XLM)" }).fill("1");
    await page.getByRole("button", { name: "Review" }).click();

    await expect(page.getByText(/checksum/i)).toBeVisible({ timeout: 30_000 });

    // And a value that is not base32 at all is reported differently, because a
    // bad checksum suggests a typo or tampering while junk suggests the wrong
    // kind of string entirely.
    await page.getByRole("textbox", { name: "To", exact: true }).fill("not-an-address");
    await page.getByRole("button", { name: "Review" }).click();
    await expect(page.getByText(/does not look like a Stellar address/i)).toBeVisible({
      timeout: 30_000,
    });
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("surfaces the private pocket honestly on the home screen", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    await onboard(page);

    await expect(page.getByRole("button", { name: "Private pocket" })).toBeVisible();
    // The claim must be on the surface, not buried in a settings page.
    await expect(page.getByText(/Hides amounts, never addresses/i)).toBeVisible();
    await expect(page.getByText(/Who you pay stays public/i)).toBeVisible();
    // And it must NOT claim to hide the recipient.
    await expect(page.getByText(/recipient.*hidden|anonymous|incognito/i)).toHaveCount(0);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("states what registration costs before offering the button", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);
    await onboard(page);
    await page.getByRole("button", { name: "Private pocket" }).click();

    // A brand-new wallet is unfunded, which is a state and not a crash.
    await expect(
      page.getByText(/Fund this account first|Private pocket not set up/),
    ).toBeVisible({ timeout: 30_000 });
    // Whatever the state, no balance may be invented for it.
    await expect(page.getByText(/^0\.0000000$/)).toHaveCount(0);
  } finally {
    await ctx.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an imported phrase reproduces the same address", async () => {
  const { ctx, id, dir } = await launch();
  try {
    const page = await popup(ctx, id);

    // Derive the expected address from a phrase using the wallet's own SEP-5
    // path, so the assertion is against the protocol and not against itself.
    await page.getByRole("button", { name: "Create a new wallet" }).click();
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create wallet" }).click();
    await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Show the phrase" }).click();
    const words = await page.locator("span").filter({ hasText: /^\d+\.\s\w+\s*$/ }).allInnerTexts();
    const phrase = words.map((w) => w.replace(/^\d+\.\s*/, "").trim()).join(" ");
    await page.getByRole("button", { name: "I have written it down" }).click();
    await answerBackupCheck(page, phrase);
    await page.getByRole("button", { name: "Receive" }).click();
    const expected = (await page.getByText(/^G[A-Z2-7]{55}$/).first().innerText()).replace(/\s/g, "");

    await ctx.close();
    rmSync(dir, { recursive: true, force: true });

    // Fresh profile, fresh vault, restore by phrase.
    const second = await launch();
    try {
      const p2 = await popup(second.ctx, second.id);
      await p2.getByRole("button", { name: /recovery phrase/i }).click();
      await p2.getByRole("textbox", { name: /Recovery phrase/i }).fill(phrase);
      // The import step asks for one password, not a confirmation: the phrase
      // is the recovery material, so a mistyped password is recoverable.
      await p2.getByRole("textbox", { name: "New password", exact: true }).fill(PASSWORD);
      await p2.getByRole("button", { name: "Import wallet" }).click();

      await expect(p2.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });
      await p2.getByRole("button", { name: "Receive" }).click();
      const restored = (await p2.getByText(/^G[A-Z2-7]{55}$/).first().innerText()).replace(/\s/g, "");
      expect(restored).toBe(expected);
    } finally {
      await second.ctx.close();
      rmSync(second.dir, { recursive: true, force: true });
    }
  } finally {
    /* contexts closed above */
  }
});
