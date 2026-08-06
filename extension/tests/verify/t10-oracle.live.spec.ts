import { test, expect } from "@playwright/test";
import { launchWallet } from "../support/extension";
import { Wallet } from "../support/wallet";
import * as ledger from "../support/testnet";
import {
  IDENTITY,
  chainAccount,
  commit,
  commitmentOf,
  openOpenings,
  openingKeyFor,
  openingsOpenTheChain,
  samePoint,
  storage,
  unwrapDek,
  type Sealed,
  type StoredOpenings,
  type VaultHeader,
} from "../integrity/oracle";

// Adversarial verification of T10's oracle. NOT a second copy of T10.
//
// T10's whole subject is whether the bytes on disk are what the screen claims,
// and the instrument it uses is `openingsOpenTheChain`. That instrument has the
// failure mode this pass has now produced four separate times, every one caught
// by somebody other than the author: an assertion that is true by construction.
// An oracle that always answers "ok" proves nothing, and it looks identical to
// one that works, because the wallet under test is mostly correct.
//
// So this file does not check the wallet. It checks the INSTRUMENT, by three
// routes:
//
//   1. On a real blinded balance, does it say ok? That exercises the Grumpkin
//      arithmetic for real rather than comparing the identity to itself.
//   2. Perturbed by the smallest possible amount, does it say NOT ok? An oracle
//      that cannot say no is not an oracle.
//   3. Is the thing it compares against actually the CONTRACT's number? A
//      commitment that came back as the identity, or from the wallet, would
//      make (1) meaningless.
//
// Nothing under tests/integrity/** is modified by this file. It imports the
// oracle read-only, which is the point: the instrument is the subject.
test.describe.configure({ mode: "default" });

const PASSWORD = "a-strong-password";

async function shieldedWallet() {
  const h = await launchWallet();
  const w = new Wallet(h.popup);
  await w.createWallet(PASSWORD);
  const address = await w.revealAddress();
  await ledger.fund(address);
  await w.reopen();
  await w.waitForHome();
  await w.openPrivatePocket();
  await w.registerPrivatePocket();
  await w.openOp("Shield");
  await w.submitOp({ amount: "25" });
  await w.approve();
  await expect(h.popup.getByText("Success")).toBeVisible({ timeout: 300_000 });
  return { h, w, address };
}

/** Read the sealed openings the way T10's oracle does. */
async function storedOpenings(
  h: Awaited<ReturnType<typeof launchWallet>>,
  address: string,
): Promise<StoredOpenings> {
  const all = await storage(h.popup);
  const header = all["pocket.vault"] as VaultHeader;
  const sealed = all[openingKeyFor(address)] as Sealed;
  expect(sealed, "the account must have sealed openings on disk").toBeTruthy();
  const dek = await unwrapDek(header, PASSWORD);
  return openOpenings(dek, sealed);
}

test("the T10 oracle answers yes on a real blinded balance and no to every perturbation of it", async () => {
  test.setTimeout(900_000);
  const { h, address } = await shieldedWallet();
  try {
    const stored = await storedOpenings(h, address);
    const chain = await chainAccount(address);
    expect(chain, "the contract must report a confidential account").toBeTruthy();

    // (3) first, because it is what makes (1) mean anything. A fresh account's
    // commitments are BOTH the identity, and identity-equals-identity passes
    // without touching the curve at all. After a 25 XLM shield the spendable
    // accumulator is a real point, so the comparison below is a real one.
    expect(
      samePoint(chain!.spendableCommitment, IDENTITY),
      "after a shield the contract must hold a non-identity accumulator, or this " +
        "test is comparing the identity with itself and proves nothing",
    ).toBe(false);
    expect(stored.spendable.value + stored.receiving.value).toBe(250_000_000n);

    // A shield-only balance carries randomness ZERO, and that is correct, not a
    // leak: a deposit is a public transfer into the wrapper, the wallet says so
    // on the screen where you approve it ("This amount is public"), and an
    // observer can already compute the balance by summing public flows. What it
    // means for the INSTRUMENT is the point here: `commit(v, 0)` is
    // `v*G + 0*H`, and `scalarMul(0, H)` short-circuits, so the second
    // generator is never touched. A shield-only check validates half the curve
    // code. See the H-generator test below, which is the other half.
    expect(stored.spendable.randomness).toBe(0n);

    // (1) The instrument agreeing with reality. This is also the only fully
    // independent check that the oracle's curve parameters are right: the
    // accumulator was computed by the Rust contract, and reproducing it in
    // TypeScript from (value, randomness) can only work if the moduli, the two
    // generators and the arithmetic are all correct.
    const verdict = openingsOpenTheChain(stored, chain!);
    expect(verdict.ok, verdict.detail).toBe(true);

    // (2) And the half that a broken oracle would fail. One stroop, the
    // smallest change that can be made to a balance.
    const offByOne = openingsOpenTheChain(
      {
        ...stored,
        spendable: { ...stored.spendable, value: stored.spendable.value + 1n },
      },
      chain!,
    );
    expect(offByOne.ok, "one stroop more must not open the contract's accumulator").toBe(false);
    expect(offByOne.which).toBe("spendable");

    // The blinding term alone, with the amount untouched. An oracle that only
    // compared amounts would pass this and be worthless: the randomness is what
    // makes the commitment hiding, and a wrong one is just as unspendable.
    const wrongBlinding = openingsOpenTheChain(
      {
        ...stored,
        spendable: { ...stored.spendable, randomness: stored.spendable.randomness + 1n },
      },
      chain!,
    );
    expect(wrongBlinding.ok, "a wrong blinding must not open the accumulator").toBe(false);

    // And the receiving side is genuinely checked too, not just the first one
    // that happens to match.
    const wrongReceiving = openingsOpenTheChain(
      { ...stored, receiving: { value: 1n, randomness: 1n } },
      chain!,
    );
    expect(wrongReceiving.ok).toBe(false);
    expect(
      wrongReceiving.which,
      "the receiving side must be checked, not short-circuited by a matching spendable",
    ).toBe("receiving");
  } finally {
    await h.close();
  }
});

test("the oracle's commitment is the contract's, not a restatement of the wallet's", async () => {
  test.setTimeout(900_000);
  const { h, address } = await shieldedWallet();
  try {
    const stored = await storedOpenings(h, address);
    const chain = await chainAccount(address);

    // Recomputed here from the raw scalars, with no reference to the verdict
    // helper, and compared to the point the CONTRACT returned. If the oracle
    // were echoing something the wallet computed, this equality would hold for
    // a wrong opening too, which the previous test rules out.
    const recomputed = commit(stored.spendable.value, stored.spendable.randomness);
    expect(
      samePoint(recomputed, chain!.spendableCommitment),
      `recomputing the commitment from the sealed scalars must reproduce the ` +
        `accumulator the contract holds`,
    ).toBe(true);

    // The zero special case is real and worth pinning: a fresh account's
    // accumulator IS the identity, and `commitmentOf` short-circuits to it. If
    // that ever stopped agreeing with 0*G + 0*H the oracle would start passing
    // empty accounts for the wrong reason.
    expect(samePoint(commitmentOf({ value: 0n, randomness: 0n }), IDENTITY)).toBe(true);
    expect(samePoint(commit(0n, 0n), IDENTITY)).toBe(true);

    // A non-zero value with zero randomness must NOT be the identity, or the
    // curve code is collapsing everything to a constant.
    expect(samePoint(commit(1n, 0n), IDENTITY)).toBe(false);
    expect(samePoint(commit(0n, 1n), IDENTITY)).toBe(false);
    expect(samePoint(commit(1n, 0n), commit(0n, 1n))).toBe(false);
  } finally {
    await h.close();
  }
});

test("the oracle's second generator is exercised, not short-circuited past", async () => {
  test.setTimeout(900_000);
  const { h, w, address } = await shieldedWallet();
  try {
    // A shield-only balance has randomness zero, so `0*H` short-circuits and
    // the H generator is never used. Everything T10 asserts about a shielded
    // account would therefore hold with a WRONG H baked into the oracle. An
    // unshield re-blinds the remaining spendable with a derived randomness, so
    // from here the commitment genuinely depends on both generators.
    const before = await storedOpenings(h, address);
    expect(before.spendable.randomness, "precondition: the shield leaves it unblinded").toBe(0n);

    await w.openOp("Unshield");
    await w.submitOp({ amount: "5" });
    await w.approve();
    await expect(h.popup.getByText("Success")).toBeVisible({ timeout: 300_000 });

    const after = await storedOpenings(h, address);
    const chain = await chainAccount(address);
    expect(after.spendable.value).toBe(200_000_000n);
    expect(
      after.spendable.randomness,
      "a spend must re-blind what is left, or the remaining balance stays a plain " +
        "multiple of G and is readable off the ledger",
    ).not.toBe(0n);

    // The real test of the instrument: reproducing a commitment that depends on
    // BOTH generators, against a point the Rust contract computed. This cannot
    // pass with a wrong H, a wrong modulus, or wrong point addition.
    const verdict = openingsOpenTheChain(after, chain!);
    expect(verdict.ok, verdict.detail).toBe(true);
    expect(
      samePoint(
        commit(after.spendable.value, after.spendable.randomness),
        chain!.spendableCommitment,
      ),
    ).toBe(true);

    // And with the blinding term dropped, the same value must NOT open it.
    // This is the assertion that would have caught a short-circuiting H.
    expect(
      samePoint(commit(after.spendable.value, 0n), chain!.spendableCommitment),
      "the accumulator must depend on the blinding, not only on the amount",
    ).toBe(false);
  } finally {
    await h.close();
  }
});
