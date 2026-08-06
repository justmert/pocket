import { test, expect, chromium, type BrowserContext } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The dApp surface, driven from a REAL page rather than from the worker.
//
// The whole point is that a page gets exactly what the user consented to and
// nothing else. So the assertions are made from inside the page, through the
// injected object, with no shortcuts through chrome.runtime.
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");
const PASSWORD = "a strong test password";

let ctx: BrowserContext;
let id: string;
let dir: string;

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-dapp-"));
  ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  id = new URL(sw.url()).host;
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A real page on a real origin, with the content script live. */
async function site(origin: string) {
  const page = await ctx.newPage();
  await page.route(`${origin}/**`, (r) =>
    r.fulfill({ status: 200, contentType: "text/html", body: "<html><body>dapp</body></html>" }),
  );
  await page.goto(`${origin}/`);
  return page;
}

test("the provider is injected into an ordinary page", async () => {
  const page = await site("https://app.example");
  await expect
    .poll(() => page.evaluate(() => typeof (window as never as { pocket?: unknown }).pocket))
    .toBe("object");

  // Frozen, so a later script on the page cannot swap a method out and
  // impersonate the wallet to another script.
  expect(
    await page.evaluate(() => Object.isFrozen((window as never as { pocket: object }).pocket)),
  ).toBe(true);
  await page.close();
});

test("getNetwork answers without a wallet, because it is about the wallet not the user", async () => {
  const page = await site("https://app.example");
  const net = await page.evaluate(() =>
    (window as never as { pocket: { getNetwork(): Promise<unknown> } }).pocket.getNetwork(),
  );
  expect(net).toMatchObject({ networkPassphrase: expect.stringContaining("Test SDF Network") });
  await page.close();
});

test("an unconnected site is told nothing about the account", async () => {
  // Create a wallet first, so the refusal is about consent and not about
  // there being nothing to reveal.
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole("button", { name: "Create a new wallet" }).click();
  await popup.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
  await popup.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
  await popup.getByRole("button", { name: "Create wallet" }).click();
  await popup.getByRole("button", { name: "I have written it down" }).click();
  await expect(popup.getByRole("button", { name: "Public", exact: true })).toBeVisible({
    timeout: 30_000,
  });

  const page = await site("https://evil.example");
  const res = (await page.evaluate(() =>
    (window as never as { pocket: { getAddress(): Promise<unknown> } }).pocket.getAddress(),
  )) as { address?: string; error?: { message: string } };

  expect(res.address, "an unconnected origin must learn nothing").toBeUndefined();
  expect(res.error).toBeDefined();
  await page.close();
  await popup.close();
});

test("a connected site learns the address, and only that", async () => {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  // Grant the connection the way the popup does.
  await popup.evaluate(
    () =>
      new Promise((res) =>
        chrome.runtime.sendMessage({ type: "connectDapp", origin: "https://app.example" }, (r) =>
          res(r),
        ),
      ),
  );

  const page = await site("https://app.example");
  const res = (await page.evaluate(() =>
    (window as never as { pocket: { getAddress(): Promise<unknown> } }).pocket.getAddress(),
  )) as { address?: string };
  expect(res.address).toMatch(/^G[A-Z2-7]{55}$/);

  // A connection is not a signing grant. Signing must still be refused
  // outright rather than silently performed.
  const signed = (await page.evaluate(() =>
    (
      window as never as {
        pocket: { signMessage(m: string): Promise<unknown> };
      }
    ).pocket.signMessage("hello"),
  )) as { error?: { message: string }; signedMessage?: string };
  expect(signed.signedMessage).toBeUndefined();
  expect(signed.error).toBeDefined();

  await page.close();
  await popup.close();
});

test("a locked wallet reveals nothing, even to a connected site", async () => {
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.getByRole("button", { name: "Lock" }).click();
  await expect(popup.getByText(/Enter your password to continue/)).toBeVisible();

  const page = await site("https://app.example");
  const res = (await page.evaluate(() =>
    (window as never as { pocket: { getAddress(): Promise<unknown> } }).pocket.getAddress(),
  )) as { address?: string; error?: { message: string } };

  expect(res.address).toBeUndefined();
  expect(res.error).toBeDefined();
  await page.close();
  await popup.close();
});
