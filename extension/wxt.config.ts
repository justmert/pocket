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
  // Everything under public/ is copied verbatim to the output root, untouched by
  // the bundler. That is what public/vendor/bb needs: see scripts/vendor-bb.mjs.
  //
  // It is also where the icons come from. WXT discovers public/icon/<size>.png
  // and writes the manifest `icons` key itself, so there is no icons entry
  // below; the mark is authored in scripts/icon.svg and rasterised from there.
  // An extension with no icons is a Web Store submission blocker, so gate 6
  // asserts the key exists and that every file it names is in the package,
  // rather than leaving that to this comment.
  publicDir: "public",
  manifest: {
    // The provider object has to run in the PAGE world to be reachable by page
    // scripts. MV3 forbids remotely hosted code, so it ships in the package
    // and the content script injects it from here.
    web_accessible_resources: [
      { resources: ["injected.js"], matches: ["http://*/*", "https://*/*"] },
    ],
    name: "Pocket",
    description:
      "A self-custody Stellar wallet with two pockets: one public, one private. Confidential, not anonymous.",
    permissions: [
      "storage",
      // idle auto-lock survives service-worker restarts only via alarms
      "alarms",
      // Lets the service worker host the prover in an isolated document.
      "offscreen",
      // the opening store grows with inbound events and must never be evicted
      // (SDK.md 10.1: discarding it loses receiving-side openings permanently)
      "unlimitedStorage",
    ],
    // Exactly the hosts the extension fetches, and no more. A host permission
    // the code never uses still shows up in the install prompt and still widens
    // what a compromised page could reach through the worker, so it costs the
    // user twice and buys nothing. Friendbot stays out for that reason: nothing
    // in the wallet funds an account.
    //
    // Balances and contract state are still read through Soroban RPC
    // getLedgerEntries rather than Horizon (see chain/balances.ts). The two
    // Horizon entries below are for the value chart, and they are two entries
    // rather than one because they answer different questions:
    //
    //   horizon-testnet  THIS account's balance over time (chain/balance-history.ts).
    //                    Only the active network knows the account exists.
    //   horizon (mainnet) the PRICE of an asset over time (chain/prices.ts).
    //                    Always mainnet: testnet has no real market, so a
    //                    testnet price is noise from a handful of test trades.
    //
    // Neither request names an amount, and the price request does not name the
    // account at all: it asks about the assets the BUILD is configured with, so
    // the request set is identical for every user of a given build.
    // The mainnet entry is PATH-SCOPED, and that is load-bearing rather than
    // tidy. This build is testnet-only, and the second thing keeping it there
    // (after the controller's refusal) is that Chrome will not let it talk to a
    // mainnet host at all. Horizon accepts `POST /transactions`, so granting
    // `https://horizon.stellar.org/*` would hand a future edit a way to submit a
    // real mainnet transaction and would quietly delete that guarantee.
    //
    // A match pattern includes its path, so the grant is narrowed to the one
    // read-only endpoint the chart needs. `/trade_aggregations` cannot submit
    // anything, and nothing else on that host is reachable.
    host_permissions: [
      "https://soroban-testnet.stellar.org/*",
      "https://horizon-testnet.stellar.org/*",
      "https://horizon.stellar.org/trade_aggregations*",
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
