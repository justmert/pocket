import { defineConfig } from "vitest/config";

// The live suite: real testnet, real contracts, no mocks. Separate from the
// default run so its network dependence is opt-in and visible.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 120_000,
  },
});
