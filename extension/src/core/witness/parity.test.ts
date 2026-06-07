import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildRegisterWitness } from "./register";
import { buildWithdrawWitness } from "./withdraw";
import { buildTransferWitness, decryptIncomingTransfer } from "./transfer";
import { vkFromSk } from "../crypto/derive";
import { commit, scalarMul, H } from "../crypto/grumpkin";

// PARITY. Build a witness with OUR crypto and have the REAL circuit solve it.
// This is the test that catches domain-tag, ordering and derivation errors:
// unit tests can agree with themselves forever, but the circuit is the
// authority on whether our inputs describe a satisfiable statement.
//
// Tamper cases matter as much as the happy path. A parity suite that only ever
// feeds correct inputs proves nothing about whether the constraints bind.
const NARGO = "/tmp/nargo-beta11";
const CIRCUITS = join(
  import.meta.dirname,
  "../../../../resources/upstream/stellar-contracts/packages/tokens/src/confidential/circuits",
);
const available = existsSync(NARGO) && existsSync(CIRCUITS);

const ADDR_F = 0x1997b0390a25f684e91575771f4c3ca72ac8f20f45a462838ea918bbe8c4e19cn;
const ACCT_F = 0x1d3b0901201ea22ad61ed4600b49dee57bb73369bf07bdeab17cbf0e54debd4fn;
const hx = (v: bigint) => `"0x${v.toString(16)}"`;

/** Ask the real circuit to solve a witness. Returns true when it is satisfiable. */
function solves(circuit: string, fields: Record<string, bigint>, name: string): boolean {
  const dir = join(CIRCUITS, circuit);
  writeFileSync(
    join(dir, "Prover.toml"),
    Object.entries(fields)
      .map(([k, v]) => `${k} = ${hx(v)}`)
      .join("\n") + "\n",
  );
  try {
    execFileSync(NARGO, ["execute", name], { cwd: dir, stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const registerFields = (w: ReturnType<typeof buildRegisterWitness>) => ({
  sk: w.privateInputs.sk as bigint,
  y_x: w.publicInputs[0] as bigint,
  y_y: w.publicInputs[1] as bigint,
  pvk_x: w.publicInputs[2] as bigint,
  pvk_y: w.publicInputs[3] as bigint,
  addr_f: w.publicInputs[4] as bigint,
  _acct_f: w.publicInputs[5] as bigint,
});

describe.skipIf(!available)("register circuit parity", () => {
  const w = buildRegisterWitness({ sk: 0xdeadn, addrF: ADDR_F, acctF: ACCT_F });

  it("the real circuit solves a witness built by our crypto", () => {
    expect(solves("register", registerFields(w), "parity_ok")).toBe(true);
  }, 60_000);

  it("rejects a tampered Y (constraint R1: Y = sk*H)", () => {
    const f = registerFields(w);
    expect(solves("register", { ...f, y_x: f.y_x + 1n }, "parity_bad_y")).toBe(false);
  }, 60_000);

  it("rejects a tampered PVK (R3: PVK = vk*H)", () => {
    const f = registerFields(w);
    expect(solves("register", { ...f, pvk_x: f.pvk_x + 1n }, "parity_bad_pvk")).toBe(false);
  }, 60_000);

  it("rejects a mismatched addr_f (R2 binds vk to the deployment)", () => {
    // The keys were derived for ADDR_F. Claiming a different deployment must
    // fail, or a proof for one contract would verify against another.
    const f = registerFields(w);
    expect(solves("register", { ...f, addr_f: ADDR_F + 1n }, "parity_bad_addr")).toBe(false);
  }, 60_000);

  it("rejects a wrong sk for the published Y", () => {
    const f = registerFields(w);
    expect(solves("register", { ...f, sk: 0xbeefn }, "parity_bad_sk")).toBe(false);
  }, 60_000);

  it("accepts any acct_f, because no gate references it", () => {
    // acct_f binds by being absorbed into the transcript, not by a constraint.
    // The circuit is indifferent; the CONTRACT is what rejects a replay, by
    // recomputing acct_f itself and assembling a different public vector.
    const f = registerFields(w);
    expect(solves("register", { ...f, _acct_f: 0x9999n }, "parity_other_acct")).toBe(true);
  }, 60_000);
});

const withdrawFields = (w: ReturnType<typeof buildWithdrawWitness>) => ({
  sk: w.privateInputs.sk as bigint,
  v: w.privateInputs.v as bigint,
  r: w.privateInputs.r as bigint,
  r_e: w.privateInputs.r_e as bigint,
  c_spend_x: w.publicInputs[0] as bigint,
  c_spend_y: w.publicInputs[1] as bigint,
  y_x: w.publicInputs[2] as bigint,
  y_y: w.publicInputs[3] as bigint,
  addr_f: w.publicInputs[4] as bigint,
  k_aud_s_x: w.publicInputs[5] as bigint,
  k_aud_s_y: w.publicInputs[6] as bigint,
  a: w.publicInputs[7] as bigint,
  c_spend_new_x: w.publicInputs[8] as bigint,
  c_spend_new_y: w.publicInputs[9] as bigint,
  sigma: w.publicInputs[10] as bigint,
  b_tilde: w.publicInputs[11] as bigint,
  r_e_x: w.publicInputs[12] as bigint,
  r_e_y: w.publicInputs[13] as bigint,
  b_tilde_aud_s: w.publicInputs[14] as bigint,
});

describe.skipIf(!available)("withdraw circuit parity", () => {
  const sk = 0xdeadn;
  const vk = vkFromSk(sk, ADDR_F);
  const spendable = { value: 1000n, randomness: 42n };
  const auditorKey = scalarMul(0xa0d17n, H);
  const w = buildWithdrawWitness({
    sk,
    addrF: ADDR_F,
    spendable,
    amount: 100n,
    sigma: 0x01n,
    auditorKey,
    onChainSpendable: commit(spendable.value, spendable.randomness),
  });

  it("produces exactly 15 slots", () => {
    expect(w.publicInputs).toHaveLength(15);
  });

  it("the real circuit solves a witness built by our crypto", () => {
    expect(solves("withdraw", withdrawFields(w), "parity_wd_ok")).toBe(true);
  }, 60_000);

  it("rejects a tampered new commitment (W6)", () => {
    const f = withdrawFields(w);
    expect(solves("withdraw", { ...f, c_spend_new_x: f.c_spend_new_x + 1n }, "parity_wd_c")).toBe(
      false,
    );
  }, 60_000);

  it("rejects a tampered balance ciphertext (W7)", () => {
    const f = withdrawFields(w);
    expect(solves("withdraw", { ...f, b_tilde: f.b_tilde + 1n }, "parity_wd_b")).toBe(false);
  }, 60_000);

  it("rejects a tampered auditor checkpoint (W_a4)", () => {
    // This is the lane-0/lane-1 defect: an auditor ciphertext built from the
    // wrong squeeze is well-formed and unreadable by the auditor.
    const f = withdrawFields(w);
    expect(solves("withdraw", { ...f, b_tilde_aud_s: f.b_tilde_aud_s + 1n }, "parity_wd_aud")).toBe(
      false,
    );
  }, 60_000);

  it("rejects an amount larger than the balance (W4)", () => {
    // The witness builder catches this first, so drive the circuit directly to
    // prove the constraint itself binds.
    const f = withdrawFields(w);
    expect(solves("withdraw", { ...f, a: 5000n }, "parity_wd_over")).toBe(false);
  }, 60_000);

  it("refuses to build when the opening does not match the chain", () => {
    // A diverged local state must fail here, not produce a proof that fails on
    // chain for reasons nobody can diagnose.
    expect(() =>
      buildWithdrawWitness({
        sk,
        addrF: ADDR_F,
        spendable,
        amount: 100n,
        sigma: 0x01n,
        auditorKey,
        onChainSpendable: commit(999n, 42n),
      }),
    ).toThrow(/re-sync/);
  });

  it("derives a viewing key consistent with the register witness", () => {
    expect(vk).toBe(vkFromSk(sk, ADDR_F));
  });
});

const transferFields = (w: ReturnType<typeof buildTransferWitness>) => {
  const p = w.publicInputs as bigint[];
  return {
    sk: w.privateInputs.sk as bigint,
    v: w.privateInputs.v as bigint,
    r: w.privateInputs.r as bigint,
    v_transfer: w.privateInputs.v_transfer as bigint,
    r_e: w.privateInputs.r_e as bigint,
    c_spend_x: p[0]!,
    c_spend_y: p[1]!,
    y_x: p[2]!,
    y_y: p[3]!,
    pvk_b_x: p[4]!,
    pvk_b_y: p[5]!,
    addr_f: p[6]!,
    k_aud_r_x: p[7]!,
    k_aud_r_y: p[8]!,
    k_aud_s_x: p[9]!,
    k_aud_s_y: p[10]!,
    c_spend_new_x: p[11]!,
    c_spend_new_y: p[12]!,
    c_transfer_x: p[13]!,
    c_transfer_y: p[14]!,
    r_e_x: p[15]!,
    r_e_y: p[16]!,
    v_tilde: p[17]!,
    b_tilde: p[18]!,
    sigma: p[19]!,
    v_tilde_aud_r: p[20]!,
    r_tilde_aud_r: p[21]!,
    v_tilde_aud_s: p[22]!,
    b_tilde_aud_s: p[23]!,
  };
};

describe.skipIf(!available)("transfer circuit parity", () => {
  const sk = 0xdeadn;
  const spendable = { value: 1000n, randomness: 42n };
  const recipientVk = 0xbeefn;
  const w = buildTransferWitness({
    sk,
    addrF: ADDR_F,
    spendable,
    amount: 100n,
    sigma: 0x01n,
    recipientPvk: scalarMul(recipientVk, H),
    recipientAuditorKey: scalarMul(0xa0d17n, H),
    senderAuditorKey: scalarMul(0xa0d18n, H),
    onChainSpendable: commit(spendable.value, spendable.randomness),
  });

  it("produces exactly 24 slots", () => {
    expect(w.publicInputs).toHaveLength(24);
  });

  it("the real circuit solves a witness built by our crypto", () => {
    expect(solves("transfer", transferFields(w), "parity_tx_ok")).toBe(true);
  }, 60_000);

  it("rejects a tampered transfer commitment (T8)", () => {
    const f = transferFields(w);
    expect(solves("transfer", { ...f, c_transfer_x: f.c_transfer_x + 1n }, "parity_tx_c")).toBe(
      false,
    );
  }, 60_000);

  it("rejects a tampered encrypted amount (T9)", () => {
    const f = transferFields(w);
    expect(solves("transfer", { ...f, v_tilde: f.v_tilde + 1n }, "parity_tx_v")).toBe(false);
  }, 60_000);

  it("rejects a tampered recipient-auditor ciphertext (T_a3)", () => {
    const f = transferFields(w);
    expect(solves("transfer", { ...f, v_tilde_aud_r: f.v_tilde_aud_r + 1n }, "parity_tx_ar")).toBe(
      false,
    );
  }, 60_000);

  it("rejects a tampered sender-auditor ciphertext (T_a7)", () => {
    const f = transferFields(w);
    expect(solves("transfer", { ...f, v_tilde_aud_s: f.v_tilde_aud_s + 1n }, "parity_tx_as")).toBe(
      false,
    );
  }, 60_000);

  it("rejects spending more than the balance (T4)", () => {
    const f = transferFields(w);
    expect(solves("transfer", { ...f, v_transfer: 5000n }, "parity_tx_over")).toBe(false);
  }, 60_000);

  it("lets the recipient reconstruct the opening, which is what T7 buys", () => {
    // The anti-poisoning constraint forces the blinding to be a function of the
    // ECDH secret, so the recipient can recompute it. Without T7 a malicious
    // sender could hand over a commitment nobody can open.
    const opening = decryptIncomingTransfer(
      recipientVk,
      { x: w.publicInputs[15] as bigint, y: w.publicInputs[16] as bigint },
      w.publicInputs[17] as bigint,
      w.publicInputs[19] as bigint,
    );
    expect(opening.value).toBe(100n);
    // And that opening actually opens the published transfer commitment.
    expect(commit(opening.value, opening.randomness)).toEqual({
      x: w.publicInputs[13] as bigint,
      y: w.publicInputs[14] as bigint,
    });
  });
});
