// Turning a transaction the popup is watching into the settled row it becomes.
//
// Pure and on its own so the mapping can be tested: the popup has no DOM test
// environment, and this decides what a completed operation CLAIMS about the
// user's money.
import type { HistoryEntry } from "../../../core/messages";
import type { BgOp } from "./WalletProvider";

/**
 * The settled shape a watched operation becomes, keyed by the verb it was begun
 * with, or absent when the wallet has no single-sided word for it.
 *
 * This was a chain of `?:` ending in `: "send"`, so every verb nobody had
 * thought of was drawn as an outbound payment. That default was wrong the moment
 * the integrations landed: a yield deposit, a swap, a bridge, a claim and both
 * trustline operations all rendered as "Sent to " with nothing after it, because
 * none of them has a `to`. An open fallthrough on a closed vocabulary states
 * something false about the user's money rather than admitting it has no word.
 *
 * `direction` is here rather than derived, because the derived version disagreed
 * with the real entry this stands in for: it gave shield and unshield "self"
 * where core/private-history.ts gives "in" and "out", so the row changed shape
 * when the archive caught up.
 */
export const OP_SHAPE: Record<
  string,
  { kind: HistoryEntry["kind"]; direction: HistoryEntry["direction"] }
> = {
  Shield: { kind: "shield", direction: "in" },
  Unshield: { kind: "unshield", direction: "out" },
  "Send privately": { kind: "privateSend", direction: "out" },
  "Make spendable": { kind: "makeSpendable", direction: "self" },
  "Set up private pocket": { kind: "setup", direction: "self" },
  Send: { kind: "send", direction: "out" },
  // The input leg is the only side a watched swap knows: `beginOp` records what
  // was spent, and what arrives is not known until the ledger says so.
  Swap: { kind: "swap", direction: "out" },
};

/**
 * The worker sends a settled failure as a full sentence, and the outcome ones
 * carry the specific cause in parentheses: "...failed on chain (the destination
 * account does not exist yet). A fee was charged...". A row has room for the
 * cause, not the whole sentence, so this lifts the parenthetical out. Its shape
 * is fixed by outcome-wording.test.ts / rpc-submit.test.ts, so the match is
 * safe; a plain describeError string (no parenthetical) is returned unchanged,
 * and the detail sheet still shows the full sentence.
 */
export function conciseReason(full: string | undefined): string | undefined {
  if (!full) return undefined;
  const inParens = full.match(/\(([^)]+)\)/);
  return inParens ? inParens[1] : full;
}

/**
 * Whether a lifted reason is words a reader can act on rather than the raw XDR
 * discriminant it was lifted from.
 *
 * `OP_REASON` and `TX_REASON` translate the codes they know; anything they do
 * not know falls through as the code itself, and a row then read
 * "Failed · txBadSeq" beside a red alert badge. One word of the row is then the
 * word "Failed" twice and the rest is a symbol from a wire format.
 */
export function isPlainReason(reason: string | undefined): reason is string {
  return Boolean(reason && /\s/.test(reason));
}

/** a done watched op drawn as the settled row it is about to become, so a completed
 *  transaction looks completed at once instead of lingering as a processing card
 *  until the indexer catches up. reconciled away by hash the moment the real entry
 *  lands, so it is a stand-in, never a second copy.
 *
 *  null for a verb with no settled shape. Nothing is drawn for it and the real
 *  entry arrives on its own, which is strictly better than a row asserting an
 *  outbound payment that never happened. */
export function opToEntry(op: BgOp): HistoryEntry | null {
  const shape = OP_SHAPE[op.verb];
  if (!shape) return null;
  const { kind, direction } = shape;
  return {
    id: op.hash ?? op.id,
    pocket: op.pocket,
    kind,
    direction,
    code: op.code,
    amount: op.amount ?? null,
    counterparty: op.to,
    at: op.at,
    hash: op.hash ?? "",
    fee: op.fee,
    // a failed op that LANDED (has a hash: txFailed) becomes a failed row, so it
    // leaves "In progress" the way a done op does rather than hanging there.
    ...(op.status === "failed" ? { failed: true, failureReason: conciseReason(op.error) } : {}),
  };
}
