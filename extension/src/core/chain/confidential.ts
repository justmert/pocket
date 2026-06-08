// Chain adapter for the confidential token.
//
// Reads account state and assembles the invocations. The public-input vectors
// the circuits take are mirrored from what the CONTRACT holds, never from what
// a caller claims, because the contract reassembles them itself and a mismatch
// fails at the proof boundary with no useful diagnostic.
import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk/base";
import type { rpc } from "@stellar/stellar-sdk";
import { decodePoint, type Point } from "../crypto/grumpkin";
import type { ConfidentialAccount } from "../witness/types";

/** Contract error codes, mapped to what a user can actually do about them. */
export const CONTRACT_ERRORS: Record<number, string> = {
  3500: "This account already has a private pocket.",
  3501: "That account has no private pocket yet. Ask them to set one up first.",
  3502: "Amount cannot be negative.",
  3503: "A spending allowance already exists for that address.",
  3504: "No such spending allowance.",
  3505: "That spending allowance has expired.",
  3506: "The proof was rejected.",
  3507: "The transaction data was malformed.",
  3508: "This deployment has no underlying asset set.",
  3509: "This deployment has no verifier set.",
  3510: "This deployment has no auditor registry set.",
  3511: "This deployment is not fully initialised.",
  3512: "This deployment is already initialised.",
  3513: "The underlying asset is already set.",
  3514: "A value was not canonically encoded.",
};

/**
 * 3506 is almost never the user's fault. SDK.md 9.4 requires proof failure and
 * state mismatch to be distinguishable, because they present identically on the
 * wire and have opposite remedies: one means rebuild the witness, the other
 * means re-sync first and then rebuild.
 */
export function describeContractError(code: number): string {
  return CONTRACT_ERRORS[code] ?? `The contract rejected this (error ${code}).`;
}

/**
 * Read an account's confidential state via simulation. Returns null when the
 * account has no private pocket on this deployment.
 *
 * A simulated read does NOT bump the entry's TTL. Only a submitted transaction
 * does, which is why a saver who never transacts still archives after 30 days.
 */
export async function readConfidentialAccount(
  server: rpc.Server,
  tokenId: string,
  account: string,
  sourceAccount: Account,
  networkPassphrase: string,
): Promise<ConfidentialAccount | null> {
  const tx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      new Contract(tokenId).call(
        "confidential_balance",
        nativeToScVal(Address.fromString(account)),
      ),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if ("error" in sim) {
    // 3501 is "not registered", which is a normal state and not a failure.
    if (/#3501|AccountNotRegistered/i.test(sim.error)) return null;
    throw new Error(sim.error);
  }
  const raw = (sim as { result?: { retval: xdr.ScVal } }).result?.retval;
  if (!raw) return null;
  return decodeConfidentialAccount(raw);
}

/** Read an auditor's registered key by id. Returns null when unregistered. */
export async function readAuditorKey(
  server: rpc.Server,
  auditorId_: number,
  registryId: string,
  sourceAccount: Account,
  networkPassphrase: string,
): Promise<Point | null> {
  const tx = new TransactionBuilder(sourceAccount, { fee: BASE_FEE, networkPassphrase })
    .addOperation(
      new Contract(registryId).call("get_key", nativeToScVal(auditorId_, { type: "u32" })),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if ("error" in sim) return null;
  const raw = (sim as { result?: { retval: xdr.ScVal } }).result?.retval;
  if (!raw || raw.switch().name !== "scvBytes") return null;
  return decodePoint(new Uint8Array(raw.bytes()));
}

/**
 * Decode the `ConfidentialAccount` the contract returns from
 * `confidential_balance`.
 *
 * It comes back as an ScMap directly, not as Bytes wrapping XDR: the return
 * type is a `#[contracttype]` struct, which the host renders as a map with
 * sorted Symbol keys. Points are 64-byte uncompressed affine.
 */
export function decodeConfidentialAccount(v: xdr.ScVal): ConfidentialAccount {
  const entries = v.map();
  if (!entries) throw new Error("confidential account is not an ScMap");

  const get = (name: string): xdr.ScVal => {
    const e = entries.find((x) => x.key().sym().toString() === name);
    if (!e) throw new Error(`confidential account is missing ${name}`);
    return e.val();
  };
  const point = (name: string): Point => decodePoint(new Uint8Array(get(name).bytes()));

  return {
    spendingPublicKey: point("spending_public_key"),
    viewingPublicKey: point("viewing_public_key"),
    spendableCommitment: point("spendable_commitment"),
    receivingCommitment: point("receiving_commitment"),
    auditorId: get("auditor_id").u32(),
  };
}
