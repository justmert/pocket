import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The authorisation suite (T5).
//
// This wallet has no users, no roles and no routes, so "auth" here means the
// four boundaries that actually decide whether key material moves: the
// locked-state allowlist, the guard each locked-state operation carries of its
// own, the sender check on the message channel, and the binding between a
// reviewed transaction and the bytes that get signed.
//
// Real scrypt runs here, so the whole file is slower than a pure-logic suite.
// That is the point: the KDF is the thing standing between a stolen device and
// a seed, and stubbing it would test a wallet nobody ships.
export default defineConfig({
  root: fileURLToPath(new URL("../..", import.meta.url)),
  test: {
    environment: "node",
    include: ["tests/auth/**/*.test.ts"],
    // The handle spec drives a real RPC socket through T3's fault harness,
    // which serves TLS with a throwaway certificate for 127.0.0.1. Trusting
    // that certificate is what this setup file does, and it is scoped to this
    // config so nothing else inherits it. The alternative was a second copy of
    // the same certificate generator, which is worse than the dependency.
    setupFiles: ["tests/failure/_harness/setup.ts"],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
