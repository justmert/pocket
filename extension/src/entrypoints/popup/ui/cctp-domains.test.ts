// Which chains each direction of the bridge offers, and why they differ.
//
// The claim screen imported the SEND screen's chain list, so a Solana-originated
// transfer could not be claimed for a reason that only applies to sending: the
// send form composes a 32-byte `mintRecipient` from an EVM 0x address and has no
// field that takes a base58 one. Nothing about CLAIMING touches the source
// chain's address format at all.
//
// The transaction-id check had the same shape: one hex-only pattern, applied to
// every source chain, silently rejecting every Solana signature typed into it.
import { describe, it, expect } from "vitest";
import { SEND_DOMAINS, CLAIM_DOMAINS, isTxId } from "./screens/CctpSend";
import { CCTP_DOMAIN_NAMES, STELLAR_DOMAIN } from "../../../core/integrations/cctp";

const SOLANA = 5;

describe("the chains each direction offers", () => {
  it("never offers Stellar in either direction, because it is home", () => {
    for (const list of [SEND_DOMAINS, CLAIM_DOMAINS]) {
      expect(list.some((c) => c.domain === STELLAR_DOMAIN)).toBe(false);
    }
  });

  it("can claim FROM Solana", () => {
    expect(CLAIM_DOMAINS.some((c) => c.domain === SOLANA)).toBe(true);
  });

  it("does not offer to send TO Solana, which is the real limitation", () => {
    // Not an oversight: there is no screen that can take a base58 recipient.
    expect(SEND_DOMAINS.some((c) => c.domain === SOLANA)).toBe(false);
  });

  it("offers claims from every chain the worker knows", () => {
    // Sourced from the backend's own table, so the list can never name a chain
    // the worker cannot ask Circle about, and never omit one it can.
    const known = Object.keys(CCTP_DOMAIN_NAMES)
      .map(Number)
      .filter((d) => d !== STELLAR_DOMAIN);
    expect(CLAIM_DOMAINS.map((c) => c.domain).sort((a, b) => a - b)).toEqual(
      known.sort((a, b) => a - b),
    );
  });
});

describe("what counts as a transaction id", () => {
  const HEX = "0x" + "ab".repeat(32);
  const SOL_SIG =
    "5wHu1qwD4kLwYqjWQGiWjkC4XKJ8nDGRhbGmMPCVJHFYUCwSPqRSAWSTVGZTRHtqvNPRZKAAvzmGDpnLbBwPQMcx";

  it("accepts a 32-byte hex hash for an EVM chain", () => {
    expect(isTxId(HEX, 0)).toBe(true);
    expect(isTxId(HEX.slice(2), 0)).toBe(true);
  });

  it("accepts a base58 signature for Solana", () => {
    expect(isTxId(SOL_SIG, SOLANA)).toBe(true);
  });

  it("does not accept a Solana signature as an EVM hash, or the reverse", () => {
    // The rule is per chain, not a union: a hash pasted against the wrong chain
    // is a mistake worth catching before Circle is asked about it.
    expect(isTxId(SOL_SIG, 0)).toBe(false);
    expect(isTxId(HEX, SOLANA)).toBe(false);
  });

  it("falls back to the hex rule when no chain is chosen yet", () => {
    expect(isTxId(HEX, null)).toBe(true);
  });

  it("rejects obvious rubbish on both", () => {
    for (const d of [0, SOLANA, null]) {
      expect(isTxId("", d)).toBe(false);
      expect(isTxId("not a hash", d)).toBe(false);
    }
  });
});
