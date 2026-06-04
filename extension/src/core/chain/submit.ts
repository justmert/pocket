// Transaction submission and confirmation.
//
// Five distinguishable outcomes, and conflating any two of them loses money or
// double-spends:
//
//   rejected at submission  never included, no fee, sequence NOT consumed
//   not yet included        keep polling
//   included and succeeded  done
//   included and FAILED     fee charged, sequence CONSUMED, no state change
//   expired                 maxTime passed, can never apply, safe to rebuild
//
// The idempotency rule: never blind-resubmit after a timeout. The hash is
// computable locally before submission, so poll by hash first. Rebuilding is
// only safe once timeBounds has expired, which is what makes timeBounds
// mandatory rather than optional.
import type { rpc } from "@stellar/stellar-sdk";
import type { Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk/base";

export type SubmitOutcome =
  | { kind: "rejected"; hash: string; reason: string }
  | { kind: "pending"; hash: string }
  | { kind: "succeeded"; hash: string; ledger: number; applicationOrder: number }
  | { kind: "failed"; hash: string; ledger: number; reason: string }
  | { kind: "expired"; hash: string };

/** Seconds a transaction stays valid. Short enough that expiry is decidable soon. */
export const DEFAULT_TIMEOUT_SECONDS = 180;

/**
 * Submit, then poll to a terminal state.
 *
 * `tx` must already carry timeBounds; without them expiry is undecidable and a
 * stuck transaction can never be safely rebuilt.
 */
export async function submitAndConfirm(
  server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
  opts: { attempts?: number; sleepMs?: number } = {},
): Promise<SubmitOutcome> {
  const hash = tx.hash().toString("hex");
  const sent = await server.sendTransaction(tx);

  if (sent.status === "ERROR") {
    return { kind: "rejected", hash, reason: describeSendError(sent) };
  }
  // DUPLICATE means it is already in the mempool, which is a successful submit
  // from our point of view: poll it rather than resubmitting.
  if (sent.status === "TRY_AGAIN_LATER") {
    return { kind: "pending", hash };
  }

  return pollToTerminal(server, hash, opts);
}

/**
 * Poll an already-submitted hash. Safe to call after a crash or a worker
 * restart, which is exactly why submission and polling are separable.
 */
export async function pollToTerminal(
  server: rpc.Server,
  hash: string,
  opts: { attempts?: number; sleepMs?: number } = {},
): Promise<SubmitOutcome> {
  const attempts = opts.attempts ?? 15;
  const sleepMs = opts.sleepMs ?? 1000;

  for (let i = 0; i < attempts; i++) {
    const res = await server.getTransaction(hash);
    if (res.status === "SUCCESS") {
      return {
        kind: "succeeded",
        hash,
        ledger: res.ledger,
        applicationOrder: (res as { applicationOrder?: number }).applicationOrder ?? 0,
      };
    }
    if (res.status === "FAILED") {
      return { kind: "failed", hash, ledger: res.ledger, reason: describeFailure(res) };
    }
    await new Promise((r) => setTimeout(r, sleepMs));
  }
  // Still NOT_FOUND. The caller must check timeBounds before deciding whether
  // this is "expired, safe to rebuild" or "still in flight, do not touch".
  return { kind: "pending", hash };
}

/** True once maxTime has passed, meaning the envelope can never be applied. */
export function hasExpired(tx: Transaction, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  const max = tx.timeBounds?.maxTime;
  if (!max || max === "0") return false; // no upper bound: never decidably expired
  return nowSeconds > Number(max);
}

function describeSendError(sent: rpc.Api.SendTransactionResponse): string {
  const r = sent.errorResult;
  if (!r) return "submission rejected";
  try {
    return r.result().switch().name;
  } catch {
    return "submission rejected";
  }
}

function describeFailure(res: rpc.Api.GetFailedTransactionResponse): string {
  try {
    return res.resultXdr.result().switch().name;
  } catch {
    return "transaction failed";
  }
}
