// Copies the compiled OpenZeppelin circuits and their verification keys into
// the extension package.
//
// These are build artifacts of the upstream Noir sources, compiled with the
// pinned toolchain (nargo 1.0.0-beta.11 + bb 0.87.0). The VKs are committed
// upstream and reproduce byte-for-byte from source with that toolchain, which
// is what makes the release gate meaningful: we can independently verify that a
// deployment's on-chain keys correspond to the audited circuits.
import { cpSync, mkdirSync, existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const upstream = join(
  here,
  "../../resources/upstream/stellar-contracts/packages/tokens/src/confidential/circuits",
);
const dest = join(here, "../public/vendor/circuits");

if (!existsSync(upstream)) {
  console.error(
    "upstream circuits not found. Clone OpenZeppelin/stellar-contracts into resources/upstream first.",
  );
  process.exit(1);
}

mkdirSync(dest, { recursive: true });
cpSync(join(upstream, "target"), join(dest, "target"), { recursive: true });
cpSync(join(upstream, "vks"), join(dest, "vks"), { recursive: true });

const size = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce(
    (n, e) => n + (e.isDirectory() ? size(join(dir, e.name)) : statSync(join(dir, e.name)).size),
    0,
  );
console.log(`vendored circuits -> public/vendor/circuits (${(size(dest) / 1e3).toFixed(0)} KB)`);
