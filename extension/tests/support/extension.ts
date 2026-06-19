// Launches the REAL built extension in a real Chromium and hands back the
// pieces a test needs to drive it.
//
// Nothing here mocks wallet code. The service worker runs, the vault encrypts
// with scrypt, proving happens in the offscreen document, and every chain call
// goes to live testnet. The only thing this file owns is the browser.
//
// Every launch gets its own profile directory, so two tests running at the same
// time cannot see each other's vault, storage or alarms. That is what makes the
// suite parallel-safe; nothing else in it shares state.
import { chromium, type BrowserContext, type Page, type Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The build under test. `npm run build` in extension/ produces it.
 *
 * POCKET_EXT_PATH points the suite at a DIFFERENT build. That is what makes
 * mutation testing safe in a shared checkout: build the broken version once,
 * copy it aside, restore the source and the real output, then run the specs
 * against the copy. Nobody else's run sees a deliberately broken extension.
 */
export const EXTENSION_PATH =
  process.env.POCKET_EXT_PATH ?? resolve(here, "../../.output/chrome-mv3");

export interface Harness {
  context: BrowserContext;
  /** The 32-character extension id Chrome assigned this load. */
  extensionId: string;
  /** A popup page, already navigated. The first one is opened for you. */
  popup: Page;
  /** Another popup page, as if the user opened the toolbar icon again. */
  openPopup(): Promise<Page>;
  /** The service worker. Waits for it if the load has not finished. */
  worker(): Promise<Worker>;
  /** The offscreen document, once proving has started one. Null before that. */
  offscreen(): Page | null;
  /** Profile directory, for a test that wants to inspect or corrupt storage. */
  profileDir: string;
  close(): Promise<void>;
}

/**
 * Start Chromium with the extension loaded and open its popup.
 *
 * The service worker URL is the only reliable source of the extension id: the
 * id is derived from the unpacked path's key and is not written anywhere the
 * test can read ahead of time.
 */
export async function launchWallet(): Promise<Harness> {
  if (!existsSync(EXTENSION_PATH)) {
    throw new Error(
      `no build at ${EXTENSION_PATH}. Run "npm run build" in extension/ before the suite.`,
    );
  }
  const profileDir = mkdtempSync(join(tmpdir(), "pocket-t1-"));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    // Cold-starting Chromium with an 18 MB unpacked extension is CPU-bound, and
    // several specs launch a SECOND browser for the other side of a transfer,
    // so a four-worker run can be starting eight at once. Measured once at 1
    // failure in 40 on a loaded machine, as a launch timeout rather than
    // anything the wallet did. Waiting longer for a real event is the honest
    // fix; the worker count in playwright.tests.config.ts is the other half.
    timeout: 300_000,
  });

  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker");
  const extensionId = new URL(sw.url()).host;

  const openPopup = async (): Promise<Page> => {
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html`);
    return page;
  };

  const harness: Harness = {
    context,
    extensionId,
    popup: await openPopup(),
    openPopup,
    async worker() {
      const [existing] = context.serviceWorkers();
      return existing ?? (await context.waitForEvent("serviceworker"));
    },
    offscreen() {
      return context.pages().find((p) => p.url().includes("offscreen.html")) ?? null;
    },
    profileDir,
    async close() {
      await context.close();
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/**
 * Ask the service worker something directly, over the same runtime channel the
 * popup uses.
 *
 * For ASSERTIONS ONLY, and only for facts the UI does not render: the auditor
 * id it bound, for instance. Driving a flow through this instead of the screen
 * would test the message contract rather than the wallet, which is the opposite
 * of what these specs are for.
 */
export async function askWorker<T>(page: Page, message: unknown): Promise<T> {
  return page.evaluate(
    (msg) =>
      new Promise((res, rej) => {
        chrome.runtime.sendMessage(msg, (r: { ok: boolean; data?: unknown; error?: string }) => {
          if (!r) return rej(new Error("the worker did not answer"));
          r.ok ? res(r.data) : rej(new Error(r.error));
        });
      }),
    message,
  ) as Promise<T>;
}
