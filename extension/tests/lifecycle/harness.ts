// T4's harness. Self-contained on purpose: `tests/support/**` belongs to T1 and
// did not exist when this slice started, so nothing here reaches into it.
//
// The one thing this file exists for is killing the service worker on demand.
// MV3 evicts the worker whenever it likes, the worker owns the vault, the
// session and every chain call, and so "the worker died halfway" is the normal
// case rather than the exotic one. Everything else here is plumbing for
// observing what survived that.
import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { answerBackupCheck } from "../support/wallet";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Which build to load.
 *
 * Overridable so a deliberately broken build can be pointed at without editing
 * the shared source tree, which other agents in this pass are building from at
 * the same time.
 */
export const EXT = process.env.POCKET_EXT ?? resolve(here, "../../.output/chrome-mv3");

export const FRIENDBOT = "https://friendbot.stellar.org";
export const HORIZON = "https://horizon-testnet.stellar.org";
export const RPC = "https://soroban-testnet.stellar.org";
export const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
export const PASSWORD = "a-strong-password";

export interface Wallet {
  ctx: BrowserContext;
  id: string;
  dir: string;
  /** A fresh extension page. Chrome allows one real popup, but an extension
   *  page opens in a tab, which is how "two popups at once" is reachable. */
  popup(): Promise<Page>;
  close(): Promise<void>;
  /** Close the browser but KEEP the profile, so it can be relaunched. */
  suspend(): Promise<void>;
}

async function open(dir: string): Promise<Wallet> {
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
    // Cold-start contention only, nothing to do with the wallet: every test here
    // launches its own browser, and T1 measured roughly one launch timeout in
    // forty on a loaded machine at the default. A launch that is merely slow
    // must not be reported as a wallet failure.
    timeout: 300_000,
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  return {
    ctx,
    id,
    dir,
    async popup() {
      const page = await ctx.newPage();
      await page.goto(`chrome-extension://${id}/popup.html`);
      return page;
    },
    async close() {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    },
    async suspend() {
      await ctx.close();
    },
  };
}

/** A fresh browser profile with the real built extension loaded. */
export async function launch(): Promise<Wallet> {
  return open(mkdtempSync(join(tmpdir(), "pocket-t4-")));
}

/** Reopen a profile a previous launch left behind. A browser restart. */
export async function relaunch(dir: string): Promise<Wallet> {
  return open(dir);
}

/**
 * Kill the service worker, the way MV3 does.
 *
 * `ServiceWorker.stopAllWorkers` is the same termination Chrome's own task
 * manager performs and the same one the platform performs on idle: the worker's
 * heap is gone, so the session and every in-memory pending envelope go with it,
 * and the next message starts a cold one. `chrome.runtime.reload()` is NOT used
 * here: under `--load-extension` it unloads the extension permanently, which is
 * a different event and not one a user experiences.
 */
export async function killWorker(w: Wallet, page: Page): Promise<void> {
  const client = await w.ctx.newCDPSession(page);
  try {
    await client.send("ServiceWorker.enable");
    await client.send("ServiceWorker.stopAllWorkers");
  } finally {
    await client.detach().catch(() => undefined);
  }
}

/**
 * Everything chrome.storage.local holds, as JSON.
 *
 * Read from an extension PAGE, never through the worker: the point is to check
 * what is actually on disk rather than what the worker says is there, and a
 * read that woke the worker would change the thing being measured.
 */
export async function storage(page: Page): Promise<Record<string, unknown>> {
  const raw = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  return JSON.parse(raw) as Record<string, unknown>;
}

export async function storageKeys(page: Page): Promise<string[]> {
  return Object.keys(await storage(page)).sort();
}

export interface Reply<T = unknown> {
  ok?: boolean;
  data?: T;
  error?: string;
  /** Set when the worker died before answering. */
  lost?: string;
}

/** One request to the worker, exactly as the popup sends it. */
export async function send<T = unknown>(page: Page, msg: unknown): Promise<Reply<T>> {
  return page.evaluate(
    (m) =>
      new Promise<Reply<T>>((res) => {
        chrome.runtime.sendMessage(m, (r) => {
          const err = chrome.runtime.lastError;
          res(r ?? { lost: err?.message ?? "no response" });
        });
      }),
    msg,
  ) as Promise<Reply<T>>;
}

/**
 * Fire a request WITHOUT waiting for it, parking the promise on the page.
 *
 * Needed for every interruption test: the worker has to be killed while the
 * request is still running, which is impossible if the test is blocked awaiting
 * it. `collect` picks the answer up afterwards, including the "worker died"
 * case.
 */
export async function fire(page: Page, slot: string, msg: unknown): Promise<void> {
  await page.evaluate(
    ([s, m]) => {
      const w = window as unknown as Record<string, unknown>;
      w[s as string] = new Promise((res) => {
        chrome.runtime.sendMessage(m, (r) => {
          const err = chrome.runtime.lastError;
          res(r ?? { lost: err?.message ?? "no response" });
        });
      });
    },
    [slot, msg] as [string, unknown],
  );
}

export async function collect<T = unknown>(page: Page, slot: string): Promise<Reply<T>> {
  return page.evaluate(
    (s) => (window as unknown as Record<string, Promise<unknown>>)[s],
    slot,
  ) as Promise<Reply<T>>;
}

/**
 * Wait for something to become true of what is on disk.
 *
 * Polls storage, which is the real condition, rather than sleeping. Storage
 * reads do not wake the worker, so this observes without disturbing.
 */
export async function waitForStorage(
  page: Page,
  predicate: (s: Record<string, unknown>) => boolean,
  message: string,
  timeoutMs = 60_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, unknown> = {};
  while (Date.now() < deadline) {
    last = await storage(page);
    if (predicate(last)) return last;
    await page.waitForTimeout(50);
  }
  throw new Error(`${message} (last keys: ${Object.keys(last).join(", ") || "none"})`);
}

/** The alarms the extension has scheduled, read from an extension page. */
export async function alarms(page: Page): Promise<{ name: string; scheduledTime: number }[]> {
  const raw = await page.evaluate(async () => JSON.stringify(await chrome.alarms.getAll()));
  return JSON.parse(raw) as { name: string; scheduledTime: number }[];
}

/** How many offscreen documents exist. Exactly one is allowed, ever. */
export async function offscreenCount(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const c = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    return c.length;
  });
}

/** Create a wallet through the UI and land on Home. Returns the 24 words. */
export async function onboard(page: Page, password = PASSWORD): Promise<string> {
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("textbox", { name: "Confirm password" }).fill(password);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Write this down")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Show the phrase" }).click();
  const cells = await page
    .locator("span")
    .filter({ hasText: /^\d+\.\s\w+\s*$/ })
    .allInnerTexts();
  const phrase = cells.map((c) => c.replace(/^\d+\.\s*/, "").trim()).join(" ");
  await page.getByRole("button", { name: "I have written it down" }).click();
  await answerBackupCheck(page, phrase);
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 60_000 });
  return phrase;
}

export async function unlockUi(page: Page, password = PASSWORD): Promise<void> {
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(password);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
}

/** The address the wallet itself reports. */
export async function addressOf(page: Page): Promise<string> {
  const r = await send<{ address?: string }>(page, { type: "status" });
  if (!r.ok || !r.data?.address) throw new Error(`no address: ${JSON.stringify(r)}`);
  return r.data.address;
}

/** Friendbot funds a fresh account with exactly 10,000 XLM. */
export async function fund(address: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT}?addr=${address}`);
  if (!res.ok) throw new Error(`friendbot refused ${address}: ${res.status}`);
  await res.text();
}

/** A brand new funded account, key and all, for use as a payment recipient. */
export async function fundedStranger(): Promise<string> {
  const { Keypair } = await import("@stellar/stellar-sdk/base");
  const kp = Keypair.random();
  await fund(kp.publicKey());
  return kp.publicKey();
}

/** The ledger's own account view. Horizon shares no code with the wallet. */
export async function ledgerAccount(address: string): Promise<{
  native: number;
  exists: boolean;
}> {
  const res = await fetch(`${HORIZON}/accounts/${address}`);
  if (res.status === 404) return { native: 0, exists: false };
  if (!res.ok) throw new Error(`horizon ${res.status} for ${address}`);
  const body = (await res.json()) as {
    balances: { asset_type: string; balance: string }[];
  };
  const native = body.balances.find((b) => b.asset_type === "native");
  return { native: Number(native?.balance ?? 0), exists: true };
}

/**
 * Every transaction the ledger recorded for this account, INCLUDING failed ones.
 *
 * `include_failed=true` is not optional. Horizon omits failed transactions by
 * default, so a duplicate submission that was included and trapped is invisible,
 * and any assertion that counts transactions to prove "it only did this once"
 * is satisfied by construction rather than by the wallet behaving. It still cost
 * the user a fee and a sequence number.
 *
 * `feeAccount` is here for the same reason: friendbot's create-account
 * transaction is listed against the account it funded, but friendbot paid for
 * it, so anything counting what THIS wallet submitted has to filter on it.
 */
export async function ledgerTransactions(
  address: string,
): Promise<{ hash: string; successful: boolean; feeAccount: string; feeCharged: string }[]> {
  const res = await fetch(
    `${HORIZON}/accounts/${address}/transactions?limit=100&order=desc&include_failed=true`,
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const body = (await res.json()) as {
    _embedded: {
      records: {
        hash: string;
        successful: boolean;
        fee_account: string;
        fee_charged: string;
      }[];
    };
  };
  return body._embedded.records.map((r) => ({
    hash: r.hash,
    successful: r.successful,
    feeAccount: r.fee_account,
    feeCharged: r.fee_charged,
  }));
}

/** Transactions THIS wallet submitted and paid for, failed ones included. */
export async function ownTransactions(
  address: string,
): Promise<{ hash: string; successful: boolean; feeCharged: string }[]> {
  return (await ledgerTransactions(address)).filter((t) => t.feeAccount === address);
}

/**
 * Payments the ledger recorded and APPLIED, which is what "did it send twice"
 * means.
 *
 * `include_failed=true` is passed and the failures are then dropped here
 * deliberately, rather than leaving Horizon's default to do it silently. A
 * default that happens to give the right answer is not an assertion, and a
 * duplicate submission that was included and failed still cost a fee and a
 * sequence number even though it moved nothing.
 */
export async function ledgerPayments(
  address: string,
): Promise<{ from: string; to: string; amount: string; transaction_hash: string }[]> {
  const res = await fetch(
    `${HORIZON}/accounts/${address}/payments?limit=100&order=desc&include_failed=true`,
  );
  if (res.status === 404) return [];
  if (!res.ok) throw new Error(`horizon ${res.status}`);
  const body = (await res.json()) as {
    _embedded: {
      records: {
        type: string;
        from?: string;
        to?: string;
        amount?: string;
        transaction_hash: string;
        transaction_successful?: boolean;
      }[];
    };
  };
  return body._embedded.records
    .filter((r) => r.type === "payment" && r.transaction_successful !== false)
    .map((r) => ({
      from: r.from ?? "",
      to: r.to ?? "",
      amount: r.amount ?? "",
      transaction_hash: r.transaction_hash,
    }));
}

/** Wait until Horizon has caught up enough to see this account at all. */
export async function waitForFunded(address: string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const a = await ledgerAccount(address).catch(() => ({ exists: false, native: 0 }));
    if (a.exists) return;
    if (Date.now() > deadline) throw new Error(`horizon never saw ${address}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}
