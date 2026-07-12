// Deploys ONE additional confidential token wrapper for an already-bootstrapped
// network, reusing the verifier and auditor registry from the existing
// deployment. A wrapper binds exactly one underlying asset forever, so a second
// asset (e.g. USDC) is a new wrapper, not a change to the first.
//
// The verifier and auditor are SHARED across wrappers (contracts/token/src/lib.rs
// documents this), so no new verification keys are installed and no auditor
// registry is redeployed. Only the wrapper is new.
//
// Usage:
//   UNDERLYING=<SAC contract id> SYMBOL=USDC node add-asset.mjs
// Optional: NETWORK (default testnet), SOURCE (default pocket-deploy).
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const NETWORK = process.env.NETWORK ?? "testnet";
const SOURCE = process.env.SOURCE ?? "pocket-deploy";
const WASM = join(here, "target/wasm32v1-none/release");

const UNDERLYING = process.env.UNDERLYING;
const SYMBOL = process.env.SYMBOL;
if (!UNDERLYING || !SYMBOL) {
  console.error("set UNDERLYING (the SAC contract id) and SYMBOL");
  process.exit(2);
}

const sh = (args, opts = {}) =>
  execFileSync("stellar", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  }).trim();

const deploymentPath = join(root, `resources/deployment-${NETWORK}.json`);
const deployment = JSON.parse(readFileSync(deploymentPath, "utf8"));
const { verifier, auditor } = deployment;
if (!verifier || !auditor) {
  throw new Error(`deployment-${NETWORK}.json is missing verifier/auditor to reuse`);
}

console.log(`adding ${SYMBOL} wrapper on ${NETWORK} from ${SOURCE}`);
console.log(`  underlying ${UNDERLYING}`);
console.log(`  verifier   ${verifier} (reused)`);
console.log(`  auditor    ${auditor} (reused)`);

const out = sh([
  "contract",
  "deploy",
  "--wasm",
  join(WASM, "pocket_confidential_token.wasm"),
  "--source",
  SOURCE,
  "--network",
  NETWORK,
  "--",
  "--token",
  UNDERLYING,
  "--verifier",
  verifier,
  "--auditor",
  auditor,
]);
const token = out
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => /^C[A-Z2-7]{55}$/.test(l))
  .pop();
if (!token) throw new Error(`could not parse a contract id from:\n${out}`);
console.log(`  token      ${token}`);

// Record the multi-asset set alongside the original single-asset fields, so the
// file stays backward-compatible while gaining a per-asset list.
const asset = { symbol: SYMBOL, underlying: UNDERLYING, token, verifier, auditor };
const existing = deployment.confidentialAssets ?? [
  {
    symbol: deployment.symbol ?? "XLM",
    underlying: deployment.underlying,
    token: deployment.token,
    verifier: deployment.verifier,
    auditor: deployment.auditor,
  },
];
if (!existing.some((a) => a.token === token)) existing.push(asset);
deployment.confidentialAssets = existing;
deployment.addedAt = new Date().toISOString();
writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2) + "\n");
console.log(`\nwrote ${deploymentPath}`);
console.log(`\nconfig entry for extension/src/core/config.ts:`);
console.log(
  JSON.stringify({ token, verifier, auditor, underlying: UNDERLYING, symbol: SYMBOL }, null, 2),
);
