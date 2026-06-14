import { describe, it, expect, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { buildRegisterWitness } from "./register";
import { buildWithdrawWitness } from "./withdraw";
import { buildTransferWitness, decryptIncomingTransfer } from "./transfer";
import { circuitInputs } from "./inputs";
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

// nargo writes each solved witness into the circuit package's target/, which
// `npm run vendor` copies wholesale into the shipped extension. Naming them
// here lets the suite take its own artifacts back out again.
const written: string[] = [];

/** Ask the real circuit to solve a witness. Returns true when it is satisfiable. */
function solves(circuit: string, fields: Record<string, bigint>, name: string): boolean {
  const dir = join(CIRCUITS, circuit);
  written.push(join(CIRCUITS, "target", `${name}.gz`));
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

afterAll(() => {
  for (const f of written) rmSync(f, { force: true });
});

// The SAME mapping the wallet uses, not a second copy of it. A test that
// re-derives the slot-to-name table proves only that the test agrees with the
// circuit, which is exactly the gap the gzip trap lived in.
const registerFields = (w: ReturnType<typeof buildRegisterWitness>) => circuitInputs(w);

/** Tamper with one named input. The name is looked up, never re-derived. */
const bump = (f: Record<string, bigint>, key: string): Record<string, bigint> => {
  const v = f[key];
  if (v === undefined) throw new Error(`${key} is not an input of this circuit`);
  return { ...f, [key]: v + 1n };
};

describe.skipIf(!available)("register circuit parity", () => {
  const w = buildRegisterWitness({ sk: 0xdeadn, addrF: ADDR_F, acctF: ACCT_F });

  it("the real circuit solves a witness built by our crypto", () => {
    expect(solves("register", registerFields(w), "parity_ok")).toBe(true);
  }, 60_000);

  it("rejects a tampered Y (constraint R1: Y = sk*H)", () => {
    const f = registerFields(w);
    expect(solves("register", bump(f, "y_x"), "parity_bad_y")).toBe(false);
  }, 60_000);

  it("rejects a tampered PVK (R3: PVK = vk*H)", () => {
    const f = registerFields(w);
    expect(solves("register", bump(f, "pvk_x"), "parity_bad_pvk")).toBe(false);
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

const withdrawFields = (w: ReturnType<typeof buildWithdrawWitness>) => circuitInputs(w);

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
    expect(solves("withdraw", bump(f, "c_spend_new_x"), "parity_wd_c")).toBe(
      false,
    );
  }, 60_000);

  it("rejects a tampered balance ciphertext (W7)", () => {
    const f = withdrawFields(w);
    expect(solves("withdraw", bump(f, "b_tilde"), "parity_wd_b")).toBe(false);
  }, 60_000);

  it("rejects a tampered auditor checkpoint (W_a4)", () => {
    // This is the lane-0/lane-1 defect: an auditor ciphertext built from the
    // wrong squeeze is well-formed and unreadable by the auditor.
    const f = withdrawFields(w);
    expect(solves("withdraw", bump(f, "b_tilde_aud_s"), "parity_wd_aud")).toBe(
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

const transferFields = (w: ReturnType<typeof buildTransferWitness>) => circuitInputs(w);

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
    expect(solves("transfer", bump(f, "c_transfer_x"), "parity_tx_c")).toBe(
      false,
    );
  }, 60_000);

  it("rejects a tampered encrypted amount (T9)", () => {
    const f = transferFields(w);
    expect(solves("transfer", bump(f, "v_tilde"), "parity_tx_v")).toBe(false);
  }, 60_000);

  it("rejects a tampered recipient-auditor ciphertext (T_a3)", () => {
    const f = transferFields(w);
    expect(solves("transfer", bump(f, "v_tilde_aud_r"), "parity_tx_ar")).toBe(
      false,
    );
  }, 60_000);

  it("rejects a tampered sender-auditor ciphertext (T_a7)", () => {
    const f = transferFields(w);
    expect(solves("transfer", bump(f, "v_tilde_aud_s"), "parity_tx_as")).toBe(
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
    const RE = { x: w.publicInputs[15] as bigint, y: w.publicInputs[16] as bigint };
    const cTransfer = { x: w.publicInputs[13] as bigint, y: w.publicInputs[14] as bigint };
    const vTilde = w.publicInputs[17] as bigint;
    const sigma = w.publicInputs[19] as bigint;

    const opening = decryptIncomingTransfer(recipientVk, RE, vTilde, sigma, cTransfer);
    expect(opening).not.toBeNull();
    expect(opening!.value).toBe(100n);
    expect(commit(opening!.value, opening!.randomness)).toEqual(cTransfer);
  });

  it("returns null for a transfer addressed to someone else", () => {
    // The common case when scanning: a wallet sees every transfer on the
    // contract and cannot know in advance which are its own. Crediting one that
    // is not ours inflates the receiving accumulator by up to 2^253.
    const RE = { x: w.publicInputs[15] as bigint, y: w.publicInputs[16] as bigint };
    const cTransfer = { x: w.publicInputs[13] as bigint, y: w.publicInputs[14] as bigint };
    expect(
      decryptIncomingTransfer(
        0xfacen, // not the recipient's vk
        RE,
        w.publicInputs[17] as bigint,
        w.publicInputs[19] as bigint,
        cTransfer,
      ),
    ).toBeNull();
  });

  it("returns null for a malformed ephemeral point", () => {
    const cTransfer = { x: w.publicInputs[13] as bigint, y: w.publicInputs[14] as bigint };
    for (const bad of [
      { x: 1n, y: 1n },
      { x: 0n, y: 0n },
    ]) {
      expect(
        decryptIncomingTransfer(
          recipientVk,
          bad,
          w.publicInputs[17] as bigint,
          w.publicInputs[19] as bigint,
          cTransfer,
        ),
      ).toBeNull();
    }
  });
});
