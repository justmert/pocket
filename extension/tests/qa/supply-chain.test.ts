// The built artifact, held to what it is allowed to be.
//
// Every control here is one that stays correct today only because nobody has
// changed it, which is not a control at all. The coverage matrix
// (qa/01-coverage.md) found the content security policy asserted by nothing, the
// permission set asserted by nothing, and no outbound-endpoint diff anywhere in
// the tree.
//
// These are vitest rather than Playwright on purpose: they read the SHIPPED
// FILES, not a running browser, so they answer "what did we build" rather than
// "what did it do this time". Run `npm run build` first; the tests say so rather
// than silently passing on a stale or absent artifact.
import { describe, expect, it } from "vitest";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), ".output", "chrome-mv3");
const built = existsSync(join(OUT, "manifest.json"));

/**
 * exactly what this wallet is allowed to request.
 *
 * a diff against this list is the point: an addition must fail the build rather
 * than ship, because a permission nobody argued for is a permission nobody
 * reviewed. changing this array is the argument.
 */
const ALLOWED_PERMISSIONS = ["storage", "alarms", "offscreen", "unlimitedStorage"];
/**
 * and exactly the hosts it may reach, with the argument for each.
 *
 *   soroban-testnet   every chain read and every submission.
 *   horizon-testnet   THIS account's balance over time, for the value chart.
 *                     Soroban RPC has no history endpoint; Horizon does.
 *   horizon (mainnet) the PRICE of an asset over time. Always mainnet, because
 *                     testnet has no market and a testnet price would be noise
 *                     from a handful of test trades.
 *
 * The mainnet entry is NARROWED TO A PATH and that is the whole argument for
 * allowing it at all. Horizon accepts `POST /transactions`, so an unscoped
 * `https://horizon.stellar.org/*` would give a future edit a way to submit a
 * real mainnet transaction, and this build is testnet-only. A match pattern
 * includes its path, so the grant covers the one read-only endpoint the chart
 * needs and nothing else on that host. tests/qa/network-guard.test.ts asserts
 * that rule directly.
 */
const ALLOWED_HOST_PERMISSIONS = [
  "https://soroban-testnet.stellar.org/*",
  "https://horizon-testnet.stellar.org/*",
  "https://horizon.stellar.org/trade_aggregations*",
];
const REQUIRED_CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; img-src 'self' data:;";

/**
 * every host the shipped code is allowed to name.
 *
 * `wasm-unsafe-eval` is in the policy because the prover needs WebAssembly, and
 * that is the one relaxation this product makes. It is listed here so that if it
 * ever widens to `unsafe-eval`, this test is what says so.
 */
const ALLOWED_HOSTS = [
  "soroban-testnet.stellar.org",
  "horizon-testnet.stellar.org",
  "horizon.stellar.org",
  "friendbot.stellar.org",
  "api.defindex.io",
  // Aquarius swap: keyless routing API (testnet + mainnet hosts). The wallet
  // POSTs a token pair and gets back routing data; it never sends a key.
  "amm-api-testnet.aqua.network",
  "amm-api.aqua.network",
  // CCTP: Circle's attestation service (Iris), sandbox + mainnet. Read-only,
  // keyless: the wallet fetches a burn's message + attestation to complete the
  // Stellar-side mint.
  "iris-api-sandbox.circle.com",
  "iris-api.circle.com",
  // StellarExpert asset directory: keyless, read-only. The manage-assets screen
  // searches it for classic assets to open a trustline for. Never a key, never a
  // write; the directory serves permissive CORS, so it needs no host permission.
  "api.stellar.expert",
  "stellar.org",
  // Pocket's own durable event archive (the indexer). The wallet reads
  // confidential event history from it to rebuild the openings that make a
  // private balance spendable; a keyless read, never a key or a write. This is
  // VITE_ARCHIVE_URL, http://127.0.0.1:8787 in a local build (loopback, skipped
  // above) and this host in the shipped .env.production build.
  "archive.pocketwallet.app",
  "www.w3.org", // svg namespace, not a request
];

/**
 * hosts that appear in the shipped bytes and are never fetched, each with the
 * reason and the thing that keeps it true.
 *
 * this list is not a way to make the test pass. it is the argument, written
 * down, and anything not on it still fails — which is the whole point: the
 * check is worthless if a new host can be added without someone typing a reason
 * next to it.
 */
const JUSTIFIED_UNFETCHED: Record<string, string> = {
  // config.ts declares a mainnet entry whose rpcUrl is this host. the wallet
  // refuses to switch to it — controller.setNetwork throws "Pocket is
  // testnet-only in this build." — and the manifest grants no host permission
  // for it, so the string is declared and unreachable. asserted by
  // tests/qa/network-guard.test.ts, which is the thing that keeps this true.
  "mainnet.sorobanrpc.com": "declared in config, refused by setNetwork, no host permission",
  // bb.js's default CRS download URL. this project vendors the SRS precisely so
  // that fetch never happens, and e2e/prover.spec.ts proves the prover
  // initialises from the bundled SRS with the network off.
  "crs.aztec.network": "bb.js default CRS url, unreached because the SRS is vendored",
  // documentation urls inside third-party error messages.
  "json-schema.org": "documentation url in an error message",
  "react.dev": "documentation url in an error message",
  // the block explorer the activity detail links an address or tx to. it is the
  // href of an <a target="_blank">, opened as a NEW TAB by the browser on a click,
  // never fetched by the extension: no host permission is granted for it and no
  // code path calls fetch() against it.
  "stellar.expert":
    "external explorer link (a new browser tab) from the activity detail, never fetched",
};

function manifest(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));
}

function shippedFiles(dir = OUT, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) shippedFiles(p, out);
    // the vendored SRS and circuit binaries are megabytes of field elements and
    // are not code; scanning them for URLs finds only noise.
    else if (/\.(js|mjs|html|css|json)$/.test(e) && !/vendor\/(srs|circuits)\//.test(p))
      out.push(p);
  }
  return out;
}

describe.runIf(built)("the shipped artifact", () => {
  it("requests exactly the permissions it is allowed to, and no more", () => {
    const m = manifest();
    expect(
      [...((m.permissions as string[]) ?? [])].sort(),
      "the permission set changed. a permission nobody argued for is a permission nobody reviewed: if this addition is intended, change ALLOWED_PERMISSIONS in the same commit and say why",
    ).toEqual([...ALLOWED_PERMISSIONS].sort());
    expect([...((m.host_permissions as string[]) ?? [])].sort()).toEqual(
      [...ALLOWED_HOST_PERMISSIONS].sort(),
    );
    expect(m.optional_permissions ?? [], "optional permissions are still permissions").toEqual([]);
  });

  it("enforces the content security policy it claims", () => {
    const csp = (manifest().content_security_policy as { extension_pages?: string } | undefined)
      ?.extension_pages;
    expect(csp, "the extension pages have no content security policy at all").toBeTruthy();
    expect(csp).toBe(REQUIRED_CSP);
    // The two that matter most, asserted by name so a future edit that keeps the
    // string shaped right but loosens it still fails.
    expect(csp, "unsafe-eval would let a page injection become code execution").not.toMatch(
      /(^|[^-])\bunsafe-eval\b/,
    );
    expect(csp, "unsafe-inline would defeat the policy entirely").not.toContain("unsafe-inline");
    expect(csp, "scripts must come from this extension only").toContain("script-src 'self'");
  });

  it("names no host outside the expected set anywhere in the shipped code", () => {
    const rogue: string[] = [];
    for (const p of shippedFiles()) {
      const text = readFileSync(p, "utf8");
      for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = m[1]!.toLowerCase();
        // A loopback is the deliberately-configured LOCAL archive (VITE_ARCHIVE_URL
        // in extension/.env, http://127.0.0.1:8787). It is expected in a local build
        // and, being localhost, cannot exfiltrate anything off the machine, so it is
        // not the supply-chain risk this test hunts (an unexpected EXTERNAL host).
        // Whether a loopback may SHIP is a separate invariant, owned authoritatively
        // by scripts/release-gate.sh, which refuses "the package references a loopback
        // address" over the packaged output before any release goes out.
        if (host === "localhost" || host.startsWith("127.")) continue;
        if (host in JUSTIFIED_UNFETCHED) continue;
        if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
          rogue.push(`${host} (in ${p.replace(OUT, "")})`);
        }
      }
    }
    expect(
      [...new Set(rogue)],
      "the shipped artifact names an EXTERNAL host that is not in the expected set (a loopback is allowed here and guarded separately by the release gate)",
    ).toEqual([]);
  });

  it("loads no remote code and evaluates no dynamic code", () => {
    const offenders: string[] = [];
    for (const p of shippedFiles()) {
      if (!/\.(js|mjs|html)$/.test(p)) continue;
      const text = readFileSync(p, "utf8");
      // `new Function` and `eval` in shipped extension code are how a content
      // injection becomes execution. importScripts from a remote URL is the
      // supply-chain version of the same thing.
      // bb.js contains `new Function`. it is third-party, it is not reached on
      // any path this wallet takes, and the content security policy above has
      // no `unsafe-eval`, so chrome blocks it outright if it ever were. the
      // exemption is by path so that the same construct appearing in OUR code
      // still fails.
      const thirdPartyProver = /vendor\/bb\//.test(p);
      for (const [re, what] of [
        [/\beval\s*\(/g, "eval("],
        ...(thirdPartyProver ? [] : ([[/new\s+Function\s*\(/g, "new Function("]] as const)),
        [/importScripts\s*\(\s*["'`]https?:/g, "remote importScripts"],
        [/<script[^>]+src\s*=\s*["']https?:/gi, "remote <script src>"],
        [/<link[^>]+href\s*=\s*["']https?:/gi, "remote <link href>"],
      ] as const) {
        if (re.test(text)) offenders.push(`${what} in ${p.replace(OUT, "")}`);
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("ships no source map and no test vector", () => {
    const leaked = shippedFiles().filter((p) => /\.map$/.test(p));
    expect(
      leaked.map((p) => p.replace(OUT, "")),
      "source maps expose the unminified worker",
    ).toEqual([]);
    // A known BIP-39 test vector shipping inside the artifact would mean a
    // fixture leaked out of the tests and into the product.
    const vectors = ["abandon abandon abandon", "zoo zoo zoo", "legal winner thank"];
    const hits: string[] = [];
    for (const p of shippedFiles()) {
      const text = readFileSync(p, "utf8");
      for (const v of vectors) if (text.includes(v)) hits.push(`${v} in ${p.replace(OUT, "")}`);
    }
    expect(hits, "a phrase test vector shipped inside the wallet").toEqual([]);
  });
});

describe.runIf(!built)("the shipped artifact", () => {
  it("cannot be checked without a build", () => {
    // Deliberately a failure rather than a skip. A supply-chain check that
    // quietly passes when there is nothing to check is worse than none: it
    // reports green for an artifact nobody looked at.
    expect.unreachable(
      "no build at extension/.output/chrome-mv3 — run `npm run build` before this tier. These assertions are about the shipped files, so passing without them would be a lie.",
    );
  });
});
