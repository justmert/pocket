// Ambient assertions: the things every test fails on whether or not it was
// looking for them.
//
// Most real defects announce themselves this way long before a targeted
// assertion catches them — a console error, a request to somewhere unexpected, a
// service worker that restarted when nothing asked it to. A suite that only
// checks what each test thought to check is blind to all of it.
//
// Two modes, because switching this on across a suite that never had it is a
// measurement before it is a gate:
//
//   QA_AMBIENT=report   collect and print, fail nothing
//   QA_AMBIENT=fail     collect and fail the test
//
// Unset behaves as `fail`. `report` exists for exactly one purpose: the first
// run, to size what was already there. Anything it finds is a defect row, not a
// reason to leave the mode set.
import type { BrowserContext, Page, Worker } from "@playwright/test";

export type Violation = { kind: string; detail: string };

/** hosts this wallet is allowed to talk to. anything else is a finding. */
export const EXPECTED_HOSTS = [
  "soroban-testnet.stellar.org",
  "friendbot.stellar.org",
  "api.defindex.io",
  // the value chart. two hosts, two jobs: the active network knows what this
  // account held, mainnet knows what an asset was worth. see chain/prices.ts.
  "horizon-testnet.stellar.org",
  "horizon.stellar.org",
  "127.0.0.1",
  "localhost",
];

/**
 * console noise that is the platform talking, not the product.
 *
 * kept deliberately short and specific. every entry is a thing chrome or the
 * test harness emits that no change to this wallet can remove, and each one is
 * anchored so it cannot swallow a real message that merely contains it.
 */
const PLATFORM_NOISE = [
  /^Failed to load resource: net::ERR_FILE_NOT_FOUND$/,
  /Unchecked runtime\.lastError: The message port closed before a response was received/,
  /^Error with Permissions-Policy header/,
];

export class Ambient {
  readonly violations: Violation[] = [];
  private readonly storageKeys = new Set<string>();

  constructor(
    private readonly context: BrowserContext,
    private readonly expectedHosts: string[] = EXPECTED_HOSTS,
  ) {}

  /** start watching a page for everything that is not supposed to happen. */
  watchPage(page: Page): void {
    page.on("pageerror", (e) => this.violations.push({ kind: "uncaught", detail: String(e) }));
    page.on("console", (m) => {
      if (m.type() !== "error") return;
      const text = m.text();
      if (PLATFORM_NOISE.some((r) => r.test(text))) return;
      this.violations.push({ kind: "console-error", detail: text.slice(0, 300) });
    });
    page.on("requestfailed", (r) => {
      const host = safeHost(r.url());
      if (host && !this.allowed(host)) {
        this.violations.push({ kind: "unexpected-host", detail: `${host} (failed) ${r.url().slice(0, 120)}` });
      }
    });
    page.on("request", (r) => {
      const host = safeHost(r.url());
      if (host && !this.allowed(host)) {
        this.violations.push({ kind: "unexpected-host", detail: `${host} ${r.url().slice(0, 120)}` });
      }
    });
  }

  /** the worker is where the chain calls actually happen. */
  watchWorker(worker: Worker): void {
    worker.on("close", () =>
      this.violations.push({ kind: "worker-restart", detail: "the service worker stopped" }),
    );
  }

  private allowed(host: string): boolean {
    return this.expectedHosts.some((h) => host === h || host.endsWith(`.${h}`));
  }

  /** every storage key written during the test, for the write-outside-expected check. */
  async recordStorage(worker: Worker): Promise<void> {
    try {
      const keys = await worker.evaluate(async () => Object.keys(await chrome.storage.local.get(null)));
      for (const k of keys) this.storageKeys.add(k);
    } catch {
      // a torn-down worker has no storage to read, which is not a violation.
    }
  }

  keysWritten(): string[] {
    return [...this.storageKeys].sort();
  }

  /** what the fixture calls at teardown. */
  report(testTitle: string): void {
    if (this.violations.length === 0) return;
    const mode = process.env.QA_AMBIENT ?? "fail";
    const lines = this.violations.map((v) => `  [${v.kind}] ${v.detail}`).join("\n");
    const message = `ambient assertions tripped during "${testTitle}":\n${lines}`;
    if (mode === "report") {
      // eslint-disable-next-line no-console
      console.log(`AMBIENT-REPORT ${JSON.stringify({ test: testTitle, violations: this.violations })}`);
      return;
    }
    throw new Error(message);
  }
}

function safeHost(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === "chrome-extension:" || u.protocol === "data:" || u.protocol === "blob:") return null;
    return u.hostname;
  } catch {
    return null;
  }
}
