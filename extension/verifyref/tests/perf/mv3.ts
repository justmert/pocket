// Forcing the platform event this slice cares about most: a cold service worker.
//
// MV3 evicts the worker aggressively, the worker owns the session, and so a
// COLD start is the normal case rather than the exotic one. Every "how fast
// does the wallet open" number is worthless if it was taken against a worker
// that happened to still be alive.
import type { BrowserContext, Page } from "@playwright/test";

/**
 * Kill the service worker the way Chrome does.
 *
 * `ServiceWorker.stopAllWorkers` over CDP is the same termination Chrome's task
 * manager performs and the same one the platform performs on idle. T4
 * established that `chrome.runtime.reload()` is NOT a substitute: under
 * `--load-extension` it unloads the extension permanently, which is a different
 * event and not one a user experiences.
 *
 * Note what this implies for every measurement below it: the session lives in
 * worker memory and is never persisted (`core/session.ts`), so worker death is
 * a LOCK. A returning user's cold start lands on the password screen, not on
 * the home screen, and measuring "time to home" after an eviction would be
 * measuring the wrong thing.
 */
export async function killWorker(ctx: BrowserContext, page: Page): Promise<void> {
  const client = await ctx.newCDPSession(page);
  try {
    await client.send("ServiceWorker.enable");
    await client.send("ServiceWorker.stopAllWorkers");
  } finally {
    await client.detach().catch(() => undefined);
  }
}
