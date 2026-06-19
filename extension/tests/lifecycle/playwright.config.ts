import { defineConfig } from "@playwright/test";

/**
 * T4's runner. Lives here rather than in the root config because the root one
 * is shared and every slice of this pass owns its own spec directory.
 *
 * Every test in this directory launches its OWN persistent Chrome profile and
 * its own wallet, so nothing is shared and nothing is ordered. Workers are
 * capped at 3 rather than left unbounded: each one is a full Chrome with a
 * 6MB service worker, and the live specs hit friendbot, which rate-limits.
 */
export default defineConfig({
  testDir: ".",
  // Spec FILES run in parallel; tests inside one file do not. Every test builds
  // its own wallet and its own Chrome profile, so this is a throughput choice
  // rather than an ordering dependency: proving is CPU-bound and multithreaded,
  // and three proofs at once on one machine turn a 15-second register into a
  // four-minute one.
  fullyParallel: false,
  workers: process.env.CI ? 2 : 3,
  timeout: 180_000,
  expect: { timeout: 30_000 },
  reporter: [["list", { printSteps: false }]],
  // Live specs submit real transactions and fund real accounts. Opt-in, for the
  // same reason the rest of the repo makes them opt-in: a testnet outage must
  // not be reported as a code failure.
  testIgnore: process.env.POCKET_LIVE_E2E ? [] : ["**/*.live.spec.ts"],
});
