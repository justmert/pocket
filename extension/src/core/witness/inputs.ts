// The one place a public-input SLOT is given a circuit input NAME.
//
// This mapping used to be written out by hand at every call site: once in
// confidential-ops.ts for the real wallet, once in parity.test.ts for the
// nargo harness, once in circuits.test.ts. Three copies of a permutation-
// sensitive table means the test copy can agree with the circuit while the
// production copy does not, and nothing notices. That is the same shape as the
// gzip trap: a component test preparing its input differently from production
// is not testing production.
//
// The names below are the `main` parameter names of the vendored circuits, in
// declaration order. Declaration order IS the public-input order bb emits, and
// it is the order the contract appends in (storage.rs `register` /
// `withdraw` / `confidential_transfer`). All three agree slot for slot.
import type { Witness } from "./types";

/** Public parameters of each circuit's `main`, in declaration order. */
const PUBLIC_INPUTS: Record<string, readonly string[]> = {
  register: ["y_x", "y_y", "pvk_x", "pvk_y", "addr_f", "_acct_f"],
  withdraw: [
    "c_spend_x",
    "c_spend_y",
    "y_x",
    "y_y",
    "addr_f",
    "k_aud_s_x",
    "k_aud_s_y",
    "a",
    "c_spend_new_x",
    "c_spend_new_y",
    "sigma",
    "b_tilde",
    "r_e_x",
    "r_e_y",
    "b_tilde_aud_s",
  ],
  transfer: [
    "c_spend_x",
    "c_spend_y",
    "y_x",
    "y_y",
    "pvk_b_x",
    "pvk_b_y",
    "addr_f",
    "k_aud_r_x",
    "k_aud_r_y",
    "k_aud_s_x",
    "k_aud_s_y",
    "c_spend_new_x",
    "c_spend_new_y",
    "c_transfer_x",
    "c_transfer_y",
    "r_e_x",
    "r_e_y",
    "v_tilde",
    "b_tilde",
    "sigma",
    "v_tilde_aud_r",
    "r_tilde_aud_r",
    "v_tilde_aud_s",
    "b_tilde_aud_s",
  ],
};

/** How many field slots each circuit publishes. Points take two. */
export const PUBLIC_INPUT_COUNT: Record<string, number> = Object.fromEntries(
  Object.entries(PUBLIC_INPUTS).map(([k, v]) => [k, v.length]),
);

/**
 * Name every input the solver needs: the private ones the builder already
 * names, plus the public ones addressed by slot.
 *
 * The length check is not defensive padding. A builder that gains or loses a
 * slot produces a vector the contract will assemble differently, and the
 * resulting proof fails at the verifier with nothing to point at. Catching it
 * here names the circuit and both counts.
 */
export function circuitInputs(w: Witness): Record<string, bigint> {
  const names = PUBLIC_INPUTS[w.circuit];
  if (!names) throw new Error(`no public input names are declared for circuit ${w.circuit}`);
  if (names.length !== w.publicInputs.length) {
    throw new Error(
      `${w.circuit} built ${w.publicInputs.length} public input slots, but the circuit ` +
        `declares ${names.length}`,
    );
  }
  const out: Record<string, bigint> = { ...w.privateInputs };
  names.forEach((name, i) => {
    out[name] = w.publicInputs[i] as bigint;
  });
  return out;
}
