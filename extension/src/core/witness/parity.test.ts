import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { buildRegisterWitness } from "./register";

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
