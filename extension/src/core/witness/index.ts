// The confidential SDK's public surface.
//
// Layering follows SDK.md section 2.2, which is normative because conformance
// is defined over the lower layers only:
//
//   crypto core      deterministic, no I/O, no state   core/crypto/
//   key derivation   deterministic, no I/O             core/keys/
//   witness assembly deterministic given randomness    core/witness/
//   prover           I/O, pluggable backend            core/prover/
//   chain adapter    I/O                               core/chain/
//   role facades     stateful                          core/controller.ts
//
// Nothing below the prover may reach for the network or for storage.
export { buildRegisterWitness, type RegisterInputs } from "./register";
export { buildWithdrawWitness, type WithdrawInputs, MAX_AMOUNT } from "./withdraw";
export { buildTransferWitness, decryptIncomingTransfer, type TransferInputs } from "./transfer";
export {
  encodeRegisterData,
  encodeWithdrawData,
  encodeTransferData,
  decodeEnvelope,
  structToScVal,
} from "./payload";
export type { ConfidentialAccount, Opening, HolderKeys, Witness } from "./types";
export { pointSlots } from "./types";
