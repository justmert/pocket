// Turning a dApp's transaction into something a person can consent to.
//
// This is the whole reason signing for sites was refused until now. A wallet
// that signs bytes it cannot describe is asking the user to approve a hash,
// which is not consent, and §14.7 forbids it outright. So the rule here is
// simple and absolute: if this module cannot say what a transaction does, the
// approval screen says so and the Approve button does not appear.
//
// It decodes rather than simulates. Simulation tells you what WOULD happen on
// the current ledger, which is useful and not what consent is about: the user
// is agreeing to the operations in the envelope, and those are in the bytes.
import { TransactionBuilder, Transaction, FeeBumpTransaction } from "@stellar/stellar-sdk/base";
import { formatAmount, parseAmount } from "../chain/balances";

export interface TxSummary {
  /** False when the envelope could not be decoded. The UI must refuse. */
  decoded: boolean;
  source: string;
  /** Total fee in stroops, as a decimal string. */
  fee: string;
  network: string;
  memo?: string;
  /** One line per operation, in the order they will apply. */
  effects: string[];
  /** Set when something about this envelope should stop the user. */
  warning?: string;
}

// The SDK's `Operation` namespace holds the per-type interfaces; the union of
// what a decoded transaction actually carries is `Transaction["operations"]`,
// which is what narrows correctly on `op.type`.
type DecodedOp = Transaction["operations"][number];

function describeOperation(op: DecodedOp, index: number): string {
  const n = `${index + 1}.`;
  switch (op.type) {
    case "payment":
      return `${n} Send ${op.amount} ${op.asset.isNative() ? "XLM" : op.asset.getCode()} to ${op.destination}`;
    case "createAccount":
      return `${n} Create account ${op.destination} funded with ${op.startingBalance} XLM`;
    case "changeTrust":
      return op.limit === "0"
        ? `${n} REMOVE the trustline for ${op.line.toString()}`
        : `${n} Trust ${op.line.toString()} up to ${op.limit ?? "the maximum"}`;
    case "invokeHostFunction":
      return `${n} Invoke a smart contract`;
    case "setOptions":
      // The dangerous one. Changing signers or thresholds can hand the account
      // away permanently, so it is never summarised as "set options".
      return `${n} CHANGE ACCOUNT SECURITY SETTINGS (signers, thresholds or home domain)`;
    case "accountMerge":
      return `${n} DESTROY this account and send everything to ${op.destination}`;
    case "pathPaymentStrictSend":
      return `${n} Send ${op.sendAmount} ${op.sendAsset.getCode()} converting to at least ${op.destMin} ${op.destAsset.getCode()} for ${op.destination}`;
    case "pathPaymentStrictReceive":
      return `${n} Send up to ${op.sendMax} ${op.sendAsset.getCode()} so ${op.destination} receives ${op.destAmount} ${op.destAsset.getCode()}`;
    default:
      // unreachable while DESCRIBED and this switch agree, which `describeTx`
      // enforces before ever calling here. kept as a total function rather than
      // a throw so a mismatch degrades to a refusal rather than a crash.
      return `${n} ${op.type}`;
  }
}

/**
 * every operation this file can put into words.
 *
 * anything outside it is refused, not summarised. the previous behaviour was to
 * fall through to the bare type name and still hand back `decoded: true`, so a
 * site could ask for a `createClaimableBalance` of the whole account balance to
 * an address of its choosing and the approval screen would show one line —
 * "1. createClaimableBalance" — with the amount and the beneficiary nowhere on
 * it, and an enabled Approve beneath. That is blind signing wearing the costume
 * of a description, and this file's own header says it must be impossible.
 *
 * the list is the switch above. adding a case means adding it here, and the
 * order of that pair is what keeps the refusal honest: an operation is
 * describable only once someone has written the sentence for it.
 */
const DESCRIBED = new Set([
  "payment",
  "createAccount",
  "changeTrust",
  "setOptions",
  "accountMerge",
  "pathPaymentStrictSend",
  "pathPaymentStrictReceive",
  "invokeHostFunction",
]);

/** Operations that hand away control and must be called out, not listed. */
const ALARMING = new Set(["setOptions", "accountMerge"]);

/**
 * Describe an envelope, or say plainly that it could not be described.
 *
 * Never throws. A malformed envelope from a hostile page is an expected input,
 * not an exception, and the caller needs a summary object either way so the UI
 * can render a refusal rather than a blank screen.
 */
export function describeTransaction(xdr: string, networkPassphrase: string): TxSummary {
  let tx: Transaction | FeeBumpTransaction;
  try {
    tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch {
    return {
      decoded: false,
      source: "",
      fee: "0",
      network: networkPassphrase,
      effects: [],
      warning: "Pocket could not read this transaction, so it will not offer to sign it.",
    };
  }

  if (tx instanceof FeeBumpTransaction) {
    // A fee bump wraps someone else's transaction. Signing one means paying
    // for an envelope whose contents are a separate question, so it is
    // refused rather than summarised as though the inner operations were ours.
    return {
      decoded: false,
      source: tx.feeSource,
      fee: tx.fee,
      network: networkPassphrase,
      effects: [],
      warning: "This is a fee-bump transaction. Pocket does not sign these for sites.",
    };
  }

  // an operation nobody has written a sentence for cannot be consented to, so
  // the envelope is refused whole rather than partly described. refusing whole
  // is deliberate: a list where four lines are real and the fifth is a type name
  // reads as a complete description, and the one line that is not is the one
  // carrying the operation nobody reviewed.
  const undescribable = tx.operations.filter((o) => !DESCRIBED.has(o.type));
  if (undescribable.length > 0) {
    const names = [...new Set(undescribable.map((o) => o.type))].join(", ");
    return {
      decoded: false,
      source: tx.source,
      fee: tx.fee,
      network: networkPassphrase,
      effects: [],
      warning:
        `This transaction contains an operation Pocket cannot describe (${names}), ` +
        "so it will not offer to sign it. Nothing has been sent.",
    };
  }

  const effects = tx.operations.map(describeOperation);
  const alarming = tx.operations.some((o) => ALARMING.has(o.type));

  return {
    decoded: true,
    source: tx.source,
    fee: tx.fee,
    network: networkPassphrase,
    memo: tx.memo?.value ? String(tx.memo.value) : undefined,
    effects,
    warning: alarming
      ? "This transaction changes who controls the account. Only approve it if you are certain."
      : undefined,
  };
}

/** Total XLM leaving the account, for the headline figure. Native payments only. */
export function outgoingNative(xdr: string, networkPassphrase: string, source: string): string {
  try {
    const tx = TransactionBuilder.fromXDR(xdr, networkPassphrase);
    if (tx instanceof FeeBumpTransaction) return "0";
    let total = 0n;
    for (const op of tx.operations) {
      if (op.type === "payment" && op.asset.isNative() && tx.source === source) {
        total += parseAmount(op.amount);
      }
      if (op.type === "createAccount") total += parseAmount(op.startingBalance);
    }
    return formatAmount(total);
  } catch {
    return "0";
  }
}
