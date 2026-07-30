// What the user actually sees when the ledger cannot be reached.
//
// A real Chrome, the real built extension, a real MV3 service worker, and a
// Soroban RPC that is genuinely unreachable at the socket. Nothing in the
// extension is stubbed: the wallet resolves `soroban-testnet.stellar.org` to a
// server this test owns, using Chrome's own host resolver, so the failure is
// induced exactly where a real outage would induce it.
//
// The property: the home screen never renders a balance it did not read. A
// spinner that never ends, a stale figure, or a confident 0.0000000 are all the
// same defect, and the last one is the one a user acts on.
import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { StrKey, xdr } from "@stellar/stellar-sdk/base";
import { FaultServer, rpcOk, type Fault, type RecordedRequest } from "./_harness/faults";
import { accountKey, accountEntry, entryFor, entriesResult } from "./_harness/ledger";
import { answerBackupCheck } from "../support/wallet";

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, "../../.output/chrome-mv3");
const PASSWORD = "a-strong-password";
const RPC_HOST = "soroban-testnet.stellar.org";

/**
 * Answer about whichever account was asked about, with a balance this test
 * chose.
 *
 * Reading the address out of the request rather than out of the UI keeps the
 * assertion about the number on screen rather than about how the test learned
 * the address.
 */
function fundedWhoeverWasAsked(stroops: bigint): (req: RecordedRequest) => Fault {
  return (req) => {
    try {
      const keys = (JSON.parse(req.body) as { params?: { keys?: string[] } }).params?.keys ?? [];
      const first = keys[0];
      if (!first) return rpcOk(entriesResult([]));
      const key = xdr.LedgerKey.fromXDR(first, "base64");
      if (key.switch().name !== "account") return rpcOk(entriesResult([]));
      const address = StrKey.encodeEd25519PublicKey(key.account().accountId().ed25519());
      return rpcOk(entriesResult([entryFor(accountKey(address), accountEntry(address, stroops))]));
    } catch {
      return rpcOk(entriesResult([]));
    }
  };
}

async function launch(rpcPort: number): Promise<{ ctx: BrowserContext; id: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "pocket-failure-"));
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      // Chrome's own resolver sends the wallet's RPC traffic to this test's
      // server. The extension is untouched: it still asks for the real host over
      // https, and its manifest permission still applies.
      `--host-resolver-rules=MAP ${RPC_HOST} 127.0.0.1:${rpcPort}`,
      // The harness serves a throwaway certificate, which is the price of
      // holding the connection open long enough to fail it deliberately.
      "--ignore-certificate-errors",
    ],
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

/** Create a wallet and land on the home screen. Touches no network. */
async function onboard(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
  await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Show the phrase" }).click();
    const shownWords = await page
    .locator("span")
    .filter({ hasText: /^\d+\.\s\w+\s*$/ })
    .allInnerTexts();
  const shownPhraseText = shownWords.map((c) => c.replace(/^\d+\.\s*/, "").trim()).join(" ");
  await page.getByRole("button", { name: "I have written it down" }).click();
  await answerBackupCheck(page, shownPhraseText);
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });
}

/** Every digit-shaped thing on screen, so a fabricated balance cannot hide. */
async function screenText(page: Page): Promise<string> {
  return (await page.locator("body").innerText()).replace(/\s+/g, " ");
}

test("an unreachable RPC shows an error, never a zero balance", async () => {
  const server = await FaultServer.start({ fallback: { kind: "reset" } });
  const port = Number(new URL(server.url).port);
  const { ctx, id, dir } = await launch(port);
  try {
    const page = await popup(ctx, id);
    await onboard(page);

    // The spinner must be replaced by something. A wait that never ends is the
    // same failure as a wrong number, just slower to notice.
    await expect(page.getByText("Reading the ledger")).toHaveCount(0, { timeout: 60_000 });

    const text = await screenText(page);
    expect(text).not.toContain("0.0000000");
    expect(text).not.toMatch(/\bXLM\b\s*$/);
    // Something honest is on screen instead.
    expect(text).toMatch(/Something went wrong|did not report a balance/i);
    // And nothing the dependency authored.
    expect(text).not.toContain("127.0.0.1");
    expect(text).not.toContain(RPC_HOST);
  } finally {
    await ctx.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an RPC answering with no entries field shows an error, never a zero balance", async () => {
  // The calibration case, driven through the whole extension. A well-formed
  // JSON-RPC envelope carrying no `entries` field is byte-identical, after the
  // SDK's parser, to "this account does not exist".
  const server = await FaultServer.start({ fallback: rpcOk({ latestLedger: 9 }) });
  const port = Number(new URL(server.url).port);
  const { ctx, id, dir } = await launch(port);
  try {
    const page = await popup(ctx, id);
    await onboard(page);
    await expect(page.getByText("Reading the ledger")).toHaveCount(0, { timeout: 60_000 });

    const text = await screenText(page);
    expect(text).not.toContain("0.0000000");
    expect(text).toMatch(/Something went wrong|did not report a balance/i);
  } finally {
    await ctx.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a rate-limited RPC shows an error, never a zero balance", async () => {
  const server = await FaultServer.start({ fallback: { kind: "rateLimited", retryAfter: "60" } });
  const port = Number(new URL(server.url).port);
  const { ctx, id, dir } = await launch(port);
  try {
    const page = await popup(ctx, id);
    await onboard(page);
    await expect(page.getByText("Reading the ledger")).toHaveCount(0, { timeout: 60_000 });

    const text = await screenText(page);
    expect(text).not.toContain("0.0000000");
    expect(text).toMatch(/Something went wrong|did not report a balance/i);
    expect(text).not.toContain("Too Many Requests");
  } finally {
    await ctx.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the balance appears once the RPC comes back, in the same session", async () => {
  // The recovery half. A wallet that degrades honestly and then stays broken is
  // still a broken wallet.
  const server = await FaultServer.start({ fallback: { kind: "reset" } });
  const port = Number(new URL(server.url).port);
  const { ctx, id, dir } = await launch(port);
  try {
    const page = await popup(ctx, id);
    await onboard(page);
    await expect(page.getByText("Reading the ledger")).toHaveCount(0, { timeout: 60_000 });
    expect(await screenText(page)).toMatch(/Something went wrong|did not report a balance/i);

    // The dependency returns. 100 XLM held, 1 XLM locked as the base reserve.
    server.heal({ fallback: fundedWhoeverWasAsked(100_0000000n) });

    // Reopening the popup is what a user does. Nothing is retried behind their
    // back, so the assertion is that the next look shows the truth.
    await page.close();
    const again = await popup(ctx, id);
    await expect(again.getByText("99.0000000 XLM").first()).toBeVisible({ timeout: 60_000 });
    const text = await screenText(again);
    expect(text).toContain("Plus 1.0000000 XLM locked by the network as a reserve");
    expect(text).not.toMatch(/Something went wrong/i);
  } finally {
    await ctx.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an account that genuinely does not exist yet shows zero, and says so", async () => {
  // The one shape allowed to render a zero. It has to still work, or the
  // refusal above is just a wallet that never shows a balance.
  const server = await FaultServer.start({ fallback: rpcOk(entriesResult([])) });
  const port = Number(new URL(server.url).port);
  const { ctx, id, dir } = await launch(port);
  try {
    const page = await popup(ctx, id);
    await onboard(page);
    await expect(page.getByText("0.0000000 XLM").first()).toBeVisible({ timeout: 60_000 });
    expect(await screenText(page)).not.toMatch(/Something went wrong/i);
  } finally {
    await ctx.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stalled RPC ends the wait rather than spinning forever", async () => {
  // A server that accepts the connection and never answers. Without the request
  // deadline the popup showed "Reading the ledger" with nothing scheduled to
  // end it. The assertion is a BOUND, set by the wallet's own 30s deadline.
  const server = await FaultServer.start({ fallback: { kind: "stall" } });
  const port = Number(new URL(server.url).port);
  const { ctx, id, dir } = await launch(port);
  try {
    const page = await popup(ctx, id);
    await onboard(page);
    await expect(page.getByText("Reading the ledger")).toBeVisible({ timeout: 15_000 });
    // The wallet's ceiling is 30s. Anything under 45 proves something ends it.
    await expect(page.getByText("Reading the ledger")).toHaveCount(0, { timeout: 45_000 });
    const text = await screenText(page);
    expect(text).not.toContain("0.0000000");
    expect(text).toMatch(/Something went wrong|did not report a balance/i);
  } finally {
    await ctx.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
