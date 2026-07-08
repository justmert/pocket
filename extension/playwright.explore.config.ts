// The exploratory sessions, deliberately not part of the gate.
//
// These drive the real built extension the way a person would and capture what
// they find. They assert almost nothing: their output is screenshots and a
// written account, and a defect they turn up becomes a test in a real tier
// rather than an assertion here. A file that produces artifacts does not belong
// in the suite that has to stay green.
import { defineConfig } from "@playwright/test";

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.explore.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  reporter: "list",
  use: { trace: "off", video: "off", actionTimeout: 30_000 },
});
