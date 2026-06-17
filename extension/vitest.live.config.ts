import { defineConfig } from "vitest/config";

// The live suite: real testnet, real contracts, no mocks. Separate from the
// default run so its network dependence is opt-in and visible.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.live.test.ts"],
    testTimeout: 120_000,
    // One file at a time, because several of these submit transactions from the
    // SAME funded testnet account. stellar-core allows one transaction per
    // source account in its queue and answers TRY_AGAIN_LATER for the rest, so
    // running the files in parallel makes the suite fail against itself.
    //
    // Observed: in parallel, e2e.live and auditor.live failed with
    // outcome.kind === "notAccepted"; each passed alone; serially all 8 files
    // and 43 tests pass. The flake looks exactly like a broken submit path,
    // which is the worst way for a suite to lie.
    fileParallelism: false,
  },
});
