import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  test: {
    environment: "node",
    include: [
      "src/core/**/*.test.ts",
      "tests/failure/**/*.test.ts",
      "tests/auth/**/*.test.ts",
    ],
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    setupFiles: ["tests/failure/_harness/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
