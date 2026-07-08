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
const ALLOWED_HOST_PERMISSIONS = ["https://soroban-testnet.stellar.org/*"];
const REQUIRED_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; img-src 'self' data:;";

/**
 * every host the shipped code is allowed to name.
 *
 * `wasm-unsafe-eval` is in the policy because the prover needs WebAssembly, and
 * that is the one relaxation this product makes. It is listed here so that if it
 * ever widens to `unsafe-eval`, this test is what says so.
 */
const ALLOWED_HOSTS = [
  "soroban-testnet.stellar.org",
  "friendbot.stellar.org",
  "api.defindex.io",
  "stellar.org",
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
    else if (/\.(js|mjs|html|css|json)$/.test(e) && !/vendor\/(srs|circuits)\//.test(p)) out.push(p);
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
        if (host === "localhost" || host.startsWith("127.")) {
          rogue.push(`${host} (loopback, in ${p.replace(OUT, "")})`);
          continue;
        }
        if (host in JUSTIFIED_UNFETCHED) continue;
        if (!ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) {
          rogue.push(`${host} (in ${p.replace(OUT, "")})`);
        }
      }
    }
    expect(
      [...new Set(rogue)],
      "the shipped artifact names a host that is not in the expected set. a loopback address here is the release-gate failure config.ts warns about: it points every user at their own machine",
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
    expect(leaked.map((p) => p.replace(OUT, "")), "source maps expose the unminified worker").toEqual(
      [],
    );
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
