// The Full Test Pass suite. Separate from playwright.config.ts, which runs the
// older e2e specs this pass does not trust and does not extend.
//
// Owned by T1 along with tests/support/**. Other agents add spec files under
// their own tests/<slice>/ directory; nobody needs to edit this.
import { defineConfig } from "@playwright/test";

// Every chain call happens in the service worker, so without this the network
// stubs in tests/support/stub.ts silently do nothing and a failure-injection
// test passes while injecting no failure. Set before the browser launches.
//
// An explicit value in the environment wins, which is not a convenience: it is
// how tests/support/service-worker-routing.spec.ts is shown FAILING. Run the
// suite with PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=0 and that spec goes
// red on both counts, which is the proof that its green run means something.
// Anyone who sets it to 0 by accident gets the same red, by design.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

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
  // `*.live.spec.ts` is opt-in, the same convention the older e2e config uses.
  // Those specs submit real transactions from a funded account, so a testnet
  // outage or an offline machine would be reported as a code failure, and
  // nobody expects `npm run test:pass` to spend money without being asked.
  // Without this the root config picked up T4's live specs and ran them.
  testIgnore: process.env.POCKET_LIVE_E2E ? [] : ["**/*.live.spec.ts"],
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
  expect: {
    timeout: 30_000,
    // Exact pixels.
    //
    // Playwright's default `threshold: 0.2` compares in YIQ and tolerates a
    // fifth of the colour space per pixel, which sounds small and is not:
    // measured here, a button whose corner radius changed from 12px to 4px
    // went UNDETECTED on four of eight screens, because those buttons were the
    // disabled style (#F4F3F0 on a #FBFAF8 page) and the corner pixels differed
    // by less than the tolerance. A snapshot that cannot see a low-contrast
    // change is blind exactly where a design regression is hardest to notice by
    // eye. At 0 the same mutation reddens every screen it touches.
    //
    // This is only affordable because the popup is a fixed 384x600 with no
    // remote assets and no video, so rendering is deterministic run to run.
    toHaveScreenshot: { threshold: 0, maxDiffPixels: 0 },
  },
  reporter: process.env.CI
    ? [["list"], ["json", { outputFile: "test-results/pass.json" }]]
    : "list",
  use: {
    trace: "retain-on-failure",
    video: "off",
    // Playwright's default is 0, meaning "wait until the whole test times
    // out". With a 15-minute test budget a `fill()` on a field that never
    // appeared blocked for fifteen minutes and then reported a test timeout
    // rather than the missing field, which cost one mutation run a quarter of
    // an hour and said nothing about why. Long enough for a real proof and a
    // real confirmation to land; short enough that a missing element is a
    // fast, specific failure.
    actionTimeout: 60_000,
  },
});
