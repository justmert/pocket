import { describe, it, expect } from "vitest";
import {
  isSenderDisclosable,
  disclosureBinding,
  sealDisclosedAmount,
  openDisclosedAmount,
  DISCLOSURE_LIMITS,
} from "./index";
import { ephemeralScalar, vkFromSk } from "../crypto/derive";
import { scalarMul, H } from "../crypto/grumpkin";
import { DOMAIN } from "../crypto/domain";
import { R } from "../crypto/field";

const VK = vkFromSk(0xdeadn, 0xbeefn);

describe("sender disclosability is established by test", () => {
  it("recognises a transfer whose ephemeral reproduces", () => {
    const sigma = 0x1234n;
    const publishedRe = scalarMul(ephemeralScalar(VK, sigma), H);
    expect(isSenderDisclosable(VK, sigma, publishedRe)).toBe(true);
  });

  it("reports a transfer with a SAMPLED ephemeral as not disclosable", () => {
    // Transfers predating the deterministic-ephemeral rule carry an r_e our
    // derivation cannot reproduce. That is "not disclosable", NOT "verification
    // failed", and nothing on chain marks the difference.
    const sigma = 0x1234n;
    const sampledRe = scalarMul(0x99999999n, H);
    expect(isSenderDisclosable(VK, sigma, sampledRe)).toBe(false);
  });

  it("does not rely on a stored flag", () => {
    // The whole point: a per-transfer flag can be wrong or absent, the
    // derivation cannot. Wrong vk, wrong salt, both correctly rejected.
    const sigma = 0x1234n;
    const re = scalarMul(ephemeralScalar(VK, sigma), H);
    expect(isSenderDisclosable(VK + 1n, sigma, re)).toBe(false);
    expect(isSenderDisclosable(VK, sigma + 1n, re)).toBe(false);
  });
});

describe("recipient and request binding", () => {
  const key = scalarMul(7n, H);

  it("changes with the requester's key", () => {
    const a = disclosureBinding({ recipientKey: key, nonce: 1n });
    const b = disclosureBinding({ recipientKey: scalarMul(8n, H), nonce: 1n });
    expect(a).not.toBe(b);
  });

  it("changes with the nonce, so a proof cannot serve a later request", () => {
    const a = disclosureBinding({ recipientKey: key, nonce: 1n });
    const b = disclosureBinding({ recipientKey: key, nonce: 2n });
    expect(a).not.toBe(b);
  });

  it("binds BOTH coordinates of the requester's key", () => {
    // x-only would be negation-invariant, exactly as with ECDH.
    const neg = { x: key.x, y: (R - key.y) % R };
    expect(disclosureBinding({ recipientKey: key, nonce: 1n })).not.toBe(
      disclosureBinding({ recipientKey: neg, nonce: 1n }),
    );
  });

  it("uses the disclosure-bind tag, not the disclosure tag", () => {
    expect(DOMAIN.DISCLOSURE_BIND).toBe(15n);
    expect(DOMAIN.DISCLOSURE).toBe(16n);
  });
});

describe("sealing the disclosed amount", () => {
  it("round-trips for the intended requester", () => {
    const sealed = sealDisclosedAmount(500n, 0x12345n, 7n);
    expect(openDisclosedAmount(sealed, 0x12345n, 7n)).toBe(500n);
  });

  it("does not open for a different nonce", () => {
    const sealed = sealDisclosedAmount(500n, 0x12345n, 7n);
    expect(openDisclosedAmount(sealed, 0x12345n, 8n)).not.toBe(500n);
  });

  it("does not open for a different shared scalar", () => {
    const sealed = sealDisclosedAmount(500n, 0x12345n, 7n);
    expect(openDisclosedAmount(sealed, 0x54321n, 7n)).not.toBe(500n);
  });

  it("stays within the field", () => {
    const sealed = sealDisclosedAmount(R - 1n, 0x12345n, 7n);
    expect(sealed >= 0n && sealed < R).toBe(true);
  });
});

describe("what we tell the user", () => {
  it("never claims revocability", () => {
    // No revocation mechanism exists anywhere in the specification. Claiming
    // one would be the kind of overclaim that is not recoverable from.
    const all = Object.values(DISCLOSURE_LIMITS).join(" ");
    expect(all).not.toMatch(/revocable(?!\.)/i);
    expect(DISCLOSURE_LIMITS.notRevocable).toMatch(/cannot be revoked/i);
  });

  it("states the single-use, recipient-bound property", () => {
    expect(DISCLOSURE_LIMITS.singleUse).toMatch(/once/i);
    expect(DISCLOSURE_LIMITS.singleUse).toMatch(/one party/i);
  });

  it("admits cherry-picking rather than glossing it", () => {
    // A holder can disclose three payments and withhold a fourth, and the
    // verifier cannot tell. Completeness routes through the auditor.
    expect(DISCLOSURE_LIMITS.cherryPicking).toMatch(/does not prove it was your only one/i);
    expect(DISCLOSURE_LIMITS.cherryPicking).toMatch(/auditor/i);
  });
});
