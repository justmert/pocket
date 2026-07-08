// The fixtures every spec in this suite builds on.
//
// One browser, one profile, one wallet per test, torn down whether the test
// passed or threw. Nothing is shared between tests and nothing survives one, so
// the suite has no ordering dependencies and can run fully parallel: a test
// that needs a funded account funds its own.
import { test as base } from "@playwright/test";
import { launchWallet, type Harness } from "./extension";
import { Wallet } from "./wallet";
import { Ambient } from "./ambient";

export interface PocketFixtures {
  /** The browser context, the extension id and the service worker. */
  harness: Harness;
  /** The popup, driven the way a person drives it. */
  wallet: Wallet;
  /**
   * Everything that must not happen, watched whether or not a test looks.
   *
   * Attached to every test in every tier by construction rather than by
   * remembering to opt in: a console error or a request to an unexpected host
   * is a defect in whichever test happens to be running when it appears.
   */
  ambient: Ambient;
}

export const test = base.extend<PocketFixtures>({
  harness: async ({}, use) => {
    const harness = await launchWallet();
    try {
      await use(harness);
    } finally {
      // Runs even when the test threw, so a failing test cannot leave a
      // Chromium process or a profile directory behind for the next one.
      await harness.close();
    }
  },

  ambient: [
    async ({ harness }, use, testInfo) => {
      const ambient = new Ambient(harness.context);
      ambient.watchPage(harness.popup);
      harness.context.on("page", (p) => ambient.watchPage(p));
      try {
        await use(ambient);
      } finally {
        // Only judge a test that was otherwise passing. A test that already
        // failed has its own, better, explanation and does not need a second
        // one stacked on top of it.
        if (testInfo.status === testInfo.expectedStatus) ambient.report(testInfo.title);
      }
    },
    { auto: true },
  ],

  wallet: async ({ harness }, use) => {
    await use(new Wallet(harness.popup));
  },
});

export { expect } from "@playwright/test";
export { Wallet } from "./wallet";
export type { Harness } from "./extension";
export { askWorker } from "./extension";
