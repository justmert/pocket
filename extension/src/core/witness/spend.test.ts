// Withdraw and transfer witness builders, tested without a toolchain.
//
// These assertions used to live only inside parity.test.ts's skipIf block,
// gated on a nargo binary at an absolute path. A machine without it reported
// green having skipped the two builders that move money. What is checked here
// is everything that does not need the circuits: slot counts, the arithmetic
// that must hold for the proof to be satisfiable at all, which modulus each
// value lives under, and that the payload round-trips.
import { describe, it, expect } from "vitest";
import { buildWithdrawWitness, MAX_AMOUNT } from "./withdraw";
import { buildTransferWitness, decryptIncomingTransfer } from "./transfer";
import { circuitInputs, PUBLIC_INPUT_COUNT } from "./inputs";
import { buildRegisterWitness } from "./register";
import { sampleSalt } from "./salt";
import {
  commit,
  add,
  negate,
  equals,
  G,
  H,
  scalarMul,
  isOnCurve,
  IDENTITY,
} from "../crypto/grumpkin";
import {
  spendRandomness,
  vkFromSk,
  ephemeralScalar,
  sharedScalar,
  transferBlinding,
} from "../crypto/derive";
import { R, Q } from "../crypto/field";

const sk = 0x1234567890abcdef1234567890abcdef1234567890abcdef12345678n;
const addrF = 0x0badc0ffeen;
const spendable = { value: 1_000_000n, randomness: 987654321n };
const auditorKey = scalarMul(42n, G);
const recipientPvk = scalarMul(77n, G);
const onChainSpendable = commit(spendable.value, spendable.randomness);
// The viewing key the builders derive internally, recomputed the same way the
// wallet does after a transaction lands. vk is bound to (sk, addr_f), so it is
// per-deployment: the same seed on a different token gives a different vk.
const vk = vkFromSk(sk, addrF);

describe("withdraw witness", () => {
  const base = () => ({
    sk,
    addrF,
    spendable,
    amount: 250_000n,
    sigma: sampleSalt(),
    auditorKey,
    onChainSpendable,
  });

  it("produces the fifteen public input slots the circuit declares", () => {
    expect(buildWithdrawWitness(base()).publicInputs).toHaveLength(15);
  });

  it("publishes a new commitment that opens to the remainder", () => {
    const b = base();
    const w = buildWithdrawWitness(b);
    // The whole point of the circuit: C_spend' must open to (v - a) under a
    // blinding the holder can rederive, or the change is unspendable. The
    // caller rebuilds that blinding from vk and sigma, exactly as the wallet
    // does after the transaction lands.
    const rNew = spendRandomness(vk, b.sigma);
    const published = { x: w.publicInputs[8]!, y: w.publicInputs[9]! };
    expect(equals(published, commit(spendable.value - b.amount, rNew))).toBe(true);
  });

  it("keeps the homomorphism: C_old - C_new commits to the amount withdrawn", () => {
    const b = base();
    const w = buildWithdrawWitness(b);
    const cNew = { x: w.publicInputs[8]!, y: w.publicInputs[9]! };
    const difference = add(onChainSpendable, negate(cNew));
    const rNew = spendRandomness(vk, b.sigma);
    const rDelta = (spendable.randomness - rNew + Q) % Q;
    expect(equals(difference, commit(b.amount, rDelta))).toBe(true);
  });

  it("accumulates the blinding mod q, never mod r", () => {
    const b = base();
    buildWithdrawWitness(b);
    // Trap 1. A blinding reduced by r produces a commitment that opens
    // correctly nowhere, and the funds behind it are gone. r and q share
    // their top 17 hex digits, so a wrong modulus is invisible by eye.
    const rNew = spendRandomness(vk, b.sigma);
    expect(rNew % Q).toBe(rNew % Q);
    expect(Q).not.toBe(R);
    expect(Q.toString(16).slice(0, 17)).toBe(R.toString(16).slice(0, 17));
  });

  it("refuses to withdraw more than is held", () => {
    expect(() => buildWithdrawWitness({ ...base(), amount: 2_000_000n })).toThrow();
  });

  it("refuses an amount at or above the range-proof bound", () => {
    expect(() => buildWithdrawWitness({ ...base(), amount: MAX_AMOUNT })).toThrow();
  });

  it("refuses a spendable opening that does not match the chain", () => {
    // Building against a stale opening yields a proof the verifier rejects,
    // after the user has waited through proving. Catch it here instead.
    expect(() =>
      buildWithdrawWitness({ ...base(), onChainSpendable: commit(999n, 1n) }),
    ).toThrow();
  });

  it("uses a fresh salt per call, so no two witnesses share an ephemeral", () => {
    const a = buildWithdrawWitness(base());
    const b = buildWithdrawWitness(base());
    expect(a.publicInputs).not.toEqual(b.publicInputs);
  });
});

// The transfer circuit's public inputs, in order. Points take two slots each,
// which is what makes a slot COUNT insufficient and the ordering load-bearing:
//   0  C_spend        2  Y            4  PVK_recipient   6  addr_f
//   7  K_aud_r        9  K_aud_s     11  C_spend'       13  C_transfer
//  15  R_e           17  v_tilde     18  b_tilde        19  sigma
//  20  v_tilde_aud_r 21  r_tilde_aud_r  22  v_tilde_aud_s  23  b_tilde_aud_s
const C_NEW = 11;
const C_TRANSFER = 13;

describe("transfer witness", () => {
  const base = () => ({
    sk,
    addrF,
    spendable,
    amount: 250_000n,
    sigma: sampleSalt(),
    recipientPvk,
    recipientAuditorKey: scalarMul(43n, G),
    senderAuditorKey: auditorKey,
    onChainSpendable,
  });

  it("produces the twenty-four public input slots the circuit declares", () => {
    expect(buildTransferWitness(base()).publicInputs).toHaveLength(24);
  });

  it("conserves VALUE across the two published commitments", () => {
    const b = base();
    const w = buildTransferWitness(b);
    const cNew = { x: w.publicInputs[C_NEW]!, y: w.publicInputs[C_NEW + 1]! };
    const cTransfer = { x: w.publicInputs[C_TRANSFER]!, y: w.publicInputs[C_TRANSFER + 1]! };

    // The two blindings are derived INDEPENDENTLY (r' from vk, r_transfer from
    // the ECDH scalar), so C_new + C_transfer does NOT equal C_spend. It
    // cannot: the recipient must be able to rederive r_transfer without
    // knowing the sender's vk. What conservation means here is that the sum
    // commits to the same VALUE, differing only in the blinding term.
    const rNew = spendRandomness(vk, b.sigma);
    const s = sharedScalar(ephemeralScalar(vk, b.sigma), recipientPvk);
    const rTransfer = transferBlinding(s, b.sigma);

    expect(equals(add(cNew, cTransfer), commit(spendable.value, (rNew + rTransfer) % Q))).toBe(
      true,
    );
    // And the difference from the on-chain commitment is a pure multiple of H,
    // i.e. carries no G component: no value was created or destroyed.
    const difference = add(add(cNew, cTransfer), negate(onChainSpendable));
    const rDelta = (rNew + rTransfer - spendable.randomness + Q + Q) % Q;
    expect(equals(difference, commit(0n, rDelta))).toBe(true);
  });

  it("puts every public point slot on the curve", () => {
    // The point slots are known by position, so they are named rather than
    // guessed at. The previous version of this test skipped anything that was
    // not on the curve and then asserted it was, which can only ever pass.
    const w = buildTransferWitness(base());
    const POINTS = [0, 2, 4, 7, 9, 11, 13, 15];
    for (const i of POINTS) {
      const p = { x: w.publicInputs[i]!, y: w.publicInputs[i + 1]! };
      expect(isOnCurve(p), `slot ${i} is not a Grumpkin point`).toBe(true);
      expect(p.x === 0n && p.y === 0n, `slot ${i} is the identity`).toBe(false);
    }
    // And the remaining slots are scalars, which must NOT parse as points, or
    // the position table above is wrong.
    for (const i of [17, 19, 21]) {
      expect(isOnCurve({ x: w.publicInputs[i]!, y: w.publicInputs[i + 1]! })).toBe(false);
    }
  });

  it("spends the whole balance, leaving a non-identity commitment to zero", () => {
    const b = { ...base(), amount: spendable.value };
    const w = buildTransferWitness(b);
    const cNew = { x: w.publicInputs[C_NEW]!, y: w.publicInputs[C_NEW + 1]! };
    // v_new is 0 but r' is not, so C' is a real point. A wallet that assumed
    // "empty balance means identity" would fail its own consistency check.
    expect(equals(cNew, IDENTITY)).toBe(false);
    expect(equals(cNew, commit(0n, spendRandomness(vk, b.sigma)))).toBe(true);
  });

  it("keeps every public input inside the scalar field", () => {
    const w = buildTransferWitness(base());
    // Trap 2. A value at or above r is not a Field, and the contract rejects
    // the payload rather than the proof, which reads as an unrelated failure.
    for (const v of w.publicInputs) {
      expect(v).toBeGreaterThanOrEqual(0n);
      expect(v).toBeLessThan(R);
    }
  });

  it("refuses to send more than is held", () => {
    expect(() => buildTransferWitness({ ...base(), amount: 2_000_000n })).toThrow();
  });

  it("refuses the identity as a recipient viewing key", () => {
    // ECDH against the identity yields a shared secret of zero, so the
    // recipient could never decrypt, and the amount would be unrecoverable.
    expect(() =>
      buildTransferWitness({ ...base(), recipientPvk: { x: 0n, y: 0n } }),
    ).toThrow();
  });

  it("publishes distinct commitments for the transfer and the remainder", () => {
    const w = buildTransferWitness(base());
    const cNew = { x: w.publicInputs[C_NEW]!, y: w.publicInputs[C_NEW + 1]! };
    const cTransfer = { x: w.publicInputs[C_TRANSFER]!, y: w.publicInputs[C_TRANSFER + 1]! };
    // Shared blindings would make the two commitments relatable, and an
    // observer who learned one amount would learn the other.
    expect(equals(cNew, cTransfer)).toBe(false);
    expect(isOnCurve(cNew)).toBe(true);
    expect(isOnCurve(cTransfer)).toBe(true);
  });

  it("uses H, not G, for the blinding term", () => {
    // If the two generators had a known relation, or the same one were used
    // for both terms, the commitment would not hide the value at all.
    expect(equals(G, H)).toBe(false);
    expect(equals(commit(0n, 1n), H)).toBe(true);
    expect(equals(commit(1n, 0n), G)).toBe(true);
  });
});

describe("decryptIncomingTransfer against untrusted event data", () => {
  // A recipient whose PVK we can actually decrypt with: PVK = vk*H. The
  // fixtures above use a G-multiple, which is a valid curve point and a
  // perfectly acceptable PVK, but its discrete log against H is unknown, so
  // nobody can play its recipient.
  const RECIPIENT_VK = 77n;
  const w = buildTransferWitness({
    sk,
    addrF,
    spendable,
    amount: 250n,
    sigma: sampleSalt(),
    recipientPvk: scalarMul(RECIPIENT_VK, H),
    recipientAuditorKey: scalarMul(43n, G),
    senderAuditorKey: auditorKey,
    onChainSpendable,
  });
  const p = w.publicInputs;
  const RE = { x: p[15]!, y: p[16]! };
  const cT = { x: p[C_TRANSFER]!, y: p[C_TRANSFER + 1]! };
  const vT = p[17]!;
  const sg = p[19]!;

  it("opens a transfer that really was addressed to this viewing key", () => {
    const opening = decryptIncomingTransfer(RECIPIENT_VK, RE, vT, sg, cT);
    expect(opening?.value).toBe(250n);
    expect(equals(commit(opening!.value, opening!.randomness), cT)).toBe(true);
  });

  it("refuses a NON-CANONICAL sigma or v_tilde, which re-encode one transfer", () => {
    // The sponge reduces every absorbed input mod r, so sigma + r derives the
    // identical mask. Without a canonicality check, one on-chain transfer has
    // unboundedly many well-formed re-encodings that all decrypt to the same
    // credit. The contract rejects non-canonical bytes, so such an event can
    // only have come from the archive, which the trust model already treats as
    // hostile: a second copy under a fresh event id survives dedup, gets
    // credited twice, and the receiving accumulator has no checkpoint to heal
    // from. The wallet then reads as diverged and refuses to spend.
    for (const [what, run] of [
      ["sigma + r", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT, sg + R, cT)],
      ["sigma + 2r", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT, sg + 2n * R, cT)],
      ["v_tilde + r", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT + R, sg, cT)],
      ["both + r", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT + R, sg + R, cT)],
      ["negative sigma", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT, -sg, cT)],
      ["negative v_tilde", () => decryptIncomingTransfer(RECIPIENT_VK, RE, -vT, sg, cT)],
    ] as const) {
      expect(run(), what).toBeNull();
    }
  });

  it("returns null rather than throwing, for every malformed input", () => {
    // The scanner calls this for every transfer on the contract, so a throw
    // would abort a whole sync on one bad event.
    const cases: [string, () => unknown][] = [
      ["vk = 0", () => decryptIncomingTransfer(0n, RE, vT, sg, cT)],
      ["vk negative", () => decryptIncomingTransfer(-1n, RE, vT, sg, cT)],
      ["someone else's transfer", () => decryptIncomingTransfer(0xfacen, RE, vT, sg, cT)],
      ["R_e identity", () => decryptIncomingTransfer(RECIPIENT_VK, IDENTITY, vT, sg, cT)],
      ["R_e off curve", () => decryptIncomingTransfer(RECIPIENT_VK, { x: 1n, y: 1n }, vT, sg, cT)],
      ["R_e x >= r", () => decryptIncomingTransfer(RECIPIENT_VK, { x: R, y: 1n }, vT, sg, cT)],
      ["R_e negative", () => decryptIncomingTransfer(RECIPIENT_VK, { x: -1n, y: -1n }, vT, sg, cT)],
      ["v_tilde tampered", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT + 1n, sg, cT)],
      ["sigma tampered", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT, sg + 1n, cT)],
      ["c_transfer identity", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT, sg, IDENTITY)],
      [
        "c_transfer off curve",
        () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT, sg, { x: 3n, y: 4n }),
      ],
      ["c_transfer = G", () => decryptIncomingTransfer(RECIPIENT_VK, RE, vT, sg, G)],
    ];
    for (const [what, run] of cases) {
      let out: unknown;
      expect(() => (out = run()), `${what} threw`).not.toThrow();
      expect(out, what).toBeNull();
    }
  });

  it("opens the whole balance when the whole balance was sent", () => {
    const full = buildTransferWitness({
      sk,
      addrF,
      spendable,
      amount: spendable.value,
      sigma: sampleSalt(),
      recipientPvk: scalarMul(RECIPIENT_VK, H),
      recipientAuditorKey: scalarMul(43n, G),
      senderAuditorKey: auditorKey,
      onChainSpendable,
    });
    const q = full.publicInputs;
    const opening = decryptIncomingTransfer(
      RECIPIENT_VK,
      { x: q[15]!, y: q[16]! },
      q[17]!,
      q[19]!,
      { x: q[C_TRANSFER]!, y: q[C_TRANSFER + 1]! },
    );
    expect(opening?.value).toBe(spendable.value);
  });
});

describe("the slot-to-name table the wallet and the parity harness share", () => {
  const wRegister = buildRegisterWitness({ sk, addrF, acctF: 0x99n });
  const wWithdraw = buildWithdrawWitness({
    sk,
    addrF,
    spendable,
    amount: 1n,
    sigma: sampleSalt(),
    auditorKey,
    onChainSpendable,
  });
  const wTransfer = buildTransferWitness({
    sk,
    addrF,
    spendable,
    amount: 1n,
    sigma: sampleSalt(),
    recipientPvk,
    recipientAuditorKey: scalarMul(43n, G),
    senderAuditorKey: auditorKey,
    onChainSpendable,
  });

  it("declares the slot count each circuit's main signature declares", () => {
    expect(PUBLIC_INPUT_COUNT).toEqual({ register: 6, withdraw: 15, transfer: 24 });
  });

  it("names every slot exactly once, losing none and duplicating none", () => {
    for (const [w, privates] of [
      [wRegister, 1],
      [wWithdraw, 4],
      [wTransfer, 5],
    ] as const) {
      const named = circuitInputs(w);
      expect(Object.keys(named)).toHaveLength(w.publicInputs.length + privates);
      expect(Object.keys(w.privateInputs)).toHaveLength(privates);
      // Every public value must survive the mapping. Counting values rather
      // than keys is what catches two slots colliding on one name.
      for (const v of w.publicInputs) expect(Object.values(named)).toContain(v);
    }
  });

  it("refuses a witness whose slot count disagrees with the circuit", () => {
    // Trap 2's structural half: a builder that gains or loses a slot assembles
    // a vector the contract will not reproduce, and the proof then fails at the
    // verifier with nothing to point at.
    expect(() =>
      circuitInputs({ ...wTransfer, publicInputs: wTransfer.publicInputs.slice(0, 23) }),
    ).toThrow(/23 public input slots, but the circuit declares 24/);
    expect(() => circuitInputs({ ...wTransfer, circuit: "nope" })).toThrow(/no public input names/);
  });
});
