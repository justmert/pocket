import { describe, it, expect } from "vitest";
import { credit, applyMerge, verifyAgainstChain, balancesOf, ZERO_OPENING } from "./private";
import { commit, IDENTITY } from "./crypto/grumpkin";
import { Q, R, addModQ } from "./crypto/field";

describe("crediting the receiving side", () => {
  it("adds values as exact integers and blindings mod q", () => {
    const out = credit({ value: 100n, randomness: 5n }, { value: 50n, randomness: 7n });
    expect(out.value).toBe(150n);
    expect(out.randomness).toBe(12n);
  });

  it("wraps blindings at q, not at r", () => {
    // Trap #1. Reducing mod r gives an opening off by q - r that no longer
    // opens the on-chain point, and two full-size blindings cross q about half
    // the time.
    const out = credit({ value: 1n, randomness: Q - 5n }, { value: 1n, randomness: 10n });
    expect(out.randomness).toBe(5n);
    expect(out.randomness).not.toBe((Q - 5n + 10n) % R);
  });

  it("does not reduce values by either modulus", () => {
    // Committed values never wrap: they are bounded by the range constraint,
    // not by a field.
    const out = credit({ value: R - 1n, randomness: 0n }, { value: 5n, randomness: 0n });
    expect(out.value).toBe(R + 4n);
  });

  it("stays homomorphic: the credited opening opens the summed commitment", () => {
    const a = { value: 300n, randomness: 111n };
    const b = { value: 200n, randomness: 222n };
    const sum = credit(a, b);
    expect(commit(sum.value, sum.randomness)).toEqual(
      commit(a.value + b.value, addModQ(a.randomness, b.randomness)),
    );
  });
});

describe("merge", () => {
  it("folds receiving into spendable and zeroes receiving", () => {
    const after = applyMerge({
      spendable: { value: 100n, randomness: 5n },
      receiving: { value: 40n, randomness: 9n },
    });
    expect(after.spendable).toEqual({ value: 140n, randomness: 14n });
    expect(after.receiving).toEqual(ZERO_OPENING);
  });

  it("is idempotent on an empty receiving side", () => {
    const s = { spendable: { value: 100n, randomness: 5n }, receiving: ZERO_OPENING };
    expect(applyMerge(s)).toEqual(s);
  });
});

describe("consistency check against the chain", () => {
  const spendable = { value: 500n, randomness: 42n };
  const receiving = { value: 30n, randomness: 7n };
  const onChain = {
    spendableCommitment: commit(spendable.value, spendable.randomness),
    receivingCommitment: commit(receiving.value, receiving.randomness),
  };

  it("passes when local state matches", () => {
    expect(verifyAgainstChain({ spendable, receiving }, onChain)).toEqual({ ok: true });
  });

  it("names WHICH accumulator diverged", () => {
    // Knowing which one narrows the cause: spendable diverging means a missed
    // checkpoint, receiving means a missed or duplicated credit.
    expect(
      verifyAgainstChain({ spendable: { value: 499n, randomness: 42n }, receiving }, onChain),
    ).toEqual({ ok: false, which: "spendable" });
    expect(
      verifyAgainstChain({ spendable, receiving: { value: 31n, randomness: 7n } }, onChain),
    ).toEqual({ ok: false, which: "receiving" });
  });

  it("catches a duplicate credit, which inflates a balance", () => {
    const doubled = credit(receiving, receiving);
    expect(verifyAgainstChain({ spendable, receiving: doubled }, onChain).ok).toBe(false);
  });

  it("treats a zero opening as the identity, which is what a fresh account holds", () => {
    expect(
      verifyAgainstChain(
        { spendable: ZERO_OPENING, receiving: ZERO_OPENING },
        { spendableCommitment: IDENTITY, receivingCommitment: IDENTITY },
      ),
    ).toEqual({ ok: true });
  });
});

describe("what the UI is told", () => {
  it("reports spendable and receiving separately", () => {
    // Hiding the distinction produces "why can't I send my own money" tickets:
    // a deposit lands in receiving and needs a merge before it can be sent.
    const b = balancesOf({
      kind: "ready",
      spendable: { value: 100n, randomness: 1n },
      receiving: { value: 40n, randomness: 2n },
      auditorId: 0,
      syncedThrough: 1,
    });
    expect(b).toEqual({ spendable: 100n, receiving: 40n, mergeAvailable: true });
  });

  it("reports no balances at all for a diverged state", () => {
    // A diverged wallet must show an error, not a plausible number.
    expect(balancesOf({ kind: "diverged", which: "spendable", syncedThrough: 5 })).toBeNull();
  });

  it("reports no balances for an unregistered account", () => {
    expect(balancesOf({ kind: "unregistered" })).toBeNull();
  });
});
