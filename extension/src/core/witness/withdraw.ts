// The Withdraw witness. Circuit type 1, fifteen public-input slots.
//
// Constraints (design doc 7.3):
//   W1   Y        = sk*H
//   W2   vk       = Poseidon2(delta_vk, sk, addr_f)
//   W3   C_spend  = v*G + r*H                     the opening we are spending
//   W4   v, a, v-a all in [0, 2^127)              range validity
//   W5   r'       = Poseidon2(delta_spend_r, vk, sigma)
//   W6   C_spend' = (v-a)*G + r'*H
//   W7   b_tilde  = (v-a) + Poseidon2(delta_enc_bal, vk, sigma)
//   W8   r_e != 0
//   W_a1 R_e      = r_e*H
//   W_a2 s_as     = ecdh(r_e, K_aud_s)
//   W_a3 m_b      = SpongeSqueeze_2(delta_aud_s, s_as, sigma)[1]   SECOND squeeze
//   W_a4 b_tilde_aud_s = (v-a) + m_b
//
// Lane 1, not lane 0. The first squeeze is the amount slot and goes unused here
// because a withdrawal amount is public. Taking lane 0 is the defect upstream
// audit finding N-07 fixed, and it would silently produce a checkpoint the
// auditor cannot read.
import {
  vkFromSk,
  spendingPublicKey,
  spendRandomness,
  encryptBalance,
  encryptAuditorSenderBalance,
  ephemeralScalar,
  sharedScalar,
} from "../crypto/derive";
import { commit, scalarMul, H, equals, type Point } from "../crypto/grumpkin";
import { R } from "../crypto/field";
import { pointSlots, type Opening, type Witness } from "./types";
import { MAX_AMOUNT, assertFr, assertAmount, assertPoint, assertSpendableBlinding } from "./guards";

export { MAX_AMOUNT };

export interface WithdrawInputs {
  sk: bigint;
  addrF: bigint;
  /** The opening of the current spendable commitment. */
  spendable: Opening;
  /** Public withdrawal amount. */
  amount: bigint;
  /** Fresh salt. MUST be sampled per attempt, never reused or derived. */
  sigma: bigint;
  /** The sender's bound auditor key, fetched from the registry. */
  auditorKey: Point;
  /** On-chain spendable commitment, to check our opening against. */
  onChainSpendable: Point;
}

export function buildWithdrawWitness(input: WithdrawInputs): Witness {
  const { sk, addrF, spendable, amount, sigma, auditorKey, onChainSpendable } = input;

  // Reject at our own boundary rather than deferring to the contract.
  if (sk <= 0n || sk >= R) throw new Error("sk must be a nonzero canonical F_r element");
  assertFr(addrF, "addr_f");
  assertFr(sigma, "sigma");
  assertPoint(auditorKey, "auditor key");
  assertPoint(onChainSpendable, "on-chain spendable commitment");
  assertAmount(amount, "amount");
  assertAmount(spendable.value, "spendable balance");
  assertSpendableBlinding(spendable.randomness);
  if (amount > spendable.value) throw new Error("insufficient spendable balance (W4)");

  const vk = vkFromSk(sk, addrF);
  const Y = spendingPublicKey(sk);

  // W3. Our stored opening must actually open the commitment the chain holds.
  // A mismatch here means local state has diverged, and proving against it
  // would produce a proof that fails on chain for reasons nobody can diagnose.
  const cSpend = commit(spendable.value, spendable.randomness);
  if (!equals(cSpend, onChainSpendable)) {
    throw new Error(
      "the stored opening does not match the on-chain spendable commitment; re-sync before spending",
    );
  }

  const vNew = spendable.value - amount;
  const rNew = spendRandomness(vk, sigma);
  const cSpendNew = commit(vNew, rNew);
  const bTilde = encryptBalance(vNew, vk, sigma);

  // W8. Derived, never sampled: see derive.ts on why this cannot be retrofitted.
  const rE = ephemeralScalar(vk, sigma);
  if (rE === 0n) throw new Error("ephemeral scalar derived to zero; resample sigma (W8)");
  const RE = scalarMul(rE, H);

  const sAs = sharedScalar(rE, auditorKey);
  const bTildeAudS = encryptAuditorSenderBalance(vNew, sAs, sigma);

  return {
    circuit: "withdraw",
    // c_spend, Y, addr_f, K_aud_s, a, C_spend', sigma, b_tilde, R_e, b_tilde_aud_s
    publicInputs: [
      ...pointSlots(cSpend),
      ...pointSlots(Y),
      addrF,
      ...pointSlots(auditorKey),
      amount,
      ...pointSlots(cSpendNew),
      sigma,
      bTilde,
      ...pointSlots(RE),
      bTildeAudS,
    ],
    privateInputs: { sk, v: spendable.value, r: spendable.randomness, r_e: rE },
    payload: { cSpendNew, sigma, bTilde, RE, bTildeAudS },
  };
}
