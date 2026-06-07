// The Transfer witness. Circuit type 2, twenty-four public-input slots.
//
// The core constraints (design doc 7.4):
//   T1  Y_A       = sk*H
//   T3  C_spend   = v*G + r*H
//   T4  v, v_transfer, v-v_transfer all in [0, 2^127)
//   T5  s         = ecdh(r_e, PVK_B)          recipient shared scalar
//   T6  R_e       = r_e*H
//   T7  r_transfer = Poseidon2(delta_transfer_blind, s, sigma)
//   T8  C_transfer = v_transfer*G + r_transfer*H
//   T9  v_tilde   = v_transfer + Poseidon2(delta_transfer_amount, s, sigma)
//   T13 r_e != 0
//
// T7 is the ANTI-POISONING constraint and it is the reason the recipient can
// spend what they receive. The blinding is forced to be a function of the ECDH
// secret, so the sender cannot commit with arbitrary randomness the recipient
// is unable to reconstruct. Without it a malicious sender could hand someone a
// commitment they can see but never open.
//
// Two auditor channels, both keyed on the SAME r_e:
//   recipient (delta_aud_r): lane 0 = amount, lane 1 = r_transfer
//   sender    (delta_aud_s): lane 0 = amount, lane 1 = post-transfer balance
// Lane 0 is always an amount and lane 1 is never one. Swapping them produces
// ciphertexts the auditor cannot read, and nothing on chain notices.
import {
  vkFromSk,
  spendingPublicKey,
  spendRandomness,
  encryptBalance,
  encryptAmount,
  transferBlinding,
  ephemeralScalar,
  sharedScalar,
} from "../crypto/derive";
import { spongeSqueeze2 } from "../crypto/poseidon";
import { DOMAIN } from "../crypto/domain";
import { commit, scalarMul, H, equals, type Point } from "../crypto/grumpkin";
import { R } from "../crypto/field";
import { MAX_AMOUNT } from "./withdraw";
import { pointSlots, type Opening, type Witness } from "./types";

const addFr = (a: bigint, b: bigint): bigint => (a + b) % R;

export interface TransferInputs {
  sk: bigint;
  addrF: bigint;
  spendable: Opening;
  amount: bigint;
  sigma: bigint;
  /** The recipient's published public viewing key. They must be registered. */
  recipientPvk: Point;
  /** The RECIPIENT's bound auditor key. */
  recipientAuditorKey: Point;
  /** The SENDER's bound auditor key. */
  senderAuditorKey: Point;
  onChainSpendable: Point;
}

export function buildTransferWitness(input: TransferInputs): Witness {
  const {
    sk,
    addrF,
    spendable,
    amount,
    sigma,
    recipientPvk,
    recipientAuditorKey,
    senderAuditorKey,
    onChainSpendable,
  } = input;

  if (sk <= 0n || sk >= R) throw new Error("sk must be a nonzero canonical F_r element");
  if (amount < 0n || amount >= MAX_AMOUNT) throw new Error("amount is outside [0, 2^127) (T4)");
  if (amount > spendable.value) throw new Error("insufficient spendable balance (T4)");

  const vk = vkFromSk(sk, addrF);
  const Y = spendingPublicKey(sk);

  const cSpend = commit(spendable.value, spendable.randomness);
  if (!equals(cSpend, onChainSpendable)) {
    throw new Error(
      "the stored opening does not match the on-chain spendable commitment; re-sync before spending",
    );
  }

  const rE = ephemeralScalar(vk, sigma);
  if (rE === 0n) throw new Error("ephemeral scalar derived to zero; resample sigma (T13)");
  const RE = scalarMul(rE, H);

  // T5, T7, T8, T9. The recipient reconstructs all of this from their own vk
  // and the published R_e, which is what makes the transfer spendable by them.
  const s = sharedScalar(rE, recipientPvk);
  const rTransfer = transferBlinding(s, sigma);
  const cTransfer = commit(amount, rTransfer);
  const vTilde = encryptAmount(amount, s, sigma);

  const vNew = spendable.value - amount;
  const rNew = spendRandomness(vk, sigma);
  const cSpendNew = commit(vNew, rNew);
  const bTilde = encryptBalance(vNew, vk, sigma);

  // T_a1..T_a4: recipient channel. Lane 0 amount, lane 1 transfer randomness.
  const sAr = sharedScalar(rE, recipientAuditorKey);
  const [mvR, mrR] = spongeSqueeze2(DOMAIN.AUDITOR_RECIPIENT, sAr, sigma);
  const vTildeAudR = addFr(amount, mvR);
  const rTildeAudR = addFr(rTransfer, mrR);

  // T_a5..T_a8: sender channel. Lane 0 amount, lane 1 post-transfer balance.
  const sAs = sharedScalar(rE, senderAuditorKey);
  const [mvS, mbS] = spongeSqueeze2(DOMAIN.AUDITOR_SENDER, sAs, sigma);
  const vTildeAudS = addFr(amount, mvS);
  const bTildeAudS = addFr(vNew, mbS);

  return {
    circuit: "transfer",
    publicInputs: [
      ...pointSlots(cSpend),
      ...pointSlots(Y),
      ...pointSlots(recipientPvk),
      addrF,
      ...pointSlots(recipientAuditorKey),
      ...pointSlots(senderAuditorKey),
      ...pointSlots(cSpendNew),
      ...pointSlots(cTransfer),
      ...pointSlots(RE),
      vTilde,
      bTilde,
      sigma,
      vTildeAudR,
      rTildeAudR,
      vTildeAudS,
      bTildeAudS,
    ],
    privateInputs: {
      sk,
      v: spendable.value,
      r: spendable.randomness,
      v_transfer: amount,
      r_e: rE,
    },
    payload: {
      cSpendNew,
      cTransfer,
      RE,
      vTilde,
      bTilde,
      sigma,
      vTildeAudR,
      rTildeAudR,
      vTildeAudS,
      bTildeAudS,
    },
  };
}

/**
 * What the recipient does with an inbound transfer: recompute the shared scalar
 * from their own vk and the published R_e, then unmask the amount and blinding.
 * The result is a full opening they can spend.
 */
export function decryptIncomingTransfer(
  vk: bigint,
  RE: Point,
  vTilde: bigint,
  sigma: bigint,
): Opening {
  const s = sharedScalar(vk, RE);
  const mask = encryptAmount(0n, s, sigma);
  const value = (vTilde - mask + R) % R;
  const randomness = transferBlinding(s, sigma);
  return { value, randomness };
}
