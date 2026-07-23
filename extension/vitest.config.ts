import { defineConfig } from "vitest/config";

// Live tests are excluded from the default run deliberately. They hit real
// testnet, so a clean clone, an offline build machine or a testnet outage would
// otherwise fail the whole suite and make "all tests pass" a statement about
// one developer's network rather than about the code. `npm run test:live` runs
// them explicitly.
export default defineConfig({
  test: {
    environment: "node",
    // `.tsx` as well as `.ts`. A UI test that renders a component has to be
    // JSX, and a pattern that cannot match one means such a test is a file
    // rather than a test: it sits in the tree, never runs, and `npm run check`
    // stays green while it rots. That has happened here before, which is why
    // CLAUDE.md states the rule.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    exclude: ["**/node_modules/**", "src/**/*.live.test.ts", "src/**/*.live.test.tsx"],
  },
});
