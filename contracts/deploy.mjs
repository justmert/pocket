// Deploys Pocket's three contracts to a network and writes the resulting
// addresses to resources/deployment-<network>.json.
//
// Order matters: the verifier and auditor registry must exist before the token
// wrapper, because the wrapper's constructor binds both permanently.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const NETWORK = process.env.NETWORK ?? "testnet";
const SOURCE = process.env.SOURCE ?? "pocket-deploy";
const WASM = join(here, "target/wasm32v1-none/release");

// Native XLM's Stellar Asset Contract. One wrapper wraps one asset, forever.
const UNDERLYING = {
  testnet: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
  mainnet: "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA",
}[NETWORK];

const VKS = join(
  root,
  "resources/upstream/stellar-contracts/packages/tokens/src/confidential/circuits/vks",
);

/** CircuitType order. The verifier constructor takes them in exactly this order. */
const CIRCUITS = [
  "register",
  "withdraw",
  "transfer",
  "spender_transfer",
  "set_spender",
  "revoke_spender",
];

const sh = (args, opts = {}) =>
  execFileSync("stellar", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts })
    .trim();

function deploy(wasm, ctorArgs = []) {
  const args = [
    "contract", "deploy",
    "--wasm", join(WASM, wasm),
    "--source", SOURCE,
    "--network", NETWORK,
  ];
  if (ctorArgs.length) args.push("--", ...ctorArgs);
  const out = sh(args);
  const id = out.split("\n").filter((l) => /^C[A-Z2-7]{55}$/.test(l.trim())).pop();
  if (!id) throw new Error(`could not parse a contract id from:\n${out}`);
  return id.trim();
}

console.log(`deploying to ${NETWORK} from ${SOURCE}`);

// 1. Verifier, with all six keys installed at construction. They can never
//    change afterwards: the contract implements no mutation path.
const keys = CIRCUITS.map((c) => {
  const bytes = readFileSync(join(VKS, `${c}.vk.bin`));
  if (bytes.length !== 1760) {
    throw new Error(`${c}.vk.bin is ${bytes.length} bytes, expected the 1760-byte on-chain layout`);
  }
  return bytes.toString("hex");
});
console.log(`  verification keys: ${keys.length} x 1760 bytes`);

const verifier = deploy("pocket_confidential_verifier.wasm", [
  "--keys", JSON.stringify(keys),
]);
console.log(`  verifier  ${verifier}`);

// 2. Auditor registry. Self-serve, no constructor arguments.
const auditor = deploy("pocket_confidential_auditor.wasm");
console.log(`  auditor   ${auditor}`);

// 3. Token wrapper. Binds the asset, verifier and registry permanently.
const token = deploy("pocket_confidential_token.wasm", [
  "--token", UNDERLYING,
  "--verifier", verifier,
  "--auditor", auditor,
]);
console.log(`  token     ${token}`);

const out = {
  network: NETWORK,
  deployedAt: new Date().toISOString(),
  deployer: sh(["keys", "address", SOURCE]),
  underlying: UNDERLYING,
  verifier,
  auditor,
  token,
  vkSha256: Object.fromEntries(
    CIRCUITS.map((c) => [
      c,
      execFileSync("shasum", ["-a", "256", join(VKS, `${c}.vk.bin`)], { encoding: "utf8" })
        .split(" ")[0],
    ]),
  ),
};
const path = join(root, `resources/deployment-${NETWORK}.json`);
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${path}`);
