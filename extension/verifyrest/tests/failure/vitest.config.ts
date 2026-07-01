import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The failure and recovery suite (T3).
//
// Its own config rather than an entry in the default one: every spec here runs a
// local server, some of them deliberately stall a socket, and that deserves an
// explicit run rather than being folded silently into `npm test`.
//
// Hermetic. No test here touches the network: every dependency is a server this
// process started on port 0 and can close.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    environment: "node",
    include: ["tests/failure/**/*.test.ts"],
    setupFiles: ["tests/failure/_harness/setup.ts"],
    // A stalled dependency plus its deadline is the slowest thing here, and
    // those deadlines are seconds, not minutes.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
