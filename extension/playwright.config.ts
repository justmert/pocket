import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Extension tests share one browser context and build on each other's state,
  // so they must run in order in a single worker.
  workers: 1,
  fullyParallel: false,
  timeout: 60_000,
  reporter: "list",
});
