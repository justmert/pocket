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

/** A read that failed for a reason we can state. Never carries an RPC string. */
export class ConfidentialReadError extends Error {
  override readonly name = "ConfidentialReadError";
}

/**
 * 3508 to 3514 all say one thing: this deployment was wired up wrong. A user
 * can neither cause nor fix any of them, so seven wordings of the same dead end
 * are seven ways of telling someone to go away. One sentence, one meaning.
 */
const MISCONFIGURED = "This network's private pocket is misconfigured.";

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
  3508: MISCONFIGURED,
  3509: MISCONFIGURED,
  3510: MISCONFIGURED,
  3511: MISCONFIGURED,
  3512: MISCONFIGURED,
  3513: MISCONFIGURED,
  3514: MISCONFIGURED,
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

/** A contract refused a WRITE, in the wallet's own words. Never the RPC's. */
export class ContractRefusedError extends Error {
  override readonly name = "ContractRefusedError";
}

/**
 * Turn a failed simulation into a sentence, or leave it alone.
 *
 * `prepareTransaction` is the wallet's only route from an envelope to the
 * ledger, and stellar-sdk implements its failure as
 * `throw new Error(simResponse.error)` (rpc/server.js:1098). `name` is
 * therefore "Error", which is on neither allowlist in `dispatch.ts`, so EVERY
 * contract refusal on EVERY write path rendered as the generic fallback.
 * Measured live: six of six real failures produced that sentence, including
 * #3506, for which the wallet already holds the words "The proof was rejected."
 *
 * That sentence is worse than useless here. It invites a retry of something
 * deterministic: a diverged private transfer re-proves the same state and fails
 * identically, forever.
 *
 * The read path has done this correctly for a long time; only writes were
 * missed. `readConfidentialAccount` extracts the same code from the same shape
 * a few lines below.
 *
 * The RPC's own text is NEVER passed through. It runs to hundreds of characters
 * and can carry a URL, a stack fragment or an address decoded from the reply,
 * which is the reason `dispatch.ts` keeps an allowlist by name at all. Only the
 * matched code number crosses, and only into a sentence we wrote.
 *
 * An error this cannot explain is returned UNCHANGED, so an already-named error
 * passing through keeps its own name and its own sentence.
 */
export function explainSimulationFailure(e: unknown): unknown {
  if (!(e instanceof Error) || e.name !== "Error") return e;
  const text = e.message;
  const code = /Error\(Contract, #(\d+)\)/.exec(text)?.[1];
  if (code) return new ContractRefusedError(describeContractError(Number(code)));
  // `server.getAccount` throws `Error("Account not found: G...")`, which
  // interpolates an address decoded from the RPC's own reply. Matched, and then
  // answered with our own sentence rather than that one.
  if (/^Account not found/i.test(text)) {
    return new ContractRefusedError(
      "This account does not exist on the network yet, so it cannot sign anything. " +
        "It needs to be funded first.",
    );
  }
  return e;
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
  // An archived persistent entry comes back with a restore preamble rather
  // than a value. That is a state the private-pocket screen knows how to
  // render, so it must not be raised as an error: reading it as one shows a
  // failure where the right answer is "dormant, reactivate it".
  if ("restorePreamble" in sim && sim.restorePreamble) return null;
  if ("error" in sim) {
    // UNREACHABLE THROUGH THE CURRENT SDK, and kept deliberately. Measured
    // against a real `simulateTransaction`: `parseRawSimulation` attaches an
    // `error` key ONLY when the raw error was a string, so an object or a
    // number falls through to the success branch and is caught below by the
    // no-result refusal instead. So this stringify is defence in depth against
    // a future SDK that passes structured errors through, NOT the thing that
    // handles them today. Do not count it as tested: no test can reach it, and
    // two tests that look like they cover it are really exercising the
    // no-result path.
    const text = typeof sim.error === "string" ? sim.error : JSON.stringify(sim.error);
    if (/#3501|AccountNotRegistered/i.test(text)) return null;
    const code = /Error\(Contract, #(\d+)\)/.exec(text)?.[1];
    if (code) throw new ConfidentialReadError(describeContractError(Number(code)));
    throw new ConfidentialReadError(
      "Pocket could not read the private pocket from this deployment.",
    );
  }

  // No error, no restore preamble, and no result either. That is not "no
  // account", it is a reply that did not answer the question, and the two must
  // never collapse into the same branch.
  const result = (sim as { result?: { retval?: xdr.ScVal } }).result;
  if (!result || !result.retval) {
    throw new ConfidentialReadError("Could not read your private pocket. Try again in a moment.");
  }
  return decodeConfidentialAccount(result.retval);
}

/**
 * Read an auditor's registered key by id. Returns null ONLY when the registry
 * says that id is unregistered.
 *
 * The distinction matters because the caller turns null into "auditor #N has no
 * registered key". Returning null for any failed simulation made an RPC outage
 * or an archived registry say that too: a claim about the ledger's contents,
 * asserted from a request that never reached the ledger. AuditorNotRegistered
 * is 3301 (stellar-contracts packages/tokens/src/confidential/auditor/mod.rs),
 * and get_key panics with it rather than returning an option.
 */
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
  if ("restorePreamble" in sim && sim.restorePreamble) {
    throw new ConfidentialReadError(
      "Private transfers are unavailable: the auditor registry is dormant.",
    );
  }
  if ("error" in sim) {
    if (/#3301|AuditorNotRegistered/i.test(sim.error)) return null;
    throw new ConfidentialReadError("Pocket could not read the auditor registry.");
  }
  const raw = (sim as { result?: { retval: xdr.ScVal } }).result?.retval;
  if (!raw) throw new ConfidentialReadError("The auditor registry returned nothing.");
  if (raw.switch().name !== "scvBytes") {
    throw new ConfidentialReadError("The auditor registry returned an unexpected value.");
  }
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
