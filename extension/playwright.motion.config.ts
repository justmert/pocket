// Motion capture, deliberately not part of the gate.
//
// The UI/UX pass requires each batch's transitions to be captured as a frame
// sequence in ux/motion/ and checked at reduced motion for information parity.
// That is an artifact-producing run, not an assertion-producing one: it writes
// PNGs and asserts almost nothing, so it does not belong in the suite that has
// to stay green.
//
// It is a separate config rather than a separate directory because
// playwright.tests.config.ts claims `**/*.spec.ts` under tests/, and the only
// way to hold a file out of that net is to not name it .spec.ts.
import { defineConfig } from "@playwright/test";

process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.capture.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: "list",
  use: { trace: "off", video: "off", actionTimeout: 60_000 },
});
