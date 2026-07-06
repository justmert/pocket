import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Live specs hit real testnet and submit real transactions, so they are
  // opt-in for the same reason the live unit tests are: a testnet outage or an
  // offline machine must not be reported as a code failure.
  testIgnore: process.env.POCKET_LIVE_E2E ? [] : ["**/*.live.spec.ts"],
  // Extension tests share one browser context and build on each other's state,
  // so they must run in order in a single worker.
  workers: 1,
  fullyParallel: false,
  // Each of these creates a wallet from scratch, which is scrypt plus a
  // three-word check the backup step now asks before it opens. The budget is
  // the flow's, not a round number: 60s covered onboarding before that gate
  // existed and no longer does.
  timeout: 120_000,
  reporter: "list",
});
