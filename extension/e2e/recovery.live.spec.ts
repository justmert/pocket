import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Recovery from the durable archive: the thing the README says `indexer/`
// exists for and that nothing could actually do until now.
//
// The scenario is the real one. A user has a funded private pocket, loses the
// local openings (a wiped device, a reinstall, a corrupted profile), and the
// chain still holds their commitments. Without a replay those funds are
// visible and permanently unspendable. This deletes the openings for real and
// asserts the wallet rebuilds them and agrees with the contract.
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");
const PASSWORD = "a strong test password";
const FRIENDBOT = "https://friendbot.stellar.org";
const ARCHIVE = "http://127.0.0.1:8787";
const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";

let ctx: BrowserContext;
let page: Page;
let dir: string;
let address: string;

test.beforeAll(async () => {
  // The archive must be up, or this test would pass vacuously by never
  // reaching the replay at all.
  const health = await fetch(`${ARCHIVE}/v1/health?contract_id=${TOKEN}`).catch(() => null);
  test.skip(!health?.ok, "archive not running on 127.0.0.1:8787");

  dir = mkdtempSync(join(tmpdir(), "pocket-recover-"));
  ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("a funded private pocket whose openings are gone rebuilds from the archive", async () => {
  test.setTimeout(900_000);

  // Set up a real private pocket with real money in it.
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
  await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "I have written it down" }).click();
  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: 30_000 });

  await page.getByRole("button", { name: "Receive" }).click();
  address = (await page.locator("div[style*='break-all']").innerText()).replace(/\s/g, "");
  expect((await fetch(`${FRIENDBOT}?addr=${address}`)).ok).toBe(true);
  await page.reload();

  await page.getByRole("button", { name: /private pocket/i }).click();
  await expect(page.getByText(/Not set up yet/)).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Set up the private pocket" }).click();
  await expect(page.getByText(/What this does/)).toBeVisible({ timeout: 180_000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Confirmed on the ledger/)).toBeVisible({ timeout: 240_000 });

  await expect(page.getByText(/SPENDABLE/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Move in" }).click();
  await page.getByRole("textbox", { name: "Amount" }).fill("20");
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByText(/deposit amount is PUBLIC/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Made spendable in a second transaction/)).toBeVisible({
    timeout: 240_000,
  });

  // Make the archive aware of it, as a running deployment would be.
  const ingest = await fetch(`${ARCHIVE}/v1/health?contract_id=${TOKEN}`);
  expect(ingest.ok).toBe(true);

  // NOW DESTROY THE OPENINGS. This is the disaster being recovered from: the
  // commitments stay on chain and the only thing that opens them is gone.
  const wiped = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("pocket.openings."));
    await chrome.storage.local.remove(keys);
    return keys.length;
  });
  expect(wiped, "there must have been openings to destroy").toBeGreaterThan(0);

  await page.reload();
  await page.getByRole("button", { name: /private pocket/i }).click();

  // The wallet must NOT pretend. It has an account on chain and no record of
  // its balances, and it says so.
  await expect(page.getByText(/Balances need rebuilding|Records do not match/)).toBeVisible({
    timeout: 120_000,
  });

  // And now the thing that was impossible before.
  await page.getByRole("button", { name: "Rebuild from history" }).click();
  await expect(page.getByText(/SPENDABLE/)).toBeVisible({ timeout: 300_000 });

  // Rebuilt, and agreeing with the contract: the controller refuses to store a
  // replay that does not reproduce what the chain holds, so reaching a ready
  // state IS the assertion that the numbers are right.
  await expect(page.getByText(/Records do not match/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Send privately" })).toBeVisible();
  console.log(`  rebuilt ${wiped} opening record(s) for ${address.slice(0, 8)}… from the archive`);
});
