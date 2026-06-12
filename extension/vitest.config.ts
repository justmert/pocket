import { defineConfig } from "vitest/config";

// Live tests are excluded from the default run deliberately. They hit real
// testnet, so a clean clone, an offline build machine or a testnet outage would
// otherwise fail the whole suite and make "all tests pass" a statement about
// one developer's network rather than about the code. `npm run test:live` runs
// them explicitly.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["**/node_modules/**", "src/**/*.live.test.ts"],
  },
});
