import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The suites under `tests/`, which the default run does not touch.
//
// This config exists because of a break I shipped: `vitest.config.ts` includes
// `src/**` only, so 88 tests under `tests/auth` went red in a commit whose
// pre-commit run reported 597 passing. The suites were written during the test
// pass and each agent ran its own with its own config; nothing ran them
// afterwards. A test nobody runs is a file, not a test.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: ["tests/auth/**/*.test.ts", "tests/failure/**/*.test.ts", "tests/edge/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    setupFiles: ["tests/failure/_harness/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
