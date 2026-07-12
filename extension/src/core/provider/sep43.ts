// SEP-43, the standard web wallet API. Draft v1.2.1.
//
// Exactly five methods. Errors are returned IN THE RESOLVED OBJECT, never
// thrown: a dapp reads `result.error`, it does not catch.
//
// THE PRIVACY BOUNDARY. Sessions are scoped to the PUBLIC pocket only. No dapp
// ever sees, queries, or can request a signature against the private pocket.
// That is enforced structurally, by a method ALLOWLIST rather than a denylist:
// a denylist fails open the moment a new confidential operation is added, and
// SDK.md 3 requires each role be "structurally incapable of exceeding its
// capability".
import { TransactionBuilder, FeeBumpTransaction } from "@stellar/stellar-sdk/base";
import type { Transaction } from "@stellar/stellar-sdk/base";

export interface Sep43Error {
  message: string;
  code: -1 | -2 | -3 | -4;
  ext?: string[];
}

export const ERROR = {
  /** Wallet's own fault. */
  INTERNAL: -1,
  /** Horizon, RPC or another external service failed. */
  EXTERNAL: -2,
  /** The dapp asked for something invalid. */
  INVALID_REQUEST: -3,
  /** The user said no. The dapp must NOT retry. */
  USER_REJECTED: -4,
} as const;

export type Sep43Result<T> = T | { error: Sep43Error };

export interface Sep43Provider {
  getAddress(): Promise<Sep43Result<{ address: string }>>;
  signTransaction(
    xdr: string,
    opts?: { networkPassphrase?: string; address?: string; submit?: boolean; submitUrl?: string },
  ): Promise<Sep43Result<{ signedTxXdr: string; signerAddress: string }>>;
  signAuthEntry(
    authEntry: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<Sep43Result<{ signedAuthEntry: string; signerAddress: string }>>;
  signMessage(
    message: string,
    opts?: { networkPassphrase?: string; address?: string },
  ): Promise<Sep43Result<{ signedMessage: string; signerAddress: string }>>;
  getNetwork(): Promise<Sep43Result<{ network: string; networkPassphrase: string }>>;
}

export const err = (
  code: Sep43Error["code"],
  message: string,
  ext?: string[],
): { error: Sep43Error } => ({
  error: { code, message, ...(ext ? { ext } : {}) },
});

/**
 * The ONLY contract invocations a dapp session may sign.
 *
 * An allowlist, deliberately. Adding a confidential operation to the contract
 * must not silently widen what a dapp can reach, and with a denylist it would.
 *
 * Empty by default: the public pocket signs ordinary classic operations, and a
 * dapp wanting a specific contract method gets it added here explicitly after
 * review.
 */
export const DAPP_ALLOWED_CONTRACT_METHODS = new Set<string>([]);

/** Confidential operations. NEVER reachable through a dapp session. */
export const CONFIDENTIAL_METHODS = new Set([
  "register",
  "deposit",
  "merge",
  "withdraw",
  "confidential_transfer",
  "confidential_transfer_from",
  "set_spender",
  "revoke_spender",
  "confidential_balance",
]);

/**
 * Is this contract invocation permitted over a dapp session?
 *
 * Returns false for anything not explicitly allowed, including every method we
 * have never heard of. The confidential set is listed separately so the
 * intent is legible, but the allowlist alone is what enforces it.
 */
export function isDappPermittedMethod(method: string): boolean {
  return DAPP_ALLOWED_CONTRACT_METHODS.has(method);
}

/**
 * Why this envelope may not be signed over a dapp session, or null.
 *
 * `isDappPermittedMethod` above was called from exactly one place in the repo:
 * its own unit test. The session path held the set at arm's length with a bare
 * `void CONFIDENTIAL_METHODS`, which reads as a boundary and is a no-op, and
 * CLAUDE.md described that no-op as "enforced by a method allowlist". So the
 * documented structural boundary between a website and the private pocket did
 * not exist in code, and what was actually keeping a site out was an unrelated
 * gap: no screen can describe a contract call, so none gets that far.
 *
 * That is a real barrier and it is the wrong KIND of barrier. It holds for a
 * reason nobody chose, in a file nobody would think to check before making
 * contract calls describable. This is the check the documentation was
 * describing, now actually in the path.
 *
 * Deliberately structural rather than name-matching on the confidential set:
 * anything not explicitly allowed is refused, so a confidential entry point
 * added to the contract tomorrow is out by default rather than out until
 * somebody remembers to list it.
 */
export function dappForbiddenInvocation(xdr: string, networkPassphrase: string): string | null {
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    // Undecodable, and already refused before this by `describeTransaction`.
    // Reported as forbidden anyway rather than permitted: this function must
    // never be the reason something gets through.
    return "an envelope Pocket could not read";
  }
  if (tx instanceof FeeBumpTransaction) return "a fee-bump transaction";

  for (const op of tx.operations) {
    if (op.type !== "invokeHostFunction") continue;
    const fn = op.func;
    // Anything that is not a plain contract call is not a thing a website gets
    // to do as you at all: the other two host-function variants DEPLOY code
    // and UPLOAD wasm, neither of which has a consent screen or a reason to.
    if (fn.switch().name !== "hostFunctionTypeInvokeContract") {
      return "deploying or uploading contract code";
    }
    // A Soroban function name is a Symbol, which the XDR layer hands over as
    // bytes rather than a string.
    const name = Buffer.from(fn.invokeContract().functionName()).toString();
    if (!isDappPermittedMethod(name)) return name;
  }
  return null;
}
