// The Register witness. Circuit type 0, six public-input slots.
//
// Constraints the circuit enforces (design doc 7.2):
//   R1  Y   = sk*H
//   R2  vk  = Poseidon2(delta_vk, sk, addr_f)
//   R3  PVK = vk*H
//   R4  sk != 0
//   R5  vk != 0
//
// acct_f is referenced by no gate. Its presence in the public-input set IS the
// binding: UltraHonk absorbs every public input into the transcript, so a proof
// made for one account fails when the contract assembles the vector for
// another. Without it, the proof and payload that a legitimate registration
// publishes on chain could be replayed to mint duplicate-key accounts. That is
// audit finding L-06, and it is why the demo's pre-audit VKs are unusable.
import { vkFromSk, spendingPublicKey, publicViewingKey } from "../crypto/derive";
import { R } from "../crypto/field";
import { pointSlots, type HolderKeys, type Witness } from "./types";
import { assertFr } from "./guards";

export interface RegisterInputs {
  sk: bigint;
  /** address_to_field of the confidential token contract. */
  addrF: bigint;
  /** address_to_field of the registering account. */
  acctF: bigint;
}

export function buildRegisterWitness(input: RegisterInputs): Witness & { keys: HolderKeys } {
  const { sk, addrF, acctF } = input;

  if (sk <= 0n || sk >= R) throw new Error("sk must be a nonzero canonical F_r element (R4)");
  assertFr(addrF, "addr_f");
  assertFr(acctF, "acct_f");
  const vk = vkFromSk(sk, addrF);
  if (vk === 0n) throw new Error("vk is zero; this sk cannot be registered (R5)");

  const Y = spendingPublicKey(sk);
  const PVK = publicViewingKey(vk);

  return {
    circuit: "register",
    // Order fixed by the circuit signature: y_x, y_y, pvk_x, pvk_y, addr_f, acct_f.
    publicInputs: [...pointSlots(Y), ...pointSlots(PVK), addrF, acctF],
    privateInputs: { sk },
    payload: { Y, PVK },
    keys: { sk, vk, spendingPublicKey: Y, viewingPublicKey: PVK },
  };
}
