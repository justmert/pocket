import { defineConfig } from "wxt";

// Pocket - Chrome MV3. Two pockets from one seed: a public one holding ordinary
// XLM/USDC, and a private one holding the same assets inside the OpenZeppelin
// confidential token wrapper.
//
// Architecture (phase 1 decision D3, and forced by the platform):
//   - service worker  : all networking, the encrypted vault, tx assembly
//   - offscreen doc   : UltraHonk proving (phase 3)
// bb.js always spawns a Worker and MV3 service workers cannot nest workers, so
// proving can never live in the worker regardless of isolation.
export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: "src",
  manifest: {
    name: "Pocket",
    description:
      "A self-custody Stellar wallet with two pockets: one public, one private. Confidential, not anonymous.",
    permissions: [
      "storage",
      // idle auto-lock survives service-worker restarts only via alarms
      "alarms",
      // the opening store grows with inbound events and must never be evicted
      // (SDK.md 10.1: discarding it loses receiving-side openings permanently)
      "unlimitedStorage",
    ],
    host_permissions: [
      "https://soroban-testnet.stellar.org/*",
      "https://horizon-testnet.stellar.org/*",
      "https://friendbot.stellar.org/*",
    ],
    // 'wasm-unsafe-eval' is required for the phase 3 prover: Chrome's default
    // extension CSP disables WebAssembly outright. img-src is pinned to our own
    // origin so a token logo can never become a per-holding tracking pixel.
    content_security_policy: {
      extension_pages:
        "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; img-src 'self' data:;",
    },
    // Opts the extension's own pages into cross-origin isolation, which lets the
    // phase 3 offscreen document take bb.js's multi-threaded path. Chrome emits
    // these as real COOP/COEP response headers on every chrome-extension://
    // resource load. Not load-bearing: bb.js falls back to single-threaded wasm
    // when crossOriginIsolated is false, so this buys speed, not function.
    cross_origin_embedder_policy: { value: "require-corp" },
    cross_origin_opener_policy: { value: "same-origin" },
  },
});
