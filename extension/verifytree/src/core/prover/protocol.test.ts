import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PUBLIC_INPUT_COUNT, EXPECTED_PROOF_BYTES, PROOF_FIELDS, FIELD_BYTES } from "./protocol";

// The circuit sources are the authority for public-input counts. DESIGN.md is
// authoritative for MEMBERSHIP, the contract's assembly for ORDER, and the
// circuit signature for the SLOT COUNT. A permutation of two same-typed inputs
// verifies a different statement, so none of these may be guessed.
const CIRCUITS = join(
  import.meta.dirname,
  "../../../../resources/upstream/stellar-contracts/packages/tokens/src/confidential/circuits",
);

describe("public input counts, against the circuit sources", () => {
  const available = existsSync(CIRCUITS);

  for (const [name, expected] of Object.entries(PUBLIC_INPUT_COUNT)) {
    it.skipIf(!available)(`${name} declares ${expected} pub Field slots`, () => {
      const src = readFileSync(join(CIRCUITS, name, "src/main.nr"), "utf8");
      const main = src.slice(src.indexOf("fn main("), src.indexOf(") {", src.indexOf("fn main(")));
      const actual = (main.match(/:\s*pub\s+Field/g) ?? []).length;
      expect(actual).toBe(expected);
    });
  }

  it("counts SLOTS, not logical values", () => {
    // Register carries four logical inputs (Y, PVK, addr_f, acct_f) but six
    // slots, because a Grumpkin point occupies two. This is the exact mistake
    // that would split the prover's output in the wrong place.
    expect(PUBLIC_INPUT_COUNT.register).toBe(6);
  });
});

describe("proof geometry", () => {
  it("pins the non-ZK keccak proof at 456 fields", () => {
    // The constant the on-chain verifier hardcodes as PROOF_FIELDS.
    expect(PROOF_FIELDS).toBe(456);
    expect(EXPECTED_PROOF_BYTES).toBe(456 * 32);
    expect(EXPECTED_PROOF_BYTES).toBe(14592);
  });

  it("predicts the prover's raw output size per circuit", () => {
    // bb.js returns publicInputs || proof, so the raw length is a function of
    // the circuit. Measured for transfer: 15360 bytes.
    expect(PUBLIC_INPUT_COUNT.transfer * FIELD_BYTES + EXPECTED_PROOF_BYTES).toBe(15360);
  });
});
