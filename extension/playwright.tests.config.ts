// The Full Test Pass suite. Separate from playwright.config.ts, which runs the
// older e2e specs this pass does not trust and does not extend.
//
// Owned by T1 along with tests/support/**. Other agents add spec files under
// their own tests/<slice>/ directory; nobody needs to edit this.
import { defineConfig } from "@playwright/test";

// Every chain call happens in the service worker, so without this the network
// stubs in tests/support/stub.ts silently do nothing and a failure-injection
// test passes while injecting no failure. Set before the browser launches.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

export default defineConfig({
  testDir: "./tests",
  // Two runners share tests/: Playwright drives the real browser, vitest covers
  // what has no browser to drive. Playwright's default testMatch also claims
  // *.test.ts, so it was loading vitest files and reporting vitest's own
  // "failed to find the current suite" as a suite failure. The split is by
  // extension and it is the convention for the whole pass:
  //   *.spec.ts  Playwright, real extension in real Chromium
  //   *.test.ts  vitest
  testMatch: "**/*.spec.ts",
  // Each test launches its own Chromium with its own profile and funds its own
  // account, so there is nothing to serialise. Ordering dependencies are a
  // defect in a spec, not something this config should paper over.
  fullyParallel: true,
  // Three, not one per core. Every test starts its own Chromium with an 18 MB
  // unpacked extension, and several start a second one for the other side of a
  // transfer, so the real concurrency is up to double this. Raising it turned
  // browser cold-start into the slowest thing in the suite and produced launch
  // timeouts that had nothing to do with the wallet.
  workers: process.env.PW_WORKERS ? Number(process.env.PW_WORKERS) : 3,
  // No retries, on purpose. A test that only passes on the second attempt is a
  // finding to report, not a number to raise.
  retries: 0,
  // Live testnet: proving takes hundreds of milliseconds and confirmation takes
  // seconds, and the private chain does several of both. Specs that need less
  // set their own shorter timeout.
  timeout: 15 * 60_000,
  expect: { timeout: 30_000 },
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "test-results/pass.json" }]]
    : "list",
  use: {
    trace: "retain-on-failure",
    video: "off",
  },
});
