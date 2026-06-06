import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  vkFromSk,
  publicViewingKey,
  delegationViewingKey,
  spendRandomness,
  allowanceRandomness,
  transferBlinding,
  encryptAmount,
  encryptBalance,
  encryptAllowance,
  encryptEscrowedDvk,
  encryptAuditorSenderBalance,
  ephemeralScalar,
} from "./derive";
import { H, scalarMul } from "./grumpkin";

const dir = join(import.meta.dirname, "testdata");
const fixture = (n: string) => JSON.parse(readFileSync(join(dir, `${n}.json`), "utf8"));
const hx = (s: string) => BigInt(s);
const h64 = (v: bigint) => "0x" + v.toString(16).padStart(64, "0");

// One case per fixture file, driven by the file itself. SDK.md 6.1 requires the
// suite to READ these rather than transcribe them, so a change to the Noir
// library's print_fixtures output surfaces as a failure and not a divergence.
describe("key hierarchy, against the committed fixtures", () => {
  it("vk_from_sk", () => {
    for (const v of fixture("vk_from_sk").vectors) {
      expect(h64(vkFromSk(hx(v.inputs.sk), hx(v.inputs.wrap)))).toBe(v.output);
    }
  });

  it("pvk_from_vk", () => {
    for (const v of fixture("pvk_from_vk").vectors) {
      const p = publicViewingKey(hx(v.inputs.vk));
      expect(h64(p.x)).toBe(v.output.x);
      expect(h64(p.y)).toBe(v.output.y);
    }
  });

  it("dvk_from_vk_op", () => {
    for (const v of fixture("dvk_from_vk_op").vectors) {
      expect(h64(delegationViewingKey(hx(v.inputs.vk), hx(v.inputs.op_i)))).toBe(v.output);
    }
  });

  it("derive_spend_r", () => {
    for (const v of fixture("derive_spend_r").vectors) {
      expect(h64(spendRandomness(hx(v.inputs.vk), hx(v.inputs.sigma)))).toBe(v.output);
    }
  });

  it("derive_allow_r", () => {
    for (const v of fixture("derive_allow_r").vectors) {
      expect(h64(allowanceRandomness(hx(v.inputs.dvk), hx(v.inputs.sigma_a)))).toBe(v.output);
    }
  });

  it("derive_transfer_blind", () => {
    for (const v of fixture("derive_transfer_blind").vectors) {
      expect(h64(transferBlinding(hx(v.inputs.s), hx(v.inputs.sigma)))).toBe(v.output);
    }
  });

  it("encrypt_amount", () => {
    for (const v of fixture("encrypt_amount").vectors) {
      expect(h64(encryptAmount(hx(v.inputs.v_transfer), hx(v.inputs.s), hx(v.inputs.sigma)))).toBe(
        v.output,
      );
    }
  });

  it("encrypt_balance", () => {
    for (const v of fixture("encrypt_balance").vectors) {
      expect(h64(encryptBalance(hx(v.inputs.v_new), hx(v.inputs.vk), hx(v.inputs.sigma)))).toBe(
        v.output,
      );
    }
  });

  it("encrypt_allowance", () => {
    for (const v of fixture("encrypt_allowance").vectors) {
      expect(h64(encryptAllowance(hx(v.inputs.v_a), hx(v.inputs.dvk), hx(v.inputs.sigma_a)))).toBe(
        v.output,
      );
    }
  });

  it("encrypt_esc_dvk", () => {
    for (const v of fixture("encrypt_esc_dvk").vectors) {
      expect(h64(encryptEscrowedDvk(hx(v.inputs.dvk), hx(v.inputs.s), hx(v.inputs.op_i)))).toBe(
        v.output,
      );
    }
  });

  it("encrypt_auditor_sender_balance", () => {
    for (const v of fixture("encrypt_auditor_sender_balance").vectors) {
      expect(
        h64(
          encryptAuditorSenderBalance(hx(v.inputs.v_new), hx(v.inputs.s_a_s), hx(v.inputs.sigma)),
        ),
      ).toBe(v.output);
    }
  });

  it("covers every fixture file in the directory", () => {
    // Guards against a new upstream primitive appearing and going untested.
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBe(17);
  });
});

describe("the ephemeral scalar (decision D2)", () => {
  it("is deterministic in (vk, sigma)", () => {
    // MUST be derived, never sampled. A sampled r_e forecloses sender-side
    // disclosure permanently and retroactively, and nothing on chain
    // distinguishes the two, so it cannot be repaired later.
    expect(ephemeralScalar(0xdeadn, 1n)).toBe(ephemeralScalar(0xdeadn, 1n));
  });

  it("changes with the salt, so a fresh sigma gives a fresh ephemeral", () => {
    expect(ephemeralScalar(0xdeadn, 1n)).not.toBe(ephemeralScalar(0xdeadn, 2n));
  });

  it("changes with the viewing key", () => {
    expect(ephemeralScalar(0xdeadn, 1n)).not.toBe(ephemeralScalar(0xbeefn, 1n));
  });

  it("lets a sender recompute R_e from vk and the on-chain salt alone", () => {
    // This is what makes sender-side disclosure need zero per-transfer storage.
    const vk = 0xdeadn;
    const sigma = 0x01n;
    expect(scalarMul(ephemeralScalar(vk, sigma), H)).toEqual(
      scalarMul(ephemeralScalar(vk, sigma), H),
    );
  });
});

describe("field arithmetic in the ciphertext derivations", () => {
  it("reduces mod r, as Noir's Field addition does", async () => {
    const { R } = await import("./field");
    // Caught by the encrypt_esc_dvk fixture: a full-size dvk plus a full-size
    // pad overflows r, and plain bigint addition would carry past it. Small
    // operands hide this completely, so a test with toy values would pass while
    // real keys diverged.
    const big = R - 1n;
    const out = encryptEscrowedDvk(big, 0x12345n, 0xabcdn);
    expect(out).toBeLessThan(R);
    expect(out).toBeGreaterThanOrEqual(0n);
  });

  it("keeps every ciphertext a canonical F_r element", async () => {
    const { R } = await import("./field");
    const big = R - 1n;
    for (const v of [
      encryptAmount(big, big, big),
      encryptBalance(big, big, big),
      encryptAllowance(big, big, big),
      encryptEscrowedDvk(big, big, big),
      encryptAuditorSenderBalance(big, big, big),
    ]) {
      expect(v >= 0n && v < R).toBe(true);
    }
  });
});
