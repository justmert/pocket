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
import type { xdr } from "@stellar/stellar-sdk/base";
import type { Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk/base";

export type SubmitOutcome =
  | { kind: "rejected"; hash: string; reason: string }
  /** The RPC did not queue it. Consumes no sequence and costs no fee: retry now. */
  | { kind: "notAccepted"; hash: string }
  | { kind: "pending"; hash: string }
  | {
      kind: "succeeded";
      hash: string;
      ledger: number;
      applicationOrder: number;
      /**
       * What the invoked function returned, when there was one.
       *
       * Needed because the auditor registry ALLOCATES an id and returns it:
       * the caller cannot know it in advance and must read it from the
       * result, or it registers a key it can never name.
       */
      returnValue?: xdr.ScVal;
    }
  | { kind: "failed"; hash: string; ledger: number; reason: string }
  | { kind: "expired"; hash: string };

/** Seconds a transaction stays valid. Short enough that expiry is decidable soon. */
export const DEFAULT_TIMEOUT_SECONDS = 180;

/**
 * A terminal outcome that is not success, phrased for the user.
 *
 * Named so `describeError`'s allowlist passes the message through. Without a
 * name on that list every one of these becomes "Something went wrong. Try
 * again, and check your connection.", which is the one instruction that must
 * never follow an unresolved submission: it invites the resend this whole
 * module exists to prevent.
 */
export class SubmitOutcomeError extends Error {
  override readonly name = "SubmitOutcomeError";
  constructor(
    message: string,
    readonly outcome: SubmitOutcome,
  ) {
    super(message);
  }
}

/**
 * Every terminal outcome said plainly, including what it cost.
 *
 * Lives beside the taxonomy it describes so the two cannot drift. The only
 * interpolated values are XDR enum discriminant names and our own hash, both
 * from closed sets, so nothing an RPC authored can reach a user through here.
 */
export function describeOutcome(outcome: SubmitOutcome): string {
  switch (outcome.kind) {
    case "succeeded":
      return "The transaction succeeded.";
    case "failed":
      return (
        `The transaction was included but failed on chain (${outcome.reason}). ` +
        `A fee was charged and the sequence number was used.`
      );
    case "rejected":
      return `The network rejected it (${outcome.reason}). Nothing was charged.`;
    case "notAccepted":
      // TRY_AGAIN_LATER is core saying it cannot process this submission right
      // now, commonly because another transaction from the same source account
      // is still in its queue. The docs say to wait before resubmitting, so
      // "try again now" would be wrong advice as well as a wasted attempt.
      return (
        "The network could not take it just now, so nothing was charged and no sequence " +
        "number was used. Wait a few seconds, then try again."
      );
    case "expired":
      return (
        "Its time window passed before it was included, so it can never be applied now. " +
        "Nothing was charged. Build it again."
      );
    case "pending":
      return (
        `It has not confirmed yet. It may still land, so do not resend: ` +
        `check the hash ${outcome.hash} before trying again.`
      );
  }
}

/** Notified before submission and on every terminal outcome, so a caller can persist. */
export interface InFlightSink {
  record(entry: { hash: string; maxTime: number }): Promise<void>;
  clear(hash: string): Promise<void>;
}

/**
 * Submit, then poll to a terminal state.
 *
 * `tx` must already carry timeBounds; without them expiry is undecidable and a
 * stuck transaction can never be safely rebuilt.
 */
export async function submitAndConfirm(
  server: rpc.Server,
  tx: Transaction | FeeBumpTransaction,
  opts: { attempts?: number; sleepMs?: number; inFlight?: InFlightSink } = {},
): Promise<SubmitOutcome> {
  const hash = tx.hash().toString("hex");
  const maxTime = "timeBounds" in tx ? Number(tx.timeBounds?.maxTime ?? 0) : 0;

  // Recorded BEFORE submission. If the worker dies between here and the reply,
  // the hash is still on disk and can be polled rather than blindly resent.
  await opts.inFlight?.record({ hash, maxTime });

  let sent: rpc.Api.SendTransactionResponse;
  try {
    sent = await server.sendTransaction(tx);
  } catch {
    // The request failed in transit, so whether the envelope reached the
    // network is UNKNOWABLE from here. Concluding "it did not go" is the
    // expensive guess: the user is told to try again and pays twice if it did.
    // The hash is computable locally, so ask the ledger instead of guessing.
    return afterSend(server, hash, maxTime, opts);
  }

  if (sent.status === "ERROR") {
    await opts.inFlight?.clear(hash);
    return { kind: "rejected", hash, reason: describeSendError(sent) };
  }
  if (sent.status === "TRY_AGAIN_LATER") {
    await opts.inFlight?.clear(hash);
    // The RPC declined to queue it at all. Nothing was consumed, so this is
    // immediately and safely retryable. Reporting it as "pending" would strand
    // the caller for the whole timeBounds window on a transaction that never
    // entered the network.
    return { kind: "notAccepted", hash };
  }
  // PENDING and DUPLICATE both mean it is in the mempool. DUPLICATE is a
  // successful submit from our point of view: poll it rather than resubmitting.
  return afterSend(server, hash, maxTime, opts);
}

/** Poll to a terminal state and settle the in-flight record. */
async function afterSend(
  server: rpc.Server,
  hash: string,
  maxTime: number,
  opts: { attempts?: number; sleepMs?: number; inFlight?: InFlightSink },
): Promise<SubmitOutcome> {
  const outcome = await pollToTerminal(server, hash, opts);
  if (outcome.kind !== "pending") {
    await opts.inFlight?.clear(hash);
    return outcome;
  }
  // Still not included. Once maxTime has passed the envelope can never apply,
  // so it becomes safe to rebuild; until then the caller must not resend.
  if (maxTime > 0 && Math.floor(Date.now() / 1000) > maxTime) {
    await opts.inFlight?.clear(hash);
    return { kind: "expired", hash };
  }
  return outcome;
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
    try {
      const res = await server.getTransaction(hash);
      if (res.status === "SUCCESS") {
        return {
          kind: "succeeded",
          hash,
          ledger: res.ledger,
          applicationOrder: (res as { applicationOrder?: number }).applicationOrder ?? 0,
          returnValue: (res as { returnValue?: xdr.ScVal }).returnValue,
        };
      }
      if (res.status === "FAILED") {
        return { kind: "failed", hash, ledger: res.ledger, reason: describeFailure(res) };
      }
    } catch {
      // A poll that never reached the RPC says nothing about the transaction.
      // Aborting here reported a transaction that had already landed as a flat
      // failure, and the user's obvious next move is to send it again. Keep
      // asking; if no attempt ever gets an answer the loop ends in "pending",
      // which is the honest "we do not know, do not resend".
    }
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, sleepMs));
  }
  // Still NOT_FOUND, or never answered. The caller must check timeBounds before
  // deciding whether this is "expired, safe to rebuild" or "still in flight".
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
