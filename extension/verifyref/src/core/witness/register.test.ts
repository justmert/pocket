import { describe, it, expect } from "vitest";
import { buildRegisterWitness } from "./register";
import { PUBLIC_INPUT_COUNT } from "../prover/protocol";
import { vkFromSk } from "../crypto/derive";
import { isOnCurve, scalarMul, H } from "../crypto/grumpkin";
import { R } from "../crypto/field";

const ADDR_F = 0x1997b0390a25f684e91575771f4c3ca72ac8f20f45a462838ea918bbe8c4e19cn;
const ACCT_F = 0x1d3b0901201ea22ad61ed4600b49dee57bb73369bf07bdeab17cbf0e54debd4fn;

describe("register witness", () => {
  const w = buildRegisterWitness({ sk: 0xdeadn, addrF: ADDR_F, acctF: ACCT_F });

  it("produces exactly the slot count the circuit declares", () => {
    expect(w.publicInputs).toHaveLength(PUBLIC_INPUT_COUNT.register);
    expect(w.publicInputs).toHaveLength(6);
  });

  it("orders slots as y_x, y_y, pvk_x, pvk_y, addr_f, acct_f", () => {
    // A permutation of two same-typed inputs verifies a DIFFERENT statement,
    // so the order is checked against the circuit signature, not assumed.
    expect(w.publicInputs[0]).toBe(w.keys.spendingPublicKey.x);
    expect(w.publicInputs[1]).toBe(w.keys.spendingPublicKey.y);
    expect(w.publicInputs[2]).toBe(w.keys.viewingPublicKey.x);
    expect(w.publicInputs[3]).toBe(w.keys.viewingPublicKey.y);
    expect(w.publicInputs[4]).toBe(ADDR_F);
    expect(w.publicInputs[5]).toBe(ACCT_F);
  });

  it("satisfies R1: Y = sk*H", () => {
    expect(w.keys.spendingPublicKey).toEqual(scalarMul(0xdeadn, H));
  });

  it("satisfies R2 and R3: vk from sk, PVK = vk*H", () => {
    const vk = vkFromSk(0xdeadn, ADDR_F);
    expect(w.keys.vk).toBe(vk);
    expect(w.keys.viewingPublicKey).toEqual(scalarMul(vk, H));
  });

  it("puts both keys on the curve", () => {
    expect(isOnCurve(w.keys.spendingPublicKey)).toBe(true);
    expect(isOnCurve(w.keys.viewingPublicKey)).toBe(true);
  });

  it("rejects sk = 0 (R4), which would make Y the identity", () => {
    expect(() => buildRegisterWitness({ sk: 0n, addrF: ADDR_F, acctF: ACCT_F })).toThrow(/R4/);
  });

  it("rejects a non-canonical sk", () => {
    expect(() => buildRegisterWitness({ sk: R, addrF: ADDR_F, acctF: ACCT_F })).toThrow(/R4/);
  });

  it("binds the deployment: a different addr_f is a different identity", () => {
    const other = buildRegisterWitness({ sk: 0xdeadn, addrF: 0x1234n, acctF: ACCT_F });
    expect(other.keys.vk).not.toBe(w.keys.vk);
    expect(other.keys.viewingPublicKey).not.toEqual(w.keys.viewingPublicKey);
  });

  it("binds the account: acct_f changes the public vector, not the keys", () => {
    // acct_f is referenced by no gate. Its presence in the transcript is what
    // stops a published registration being replayed under another address.
    const other = buildRegisterWitness({ sk: 0xdeadn, addrF: ADDR_F, acctF: 0x9999n });
    expect(other.keys.spendingPublicKey).toEqual(w.keys.spendingPublicKey);
    expect(other.publicInputs[5]).not.toBe(w.publicInputs[5]);
  });

  it("keeps sk private", () => {
    expect(w.publicInputs).not.toContain(0xdeadn);
    expect(w.privateInputs.sk).toBe(0xdeadn);
  });
});
