import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

// The browser half of the failure suite (T3).
//
// The vitest specs prove the clients refuse. These prove the refusal reaches the
// screen: a real Chrome, the real built extension, a real service worker, and a
// dependency that is genuinely unreachable at the socket rather than stubbed in
// JavaScript.
export default defineConfig({
  testDir: fileURLToPath(new URL(".", import.meta.url)),
  testMatch: "**/*.spec.ts",
  // Each test launches its own browser and its own fault server, so they are
  // independent. One worker keeps the machine honest about resource contention
  // while a wallet is doing scrypt.
  workers: 1,
  fullyParallel: false,
  timeout: 120_000,
  reporter: "list",
});
