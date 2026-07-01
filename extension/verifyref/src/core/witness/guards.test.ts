import { describe, it, expect } from "vitest";
import {
  assertFr,
  assertSalt,
  assertAmount,
  assertPoint,
  assertSpendableBlinding,
  UnspendableBlindingError,
  MAX_AMOUNT,
} from "./guards";
import { R, Q } from "../crypto/field";
import { H, IDENTITY, commit } from "../crypto/grumpkin";
import { buildWithdrawWitness } from "./withdraw";
import { buildTransferWitness } from "./transfer";
import { scalarMul } from "../crypto/grumpkin";

describe("boundary validation", () => {
  it("rejects a non-canonical scalar", () => {
    expect(() => assertFr(R, "x")).toThrow(/canonical/);
    expect(() => assertFr(-1n, "x")).toThrow();
    expect(() => assertFr(R - 1n, "x")).not.toThrow();
  });

  it("rejects an amount outside [0, 2^127)", () => {
    expect(() => assertAmount(MAX_AMOUNT, "x")).toThrow(/\[0, 2\^127\)/);
    expect(() => assertAmount(-1n, "x")).toThrow();
    expect(() => assertAmount(MAX_AMOUNT - 1n, "x")).not.toThrow();
  });

  it("rejects the identity and off-curve points", () => {
    expect(() => assertPoint(IDENTITY, "k")).toThrow(/identity/);
    expect(() => assertPoint({ x: 1n, y: 1n }, "k")).toThrow(/not a valid/);
    expect(() => assertPoint(H, "k")).not.toThrow();
  });
});

describe("the unspendable-blinding state (SDK.md 10.7)", () => {
  it("is detected, and named rather than surfaced as a proving failure", () => {
    // A blinding in [r, q) still produces the CORRECT on-chain commitment
    // through our commit (which reduces mod q), so every consistency check
    // passes. The circuit treats it mod r, gets a different point, and cannot
    // satisfy the commitment constraint. Without this check the user sees an
    // opaque proving failure on a state everything else calls healthy.
    const between = R + 1n;
    expect(between < Q).toBe(true);
    expect(() => assertSpendableBlinding(between)).toThrow(UnspendableBlindingError);
    expect(() => assertSpendableBlinding(R - 1n)).not.toThrow();
  });

  it("is NOT what a negative blinding reports, because that one is corruption", () => {
    // A negative blinding is not recoverable by merging: it means local state
    // is wrong. It also survived every other check, because commit() reduces
    // mod q so the on-chain comparison still passed, and it reached the input
    // encoder as "0x00..0-2a".
    expect(() => assertSpendableBlinding(-1n)).toThrow(/corrupt/);
    expect(() => assertSpendableBlinding(-1n)).not.toThrow(UnspendableBlindingError);
    expect(() => assertSpendableBlinding(0n)).not.toThrow();
  });

  it("the builders reject a negative blinding before it reaches the encoder", () => {
    const neg = -42n;
    for (const build of [
      () =>
        buildWithdrawWitness({
          sk: 0xdeadn,
          addrF: 0x1234n,
          spendable: { value: 100n, randomness: neg },
          amount: 10n,
          sigma: 1n,
          auditorKey: scalarMul(7n, H),
          onChainSpendable: commit(100n, neg),
        }),
      () =>
        buildTransferWitness({
          sk: 0xdeadn,
          addrF: 0x1234n,
          spendable: { value: 100n, randomness: neg },
          amount: 10n,
          sigma: 1n,
          recipientPvk: scalarMul(3n, H),
          recipientAuditorKey: scalarMul(7n, H),
          senderAuditorKey: scalarMul(8n, H),
          onChainSpendable: commit(100n, neg),
        }),
    ]) {
      expect(build).toThrow(/corrupt/);
    }
  });

  it("tells the user it is temporary and how it resolves", () => {
    try {
      assertSpendableBlinding(R);
    } catch (e) {
      expect((e as Error).message).toMatch(/not lost/i);
      expect((e as Error).message).toMatch(/next merge/i);
    }
  });

  it("is caught by the withdraw builder", () => {
    expect(() =>
      buildWithdrawWitness({
        sk: 0xdeadn,
        addrF: 0x1234n,
        spendable: { value: 100n, randomness: R + 1n },
        amount: 10n,
        sigma: 1n,
        auditorKey: scalarMul(7n, H),
        onChainSpendable: commit(100n, R + 1n),
      }),
    ).toThrow(UnspendableBlindingError);
  });

  it("is caught by the transfer builder", () => {
    expect(() =>
      buildTransferWitness({
        sk: 0xdeadn,
        addrF: 0x1234n,
        spendable: { value: 100n, randomness: R + 1n },
        amount: 10n,
        sigma: 1n,
        recipientPvk: scalarMul(3n, H),
        recipientAuditorKey: scalarMul(7n, H),
        senderAuditorKey: scalarMul(8n, H),
        onChainSpendable: commit(100n, R + 1n),
      }),
    ).toThrow(UnspendableBlindingError);
  });
});

describe("the salt guard", () => {
  const base = {
    sk: 0xdeadn,
    addrF: 0x1234n,
    spendable: { value: 100n, randomness: 5n },
    amount: 10n,
    auditorKey: scalarMul(7n, H),
    onChainSpendable: commit(100n, 5n),
  };

  it("rejects zero, the canonical never-fresh salt", () => {
    expect(() => assertSalt(0n)).toThrow(/sampled fresh/);
    expect(() => assertSalt(R)).toThrow(/canonical/);
    expect(() => assertSalt(-1n)).toThrow(/canonical/);
    expect(() => assertSalt(1n)).not.toThrow();
  });

  it("is applied by both spend builders", () => {
    expect(() => buildWithdrawWitness({ ...base, sigma: 0n })).toThrow(/sampled fresh/);
    expect(() =>
      buildTransferWitness({
        ...base,
        sigma: 0n,
        recipientPvk: scalarMul(3n, H),
        recipientAuditorKey: scalarMul(7n, H),
        senderAuditorKey: scalarMul(8n, H),
      }),
    ).toThrow(/sampled fresh/);
  });
});

describe("builder parity on range checks", () => {
  const base = {
    sk: 0xdeadn,
    addrF: 0x1234n,
    amount: 10n,
    sigma: 1n,
    auditorKey: scalarMul(7n, H),
  };

  it("both builders reject an over-range balance, not just withdraw", () => {
    const spendable = { value: MAX_AMOUNT, randomness: 5n };
    const onChainSpendable = commit(spendable.value, spendable.randomness);
    expect(() => buildWithdrawWitness({ ...base, spendable, onChainSpendable })).toThrow(
      /\[0, 2\^127\)/,
    );
    expect(() =>
      buildTransferWitness({
        ...base,
        spendable,
        onChainSpendable,
        recipientPvk: scalarMul(3n, H),
        recipientAuditorKey: scalarMul(7n, H),
        senderAuditorKey: scalarMul(8n, H),
      }),
    ).toThrow(/\[0, 2\^127\)/);
  });
});
