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
export function buildPayment(
  sourceAccount: Account,
  req: PaymentRequest,
  networkPassphrase: string,
): Transaction {
  if (req.amount <= 0n) throw new Error("payment amount must be positive");

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

  if (req.memo) builder.addMemo(Memo.text(req.memo));
  return builder.build();
}
