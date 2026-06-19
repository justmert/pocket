// Crediting a received transfer, and refusing to credit one we cannot verify.
import { describe, it, expect } from "vitest";
import { openInbound, creditInbound, InboundCreditError } from "./inbound";
import { commit, scalarMul, add, H } from "./crypto/grumpkin";
import { sharedScalar, transferBlinding, encryptAmount, ephemeralScalar } from "./crypto/derive";
import { R, Q } from "./crypto/field";
import { MAX_AMOUNT } from "./witness/guards";

// A sender builds a transfer exactly as buildTransferWitness does, so what is
// under test is the RECIPIENT reproducing it from the event alone.
function send(vkRecipient: bigint, amount: bigint, sigma: bigint) {
  const pvk = scalarMul(vkRecipient, H);
  const rE = ephemeralScalar(0x1234n, sigma);
  const RE = scalarMul(rE, H);
  const s = sharedScalar(rE, pvk);
  return {
    RE,
    vTilde: encryptAmount(amount, s, sigma),
    sigma,
    opening: { value: amount, randomness: transferBlinding(s, sigma) },
  };
}

const VK = 0x2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5n;

describe("opening a transfer addressed to us", () => {
  it("recovers the amount and blinding from the event alone", () => {
    const t = send(VK, 250_000n, 0x9f9f9fn);
    const got = openInbound(VK, t.RE, t.vTilde, t.sigma);
    expect(got).not.toBeNull();
    expect(got!.value).toBe(250_000n);
    expect(got!.randomness).toBe(t.opening.randomness);
  });

  it("returns null for a transfer addressed to somebody else", () => {
    // The common case: every transfer on the deployment reaches us.
    const t = send(VK, 250_000n, 0x9f9f9fn);
    const other = openInbound(VK + 1n, t.RE, t.vTilde, t.sigma);
    // Either it does not decrypt at all, or it decrypts to a near-uniform
    // field element that the range bound rejects.
    expect(other === null || other.value >= MAX_AMOUNT).toBe(true);
  });

  it("refuses a non-canonical sigma, which re-encodes one transfer many ways", () => {
    const t = send(VK, 250_000n, 0x9f9f9fn);
    expect(openInbound(VK, t.RE, t.vTilde, t.sigma + R)).toBeNull();
    expect(openInbound(VK, t.RE, t.vTilde + R, t.sigma)).toBeNull();
  });

  it("refuses the identity as an ephemeral point", () => {
    const t = send(VK, 1n, 0x11n);
    expect(openInbound(VK, { x: 0n, y: 0n }, t.vTilde, t.sigma)).toBeNull();
  });
});

describe("crediting against the chain's own accumulator", () => {
  const zero = { value: 0n, randomness: 0n };

  it("credits one transfer when the sum reproduces the commitment", () => {
    const t = send(VK, 500n, 0xa1n);
    const onChain = commit(t.opening.value, t.opening.randomness);
    const got = creditInbound(zero, [{ id: "1", ledger: 1, opening: t.opening }], onChain);
    expect(got.value).toBe(500n);
  });

  it("credits several, in any order, because addition commutes", () => {
    const a = send(VK, 500n, 0xa1n);
    const b = send(VK, 250n, 0xb2n);
    const onChain = add(
      commit(a.opening.value, a.opening.randomness),
      commit(b.opening.value, b.opening.randomness),
    );
    const items = [
      { id: "1", ledger: 1, opening: a.opening },
      { id: "2", ledger: 2, opening: b.opening },
    ];
    expect(creditInbound(zero, items, onChain).value).toBe(750n);
    expect(creditInbound(zero, [...items].reverse(), onChain).value).toBe(750n);
  });

  it("REFUSES a partial set rather than crediting a balance that cannot be spent", () => {
    // The failure this all-or-nothing rule exists for: crediting a subset
    // leaves a balance that looks right and fails at proving time.
    const a = send(VK, 500n, 0xa1n);
    const b = send(VK, 250n, 0xb2n);
    const onChain = add(
      commit(a.opening.value, a.opening.randomness),
      commit(b.opening.value, b.opening.randomness),
    );
    expect(() =>
      creditInbound(zero, [{ id: "1", ledger: 1, opening: a.opening }], onChain),
    ).toThrow(InboundCreditError);
  });

  it("REFUSES a replayed event, because the sum overshoots the chain", () => {
    const a = send(VK, 500n, 0xa1n);
    const onChain = commit(a.opening.value, a.opening.randomness);
    const twice = [
      { id: "1", ledger: 1, opening: a.opening },
      { id: "1-again", ledger: 1, opening: a.opening },
    ];
    expect(() => creditInbound(zero, twice, onChain)).toThrow(InboundCreditError);
  });

  it("accumulates the blinding mod q, never mod r", () => {
    // Trap 1. A blinding reduced by r opens nowhere and the funds are gone.
    const a = { value: 1n, randomness: Q - 1n };
    const b = { value: 1n, randomness: 5n };
    const onChain = add(commit(1n, Q - 1n), commit(1n, 5n));
    const got = creditInbound(
      { value: 0n, randomness: 0n },
      [
        { id: "1", ledger: 1, opening: a },
        { id: "2", ledger: 2, opening: b },
      ],
      onChain,
    );
    expect(got.value).toBe(2n);
    expect(commit(got.value, got.randomness)).toEqual(onChain);
  });
});
