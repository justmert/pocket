import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// T2's node-side edge cases.
//
// Its own config rather than an entry in the default one, for the same reason
// T3 has one: these specs start a real archive server as a child process
// against a real SQLite file, and that deserves an explicit run rather than
// being folded silently into `npm test`.
//
// Hermetic. No testnet, no funded account, no network beyond a loopback socket
// this process opened.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    environment: "node",
    include: ["tests/edge/**/*.test.ts"],
    // Starting node and opening a database is the slowest thing here, and it is
    // seconds. A minute means something is wedged.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
