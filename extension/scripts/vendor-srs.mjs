// Downloads the Aztec Ignition SRS prefix our circuits need and bundles it.
//
// bb.js fetches this from crs.aztec.network at proving time by default. In an
// MV3 extension that means a network dependency for a core operation and an
// argument with the remote-code policy we do not need to have, so we ship it.
//
// Size is driven by the largest circuit's PROVING SUBGROUP, which is not the
// number `bb gates` prints. Measured with acirGetCircuitSizes in a real browser:
//
//   register          gates=14412  subgroup=16384
//   withdraw          gates=28868  subgroup=32768
//   transfer          gates=28926  subgroup=32768
//   spender_transfer  gates=28926  subgroup=32768
//   set_spender       gates=28926  subgroup=32768
//   revoke_spender    gates=28926  subgroup=32768
//
// bb needs subgroup+1 points, so 32769. We take 2^16 for headroom: a circuit
// change that pushes past 32768 would otherwise trap inside the wasm with an
// opaque "unreachable" rather than a useful error. 2^16 * 64 B = 4.2 MB.
//
// Integrity: the G2 point is compared against the value compiled into the
// on-chain verifier, so a substituted SRS fails the build rather than silently
// producing proofs against a different trusted setup.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, "../public/vendor/srs");

const HOST = "https://crs.aztec.network";
const NUM_POINTS = 1 << 16;
/** The largest subgroup any of our six circuits needs. Asserted at build time. */
const MAX_SUBGROUP = 32768;
const G1_BYTES = NUM_POINTS * 64;

// The Ignition [tau]_2 point. The on-chain verifier compiles the same four
// 32-byte limbs into LHS_G2_BYTES, but in c1||c0 order (the Ethereum precompile
// convention) where the CDN serves c0||c1. Verified limb-by-limb against
// crates/ultrahonk-soroban-verifier/src/ec.rs.
//
// This gate is the point of vendoring: a substituted SRS would mean proving
// against a different trusted setup than the chain verifies against, and
// nothing downstream would notice.
const EXPECTED_G2_SHA256 = "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f";
const EXPECTED_G2_LIMBS = [
  "0118c4d5b837bcc2bc89b5b398b5974e9f5944073b32078b7e231fec938883b0",
  "260e01b251f6f1c7e7ff4e580791dee8ea51d87a358e038b4efe30fac09383c1",
  "22febda3c0c0632a56475b4214e5615e11e6dd3f96e6cea2854a87d4dacc5e55",
  "04fc6369f7110fe3d25156c1bb9a72859cf2a04641f99ba4ee413c80da6a5fe4",
];

async function main() {
  mkdirSync(dest, { recursive: true });
  const g1Path = join(dest, "g1.dat");
  const g2Path = join(dest, "g2.dat");

  if (existsSync(g1Path) && existsSync(g2Path)) {
    console.log("srs already vendored");
    return;
  }

  const g1res = await fetch(`${HOST}/g1.dat`, {
    headers: { Range: `bytes=0-${G1_BYTES - 1}` },
  });
  if (!g1res.ok && g1res.status !== 206) {
    throw new Error(`g1 fetch failed: ${g1res.status}`);
  }
  const g1 = new Uint8Array(await g1res.arrayBuffer());
  if (g1.length !== G1_BYTES) {
    throw new Error(`expected ${G1_BYTES} g1 bytes, got ${g1.length}`);
  }

  const g2res = await fetch(`${HOST}/g2.dat`);
  if (!g2res.ok) throw new Error(`g2 fetch failed: ${g2res.status}`);
  const g2 = new Uint8Array(await g2res.arrayBuffer());
  if (g2.length !== 128) throw new Error(`expected 128 g2 bytes, got ${g2.length}`);

  writeFileSync(g1Path, g1);
  writeFileSync(g2Path, g2);

  const { createHash } = await import("node:crypto");
  const g2sha = createHash("sha256").update(g2).digest("hex");
  if (g2sha !== EXPECTED_G2_SHA256) {
    throw new Error(
      `g2 checksum mismatch. Expected ${EXPECTED_G2_SHA256}, got ${g2sha}. ` +
        `Refusing to bundle an SRS that is not the ceremony the chain verifies against.`,
    );
  }
  const limbs = [];
  for (let i = 0; i < 128; i += 32) limbs.push(Buffer.from(g2.slice(i, i + 32)).toString("hex"));
  const sorted = (a) => [...a].sort().join(",");
  if (sorted(limbs) !== sorted(EXPECTED_G2_LIMBS)) {
    throw new Error("g2 limbs do not match the on-chain verifier's compiled constant");
  }
  if (NUM_POINTS <= MAX_SUBGROUP) {
    throw new Error(
      `SRS has ${NUM_POINTS} points but the largest circuit subgroup is ${MAX_SUBGROUP}; ` +
        `bb needs subgroup+1 and traps with an opaque "unreachable" when short.`,
    );
  }
  console.log(
    `vendored srs -> public/vendor/srs (${NUM_POINTS} points, ${(g1.length / 1e6).toFixed(2)} MB)`,
  );
  console.log(`g2 sha256 = ${g2sha}`);
}

await main();
