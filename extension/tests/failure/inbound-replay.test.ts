// Replaying a payment you RECEIVED.
//
// This is the case the wallet used to refuse outright, and refusing was the
// right call given what it had: the event body carries `r_e_point`, `v_tilde`
// and `sigma`, which are enough to DERIVE a candidate amount and blinding and
// nothing at all to CHECK them with. Nothing on chain marks an event as yours,
// and a wrong viewing key produces a plausible field element rather than an
// error, so crediting the candidate would mean inventing a balance.
//
// The check is `commit(v, r) == c_transfer`. `c_transfer` was never missing; it
// simply rides in the transaction's invocation rather than in the event, and the
// archive was storing only events. Now it stores the invocation payload too, so
// a received payment is fully verifiable and the wallet credits it.
//
// The consequence of getting this wrong is not cosmetic. Openings are the only
// thing that makes an on-chain commitment spendable, so a user who had ever been
// paid privately and then lost local state could not recover the money, ever.
import { describe, it, expect } from "vitest";
import {
  replay,
  INITIAL_STATE,
  UnreplayableEventError,
  type ConfidentialEvent,
} from "../../src/core/sync";
import { commit, scalarMul, H, equals, type Point } from "../../src/core/crypto/grumpkin";
import {
  ephemeralScalar,
  sharedScalar,
  transferBlinding,
  encryptAmount,
  publicViewingKey,
} from "../../src/core/crypto/derive";
import { toBytesBE, Q } from "../../src/core/crypto/field";
import { LIVE_TRANSFER_VALUE_B64 } from "./_fixtures/live-transfer-event";

const ME = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";
const SENDER = "GAKQO2Y5RPBKAVG2PBMLCSG2TFGTED6ERGPOVTOIV54WWC5TRLCZEY6T";

/** Our viewing key, and the sender's ephemeral secret, for one transfer. */
const MY_VK = 0x2b7e151628aed2a6abf7158809cf4f3cn;
const SIGMA = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f0n;

/**
 * A transfer TO us, built the way the sending wallet builds one.
 *
 * The encryption side, from `buildTransferWitness`: derive the ephemeral from
 * the SENDER's vk and sigma, ECDH against the recipient's public viewing key,
 * and commit the amount under the blinding both sides can derive. This is the
 * protocol, not a fixture shaped to satisfy the decoder.
 */
function inboundTransfer(
  amount: bigint,
  opts: { toMe?: boolean; senderVk?: bigint; ledger?: number } = {},
): ConfidentialEvent {
  const senderVk = opts.senderVk ?? 0x1234567890abcdefn;
  const rE = ephemeralScalar(senderVk, SIGMA);
  const RE = scalarMul(rE, H);
  // ECDH to the RECIPIENT's public viewing key. A transfer meant for somebody
  // else is exactly this with a different pvk, which is the third test below.
  const recipientPvk = publicViewingKey(opts.toMe === false ? 0xdeadbeefn : MY_VK);
  const s = sharedScalar(rE, recipientPvk);
  const rTransfer = transferBlinding(s, SIGMA);
  const cTransfer = commit(amount, rTransfer);
  const vTilde = encryptAmount(amount, s, SIGMA);

  return {
    id: `${opts.ledger ?? 100}-0-0`,
    type: "transfer",
    ledger: opts.ledger ?? 100,
    txApplicationOrder: 0,
    eventIndex: 0,
    topics: [SENDER, ME],
    data: {
      r_e_point: pointBytes(RE),
      v_tilde: toBytesBE(vTilde),
      sigma: toBytesBE(SIGMA),
      // The contract publishes these too; the recipient's path reads none of
      // them, and they are here so the fixture is the shape of a real event.
      b_tilde: toBytesBE(0n),
      v_tilde_aud_r: toBytesBE(0n),
      r_tilde_aud_r: toBytesBE(0n),
      v_tilde_aud_s: toBytesBE(0n),
      b_tilde_aud_s: toBytesBE(0n),
    },
    payload: { cTransfer },
  };
}

/** 64-byte uncompressed encoding, as the contract publishes points. */
function pointBytes(p: Point): Uint8Array {
  const out = new Uint8Array(64);
  // Coordinates live in the BASE field, so they encode under Q rather than the
  // scalar field R that toBytesBE defaults to.
  out.set(toBytesBE(p.x, Q), 0);
  out.set(toBytesBE(p.y, Q), 32);
  return out;
}

const keys = { vk: MY_VK, address: ME };

describe("a received payment replays when the archive supplies the invocation", () => {
  it("credits the amount that was actually sent", async () => {
    const e = inboundTransfer(42_500_000n);
    const out = replay(INITIAL_STATE, [e], keys);
    expect(out.receiving.value).toBe(42_500_000n);
    // And the opening it produced must actually open the published commitment,
    // or it is a number that cannot be spent.
    expect(
      equals(commit(out.receiving.value, out.receiving.randomness), e.payload!.cTransfer),
    ).toBe(true);
  });

  it("accumulates several, in order", async () => {
    const events = [
      inboundTransfer(1_000_000n, { ledger: 100 }),
      inboundTransfer(2_500_000n, { ledger: 200 }),
      inboundTransfer(3_000_000n, { ledger: 300 }),
    ];
    expect(replay(INITIAL_STATE, events, keys).receiving.value).toBe(6_500_000n);
  });

  it("REFUSES the identical event when the payload is absent", async () => {
    // The old behaviour, and still the behaviour against an archive that has
    // not stored payloads. Same bytes, same everything, minus the one field
    // that makes the amount checkable.
    const e = { ...inboundTransfer(42_500_000n), payload: undefined };
    expect(() => replay(INITIAL_STATE, [e], keys)).toThrow(UnreplayableEventError);
  });

  it("REFUSES a transfer that was meant for somebody else", async () => {
    // Encrypted to a different viewing key. Our derivation still produces a
    // candidate amount, because it always does; `c_transfer` is what tells us
    // the candidate is fiction.
    const e = inboundTransfer(42_500_000n, { toMe: false });
    expect(() => replay(INITIAL_STATE, [e], keys)).toThrow(UnreplayableEventError);
  });

  it("REFUSES a payload whose commitment has been swapped", async () => {
    // A hostile archive's best move: serve the real event with a c_transfer
    // that opens to a bigger number. It cannot, because it does not know the
    // blinding, and the check catches the substitution.
    const e = inboundTransfer(1_000_000n);
    const tampered = { ...e, payload: { cTransfer: commit(999_000_000n, 7n) } };
    expect(() => replay(INITIAL_STATE, [tampered], keys)).toThrow(UnreplayableEventError);
  });

  it("REFUSES a payload whose commitment is off the curve", async () => {
    const e = inboundTransfer(1_000_000n);
    const bogus = { ...e, payload: { cTransfer: { x: 1n, y: 1n } as Point } };
    expect(() => replay(INITIAL_STATE, [bogus], keys)).toThrow(UnreplayableEventError);
  });

  it("still refuses when the event body itself is malformed", async () => {
    // The payload does not excuse a broken event: r_e_point still has to be a
    // real curve point, because it reaches scalar multiplication.
    const e = inboundTransfer(1_000_000n);
    const broken = { ...e, data: { ...e.data, r_e_point: new Uint8Array(64) } };
    expect(() => replay(INITIAL_STATE, [broken], keys)).toThrow();
  });
});

/**
 * The same payment, arriving through `confidential_transfer_from`.
 *
 * A delegated spender moves someone else's balance to a recipient. Only the
 * recipient's side is modelled here, because that is the side that was wedged.
 *
 * Built with `sigma_a` exactly where `sigma` goes above, which is not a guess:
 * the two circuits derive the recipient's opening with the same two lines and
 * the same domain tags,
 *
 *   transfer         T7/T9  Poseidon2(delta_transfer_blind|amount, s, sigma)
 *   spender_transfer O7/O9  Poseidon2(delta_transfer_blind|amount, s, sigma_a)
 *
 * (circuits/transfer/src/main.nr:42,48 and spender_transfer/src/main.nr:38,44)
 */
function inboundSpenderTransfer(amount: bigint, opts: { ledger?: number } = {}): ConfidentialEvent {
  const spenderVk = 0x1234567890abcdefn;
  const rE = ephemeralScalar(spenderVk, SIGMA);
  const RE = scalarMul(rE, H);
  const s = sharedScalar(rE, publicViewingKey(MY_VK));
  const rTransfer = transferBlinding(s, SIGMA);
  return {
    id: `${opts.ledger ?? 200}-0-0`,
    type: "spender_transfer",
    ledger: opts.ledger ?? 200,
    txApplicationOrder: 0,
    eventIndex: 0,
    // FOUR topics: the spender is first, so the recipient is third.
    topics: [SENDER, SENDER, ME],
    data: {
      r_e_point: pointBytes(RE),
      v_tilde: toBytesBE(encryptAmount(amount, s, SIGMA)),
      // Named sigma_a here, and there is no b_tilde on this event at all.
      sigma_a: toBytesBE(SIGMA),
      v_tilde_aud_r: toBytesBE(0n),
      r_tilde_aud_r: toBytesBE(0n),
      v_tilde_aud_s: toBytesBE(0n),
      a_tilde_aud_s: toBytesBE(0n),
    },
    payload: { cTransfer: commit(amount, rTransfer) },
  };
}

describe("a spender_transfer credited to us replays too", () => {
  // The permanent strand. `confidential_transfer_from` calls
  // `add_to_receiving(e, to, ...)` (storage.rs:828) and every require_auth in
  // the module is on the ACTING principal, so a stranger holding any delegation
  // moves the accumulator of any registered account they pick. The live scan
  // did not ask for the event and this replay threw on sight of it, so the
  // pocket read `diverged` and refused every spend, with the documented way out
  // refusing as well. The circuit puts no lower bound on the amount either, so
  // the whole thing cost one transaction fee.
  it("credits the amount, and the opening opens the published commitment", () => {
    const e = inboundSpenderTransfer(7_250_000n);
    const out = replay(INITIAL_STATE, [e], keys);
    expect(out.receiving.value).toBe(7_250_000n);
    expect(
      equals(commit(out.receiving.value, out.receiving.randomness), e.payload!.cTransfer),
      "the credited opening does not open the commitment the contract holds",
    ).toBe(true);
  });

  it("credits a ZERO-value one, which is the cheapest way to wedge a pocket", () => {
    // spender_transfer/src/main.nr:248 bounds the amount above and never below,
    // so v_transfer = 0 is a valid proof. C_transfer is still a real point
    // (r_transfer * H for a hash-derived r), so the accumulator still moves and
    // the pocket still diverges if this is not replayed.
    const e = inboundSpenderTransfer(0n);
    const out = replay(INITIAL_STATE, [e], keys);
    expect(out.receiving.value).toBe(0n);
    expect(equals(commit(0n, out.receiving.randomness), e.payload!.cTransfer)).toBe(true);
  });

  it("still refuses one whose payload does not open", () => {
    // The control. Without it every assertion above is satisfied by a branch
    // that credits whatever it derives, which is the invented-balance failure
    // the refusal existed to prevent.
    const e = inboundSpenderTransfer(7_250_000n);
    const tampered = { ...e, payload: { cTransfer: commit(999_000_000n, 7n) } };
    expect(() => replay(INITIAL_STATE, [tampered], keys)).toThrow(UnreplayableEventError);
  });

  it("still refuses one the archive stored without its invocation", () => {
    const e = { ...inboundSpenderTransfer(7_250_000n), payload: undefined };
    expect(() => replay(INITIAL_STATE, [e], keys)).toThrow(UnreplayableEventError);
  });

  it("leaves one addressed to somebody else alone", () => {
    const e = inboundSpenderTransfer(7_250_000n);
    const theirs = { ...e, topics: [SENDER, SENDER, "GA".padEnd(56, "X")] };
    expect(replay(INITIAL_STATE, [theirs], keys).receiving.value).toBe(0n);
  });
});

describe("the real event from the deployed contract", () => {
  it("publishes no commitment, which is the whole reason for the payload", async () => {
    // Captured off testnet, not written here. If a future contract version
    // starts publishing c_transfer in the event, this test goes red and the
    // payload plumbing can be deleted.
    const { xdr, scValToNative } = await import("@stellar/stellar-sdk/base");
    const body = scValToNative(xdr.ScVal.fromXDR(LIVE_TRANSFER_VALUE_B64, "base64")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(body).sort()).toEqual([
      "b_tilde",
      "b_tilde_aud_s",
      "r_e_point",
      "r_tilde_aud_r",
      "sigma",
      "v_tilde",
      "v_tilde_aud_r",
      "v_tilde_aud_s",
    ]);
    expect(body).not.toHaveProperty("c_transfer");
  });
});
