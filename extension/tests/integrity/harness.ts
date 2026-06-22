// What this slice needs that the shared fixtures do not provide: a profile that
// OUTLIVES the browser, and a worker that can be killed on demand.
//
// `tests/support/**` is T1's and is not edited from here. Everything below
// either wraps it or is new.
import { chromium, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, cpSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { EXTENSION_PATH } from "../support/extension";

const here = dirname(fileURLToPath(import.meta.url));

export const PASSWORD = "a-strong-password";

export interface Install {
  ctx: BrowserContext;
  id: string;
  /** The profile directory. Survives `suspend`, so it can be reopened. */
  dir: string;
  popup(): Promise<Page>;
  /** Close the browser and KEEP the profile, which is what a restart is. */
  suspend(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Launch Chromium with a build at `extPath` and a profile at `dir`.
 *
 * The extension PATH is load-bearing for the migration specs: Chrome derives
 * the extension id from it, and the id is what namespaces chrome.storage.local.
 * Two builds at two paths are two different extensions with two different
 * stores, so "upgrade in place" means swapping the contents of ONE path.
 */
export async function open(dir: string, extPath = EXTENSION_PATH): Promise<Install> {
  if (!existsSync(extPath)) throw new Error(`no build at ${extPath}`);
  const ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extPath}`, `--load-extension=${extPath}`],
    // Cold-start contention, not the wallet. Ten agents run browsers here at
    // once and T1 measured a launch timeout roughly once in forty at the
    // default; a slow-but-succeeding start must not be reported as a failure.
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
    async suspend() {
      await ctx.close();
    },
    async close() {
      await ctx.close().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A fresh profile that this file owns and will clean up. */
export async function launch(extPath = EXTENSION_PATH): Promise<Install> {
  return open(mkdtempSync(join(tmpdir(), "pocket-t10-")), extPath);
}

/**
 * Kill the service worker the way the platform does.
 *
 * T4 established both halves of this the hard way and they are worth repeating
 * rather than rediscovering: `chrome.runtime.reload()` is NOT usable under
 * `--load-extension`, because it unloads the extension permanently and the
 * profile never comes back, which is not an event any user experiences.
 * `ServiceWorker.stopAllWorkers` over CDP is the real MV3 eviction: the same
 * termination Chrome's own task manager performs and the same one the platform
 * performs on idle.
 *
 * Verified rather than assumed, at every call site: `expectEvicted` below
 * asserts the session is actually gone afterwards, so a CDP call that silently
 * did nothing cannot be mistaken for a wallet that survived a restart.
 */
export async function evictWorker(ctx: BrowserContext, page: Page): Promise<void> {
  const client = await ctx.newCDPSession(page);
  try {
    await client.send("ServiceWorker.enable");
    await client.send("ServiceWorker.stopAllWorkers");
  } finally {
    await client.detach().catch(() => undefined);
  }
}

/** One request to the worker, exactly as the popup sends it. */
export async function ask<T>(page: Page, msg: unknown): Promise<T> {
  const r = await page.evaluate(
    (m) =>
      new Promise<{ ok?: boolean; data?: unknown; error?: string; lost?: string }>((res) => {
        chrome.runtime.sendMessage(m, (reply) => {
          const err = chrome.runtime.lastError;
          res(reply ?? { lost: err?.message ?? "no response" });
        });
      }),
    msg,
  );
  if (!r.ok) throw new Error(r.error ?? r.lost ?? "the worker did not answer");
  return r.data as T;
}

/** The same request, but a refusal is an answer rather than a throw. */
export async function tryAsk<T>(
  page: Page,
  msg: unknown,
): Promise<{ ok?: boolean; data?: T; error?: string; lost?: string }> {
  return page.evaluate(
    (m) =>
      new Promise<{ ok?: boolean; data?: T; error?: string; lost?: string }>((res) => {
        chrome.runtime.sendMessage(m, (reply) => {
          const err = chrome.runtime.lastError;
          res(reply ?? { lost: err?.message ?? "no response" });
        });
      }),
    msg,
  );
}

/**
 * Confirm the eviction actually happened.
 *
 * An unlocked wallet holds its session in the worker's heap and nowhere else,
 * so `locked: true` from a cold worker is proof the heap is gone. Without this
 * check a no-op CDP call produces a green "survived a restart" test that
 * restarted nothing.
 */
export async function expectEvicted(page: Page): Promise<void> {
  const status = await ask<{ locked: boolean }>(page, { type: "status" });
  expect(status.locked, "the worker must be cold after an eviction").toBe(true);
}

/**
 * Swap the contents of one extension path for another build's.
 *
 * `version` is not cosmetic and this cost an hour to find. Chrome persists the
 * MV3 service-worker REGISTRATION in the profile, keyed by extension version.
 * Replace the files at the path without bumping it and the popup reloads from
 * disk while the OLD background.js keeps running: the screens are the new
 * build's and every message is answered by the previous version. The upgrade
 * looks applied and is not, and a migration test then measures nothing.
 *
 * Bumping it is also what a real upgrade does. A Web Store update that did not
 * raise the version would not install at all.
 */
export function installBuild(from: string, at: string, version?: string): void {
  rmSync(at, { recursive: true, force: true });
  cpSync(from, at, { recursive: true });
  if (!version) return;
  const manifestPath = join(at, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  manifest.version = version;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

/** What an install of the previous build claims to be, and what replaces it. */
export const OLD_VERSION = "0.1.0";
export const NEW_VERSION = "0.2.0";

/**
 * Drop the profile's service-worker script cache.
 *
 * The second half of the same trap, and the reason the version bump above is
 * not enough on its own. Chrome caches the registered MV3 worker script in
 * `<profile>/Default/Service Worker/ScriptCache` and does NOT invalidate it
 * when an unpacked extension's files change underneath it. Measured directly:
 * after swapping builds at one path, the popup renders the NEW screens while
 * every message is answered by the OLD background.js, so a migration test
 * watches the previous version handle its own data and calls that an upgrade.
 *
 * A real Web Store update does not have this problem, because Chrome
 * unregisters and re-registers the worker as part of installing it. Removing
 * the cache is how `--load-extension` is made to do the same thing. Nothing the
 * wallet owns lives here: `Local Extension Settings` holds chrome.storage.local
 * and is untouched, which the migration specs then assert by finding their data
 * still there.
 */
export function clearServiceWorkerCache(profileDir: string): void {
  rmSync(join(profileDir, "Default", "Service Worker"), { recursive: true, force: true });
}

/** A path this worker owns for a build it swaps in place. */
export function swappablePath(workerIndex: number): string {
  return resolve(here, `../../.output-t10-swap-${workerIndex}/chrome-mv3`);
}

/** The old build, for the migration specs. Built by scripts/t10-old-build.sh. */
export const OLD_BUILD = resolve(here, "../../.output-t10-old/chrome-mv3");
export const CURRENT_BUILD = EXTENSION_PATH;
