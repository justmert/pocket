// Building classic payments.
//
// A classic PaymentOp and a SAC `transfer` mutate the identical ledger entry
// for a G-address (see balances.ts), so the choice is about cost and tooling,
// not semantics. Classic is cheaper and needs no Soroban resources, so it is
// the default; the SAC path exists for paying a contract address.
import {
  Account,
  Asset,
  BASE_FEE,
  Memo,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk/base";
import { InvalidAmountError } from "./balances";
import { DEFAULT_TIMEOUT_SECONDS } from "./submit";
import { formatAmount } from "./balances";

export interface PaymentRequest {
  from: string;
  to: string;
  asset: Asset;
  /** Stroops. Never a float. */
  amount: bigint;
  memo?: string;
  /** Inclusion fee per operation, in stroops. */
  feeStroops?: string;
}

/**
 * Build an unsigned payment. Always sets timeBounds: without them expiry is
 * undecidable, so a transaction that never confirms can never be safely
 * rebuilt (see submit.ts).
 */
/** Stellar's text memo limit, in bytes. Not characters. */
export const MEMO_TEXT_MAX_BYTES = 28;

/** A memo the user can shorten. Named so the reason survives describeError. */
export class MemoTooLongError extends Error {
  override readonly name = "MemoTooLongError";
}

export function buildPayment(
  sourceAccount: Account,
  req: PaymentRequest,
  networkPassphrase: string,
): Transaction {
  if (req.amount <= 0n) throw new InvalidAmountError("A payment has to be for more than zero.");

  const builder = new TransactionBuilder(sourceAccount, {
    fee: req.feeStroops ?? BASE_FEE,
    networkPassphrase,
  })
    .addOperation(
      Operation.payment({
        destination: req.to,
        asset: req.asset,
        // The SDK takes a decimal string; we hold stroops, so format at the
        // boundary rather than carrying a float anywhere.
        amount: formatAmount(req.amount),
      }),
    )
    .setTimeout(DEFAULT_TIMEOUT_SECONDS);

  if (req.memo) {
    // A text memo is 28 BYTES, not 28 characters, and the SDK enforces that
    // with a bare Error. Unnamed, it reaches the user as "check your
    // connection", which sends them to their network over a string they typed
    // and that no amount of retrying will fix. Ten emoji is 40 bytes and looks
    // far shorter than an English sentence that fits.
    const used = new TextEncoder().encode(req.memo).length;
    if (used > MEMO_TEXT_MAX_BYTES) {
      throw new MemoTooLongError(
        `That memo is ${used} bytes and the limit is ${MEMO_TEXT_MAX_BYTES}. The limit counts ` +
          `bytes rather than characters, so accents and emoji use several each.`,
      );
    }
    builder.addMemo(Memo.text(req.memo));
  }
  return builder.build();
}
