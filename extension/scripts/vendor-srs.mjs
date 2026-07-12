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
// Integrity: BOTH halves are pinned by sha256 before anything is written, and
// the G2 point is additionally compared limb-by-limb against the value compiled
// into the on-chain verifier. A substituted SRS fails the build rather than
// silently producing proofs against a different trusted setup.
import { createHash } from "node:crypto";
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

/**
 * The commitment key, pinned the same way [tau]_2 is.
 *
 * g2 is 128 bytes and got both a digest and a limb comparison; g1 is 4,194,304
 * bytes and got a LENGTH CHECK. That asymmetry was backwards. g2 is the part an
 * attacker would serve honestly, because the verifier compiles it in and a wrong
 * one is caught; g1 is the part that decides what every proof is committed
 * under, and a substituted one is accepted silently. The release gate does not
 * cover it either: gate 2 reproduces the verification keys with the standalone
 * `bb` binary, which uses its own CRS cache and never reads this directory.
 *
 * The consequence of a substitution is availability rather than theft. Every
 * confidential operation fails at the simulate step inside `signAndSubmit`,
 * which runs before the signature and before submission, so no fee is spent.
 * Loud, and cheap to prevent.
 *
 * The value is the first 4,194,304 bytes of the Aztec Ignition g1 file.
 * Observed identical on 2026-07-31 (when this was first vendored) and again on
 * 2026-08-07 from a different session. Two observations a week apart is
 * evidence, not proof: it establishes that the CDN is serving stable bytes, and
 * it is what makes a LATER substitution fail. Verifying these bytes against an
 * independently published ceremony transcript is a separate step and has not
 * been done here.
 */
const EXPECTED_G1_SHA256 = "2d9fc346188f2429e9ca7451304df83700ba1f0352183aa7643fb97ecc1e4566";
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
  const g1sha = createHash("sha256").update(g1).digest("hex");
  if (g1sha !== EXPECTED_G1_SHA256) {
    throw new Error(
      `g1 checksum mismatch. Expected ${EXPECTED_G1_SHA256}, got ${g1sha}. ` +
        `The commitment key is not the one this build proves against: every proof would be ` +
        `committed under a different trusted setup and fail at simulation. Refusing to vendor it.`,
    );
  }

  const g2res = await fetch(`${HOST}/g2.dat`);
  if (!g2res.ok) throw new Error(`g2 fetch failed: ${g2res.status}`);
  const g2 = new Uint8Array(await g2res.arrayBuffer());
  if (g2.length !== 128) throw new Error(`expected 128 g2 bytes, got ${g2.length}`);

  // EVERY check runs before EITHER file is written.
  //
  // The g2 checks used to sit after both `writeFileSync` calls, so a rejected
  // SRS was already on disk by the time the throw happened. That is worse than
  // it sounds because of the short-circuit at the top of this function: the next
  // run sees both files present, prints "srs already vendored", and returns
  // without verifying anything. One failed vendor left bytes that every
  // subsequent build accepted silently.
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

  writeFileSync(g1Path, g1);
  writeFileSync(g2Path, g2);
  console.log(
    `vendored srs -> public/vendor/srs (${NUM_POINTS} points, ${(g1.length / 1e6).toFixed(2)} MB)`,
  );
  console.log(`g2 sha256 = ${g2sha}`);
}

await main();
