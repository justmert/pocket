import { defineConfig } from "@playwright/test";

// T2's own config so this slice runs without touching the root one, which the
// existing e2e suite and the other agents share. Merge into a single root
// config once every slice has landed.
export default defineConfig({
  testDir: ".",
  // Every test builds its own Chrome profile in a fresh temp directory and its
  // own wallet, so there is nothing to share and nothing to order.
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  // Real testnet reads and a real scrypt KDF. A minute is a hang, not a slow
  // network.
  timeout: 120_000,
  reporter: "list",
  forbidOnly: !!process.env.CI,
});
