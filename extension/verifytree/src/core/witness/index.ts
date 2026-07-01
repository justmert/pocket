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
// Freshness is owned HERE, by the caller assembling a witness, not by the
// builders: each takes sigma as an input and cannot know whether it is new.
// Exporting the builders without the sampler would hand a consumer the
// operations and withhold the safety-critical input they all need. A repeated
// sigma repeats the ephemeral key and every derived channel mask.
export { sampleSalt } from "./salt";
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
export { circuitInputs, PUBLIC_INPUT_NAMES } from "./inputs";
export type { ConfidentialAccount, Opening, HolderKeys, Witness } from "./types";
export { pointSlots } from "./types";
