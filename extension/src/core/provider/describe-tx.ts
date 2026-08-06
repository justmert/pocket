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
import { formatAmount } from "../chain/balances";

export interface TxSummary {
  /** False when the envelope could not be decoded. The UI must refuse. */
  decoded: boolean;
  source: string;
  /** Total fee in stroops, as a decimal string. */
  fee: string;
  network: string;
  memo?: string;
  /**
   * WHICH memo, because the value alone does not say.
   *
   * `String(tx.memo.value)` is lossy in two directions, checked against the
   * repository's own installed `@stellar/stellar-sdk/base`: a `hash` or `return`
   * memo is raw bytes and decodes to replacement characters, and an `id` memo of
   * 12345 and a `text` memo of "12345" produce byte-identical strings. An
   * exchange asking for one kind and being sent the other loses the deposit, and
   * the approval screen could not tell the user which they were signing.
   */
  memoType?: "text" | "id" | "hash" | "return";
  /** One line per operation, in the order they will apply. */
  effects: string[];
  /** Set when something about this envelope should stop the user. */
  warning?: string;
}

// The SDK's `Operation` namespace holds the per-type interfaces; the union of
// what a decoded transaction actually carries is `Transaction["operations"]`,
// which is what narrows correctly on `op.type`.
type DecodedOp = Transaction["operations"][number];

/**
 * A memo's kind, in the four names Stellar uses.
 *
 * The SDK's `memo.type` is one of `MemoText | MemoID | MemoHash | MemoReturn |
 * MemoNone`; anything else (including none) is simply absent.
 */
function memoKind(memo: { type?: string } | null | undefined): TxSummary["memoType"] {
  switch (memo?.type) {
    case "text":
      return "text";
    case "id":
      return "id";
    case "hash":
      return "hash";
    case "return":
      return "return";
    default:
      return undefined;
  }
}

/**
 * A memo's value as text, or hex where it is not text.
 *
 * `hash` and `return` memos are 32 raw bytes; `String()` on them produced
 * replacement characters, so the one field a user is asked to check was
 * unreadable exactly where it is a machine-matched identifier.
 */
function memoText(memo: { type?: string; value?: unknown } | null | undefined): string | undefined {
  const v = memo?.value;
  if (v === undefined || v === null || v === "") return undefined;
  if (v instanceof Uint8Array || Buffer.isBuffer(v)) {
    // BY KIND, not by JavaScript type. The SDK stores a TEXT memo's value as a
    // Buffer as well, so hex-encoding every byte value turned "invoice 42" into
    // "696e766f696365203432" on the approval screen: the one field an exchange
    // tells you to match, rendered as something the user cannot compare.
    //
    // `hash` and `return` really are 32 opaque bytes and hex is their only
    // readable form; `String()` on them produced 32 replacement characters,
    // which is what this branch was written for.
    if (memo?.type === "text") return Buffer.from(v).toString("utf8");
    return Buffer.from(v).toString("hex");
  }
  return String(v);
}

/**
 * An asset as something a person can tell apart from an impostor.
 *
 * A CODE is not an identity. Anyone can issue an asset called USDC, and on the
 * approval screen a payment of the real one and a payment of a worthless
 * lookalike rendered as the same six characters. The issuer is the only thing
 * that distinguishes them, so it is printed, in full: this screen exists so a
 * user can tell what they are agreeing to, and truncating the one distinguishing
 * field would leave first-4-and-last-4 matching, which is about an hour of work
 * on a laptop.
 */
export function assetName(asset: {
  isNative(): boolean;
  getCode(): string;
  getIssuer(): string | undefined;
}): string {
  if (asset.isNative()) return "XLM";
  const issuer = asset.getIssuer();
  // A non-native asset always has an issuer, and the SDK still types it as
  // optional. Saying so is better than printing "undefined" beside a code, and
  // better than dropping the qualifier and reading like a known asset.
  return issuer
    ? `${asset.getCode()} (issued by ${issuer})`
    : `${asset.getCode()} (no issuer stated)`;
}

/**
 * Every field a setOptions actually sets, named.
 *
 * One operation can carry all of these at once, and each is a different way to
 * lose the account:
 *
 *   signer         adds, reweights or REMOVES (weight 0) a key that can sign
 *   masterWeight   0 disables the account's own key permanently
 *   thresholds     raise them past the available weight and the account is bricked
 *   homeDomain     redirects federation lookups for this address
 *   inflationDest  harmless today, still a signed change
 *   flags          set/clearFlags govern authorisation on an issuer
 *
 * The signer's KEY is printed in full and never truncated: this is the field
 * that hands the account away, and matching first-4 and last-4 is about an hour
 * of work on a laptop.
 */
export function describeSetOptions(op: {
  signer?: {
    ed25519PublicKey?: string;
    sha256Hash?: unknown;
    preAuthTx?: unknown;
    ed25519SignedPayload?: string;
    weight?: number;
  };
  masterWeight?: number;
  lowThreshold?: number;
  medThreshold?: number;
  highThreshold?: number;
  homeDomain?: string;
  inflationDest?: string;
  setFlags?: number;
  clearFlags?: number;
}): string {
  const parts: string[] = [];
  const s = op.signer;
  if (s) {
    const key =
      s.ed25519PublicKey ??
      s.ed25519SignedPayload ??
      (s.sha256Hash ? "a hash-x signer" : undefined) ??
      (s.preAuthTx ? "a pre-authorised transaction signer" : undefined) ??
      "a signer";
    parts.push(
      s.weight === 0
        ? `REMOVE the signer ${key}`
        : `ADD ${key} AS A SIGNER with weight ${s.weight ?? 0}`,
    );
  }
  if (op.masterWeight !== undefined) {
    parts.push(
      op.masterWeight === 0
        ? "DISABLE this account's own key permanently"
        : `Set this account's own key weight to ${op.masterWeight}`,
    );
  }
  for (const [label, v] of [
    ["low", op.lowThreshold],
    ["medium", op.medThreshold],
    ["high", op.highThreshold],
  ] as const) {
    if (v !== undefined) parts.push(`Set the ${label} threshold to ${v}`);
  }
  if (op.homeDomain !== undefined) {
    parts.push(
      op.homeDomain === "" ? "Clear the home domain" : `Set the home domain to ${op.homeDomain}`,
    );
  }
  if (op.inflationDest !== undefined)
    parts.push(`Set the inflation destination to ${op.inflationDest}`);
  if (op.setFlags !== undefined) parts.push(`Set account flags to ${op.setFlags}`);
  if (op.clearFlags !== undefined) parts.push(`Clear account flags ${op.clearFlags}`);
  // An operation that sets nothing is still a signed operation, and saying
  // "changes nothing" would be a claim this function cannot make about a shape
  // it did not recognise.
  if (parts.length === 0) return "CHANGE ACCOUNT SECURITY SETTINGS (unknown field)";
  return parts.join("; ");
}

function describeOperation(op: DecodedOp, index: number): string {
  const n = `${index + 1}.`;
  // an operation can carry its OWN source account, which overrides the
  // transaction's, and that was dropped: an operation spending from a different
  // account than the one the screen names is a different fact about who pays.
  // appended rather than woven into each sentence, so every case keeps its own
  // wording and none can forget it.
  const from = op.source ? ` (from ${op.source})` : "";
  return describeBody(op, n) + from;
}

/**
 * Is a changeTrust limit zero, whatever shape it arrived in?
 *
 * A limit is a decimal string, and a round trip through XDR renders zero as
 * "0.0000000" rather than "0". Comparing against the literal made the removal
 * branch dead code and described a removal as its opposite. Parsed rather than
 * string-matched, so "0", "0.0", "0.0000000" and "00" all read as zero and
 * nothing else does.
 */
function isZeroLimit(limit: string | undefined): boolean {
  if (limit === undefined) return false;
  return /^0*(\.0*)?$/.test(limit.trim());
}

function describeBody(op: DecodedOp, n: string): string {
  switch (op.type) {
    case "payment":
      return `${n} Send ${op.amount} ${assetName(op.asset)} to ${op.destination}`;
    case "createAccount":
      return `${n} Create account ${op.destination} funded with ${op.startingBalance} XLM`;
    case "changeTrust":
      // A limit of ZERO is a trustline REMOVAL, and this compared against the
      // string "0". After an XDR round trip the SDK hands back "0.0000000", so
      // the removal branch was unreachable and a removal was described as
      // "Trust USDC:G... up to 0.0000000": the opposite operation, on the
      // anti-blind-signing surface.
      return isZeroLimit(op.limit)
        ? `${n} REMOVE the trustline for ${op.line.toString()}`
        : `${n} Trust ${op.line.toString()} up to ${op.limit ?? "the maximum"}`;
    case "setOptions":
      // The dangerous one, and it read no argument at all.
      //
      // The sentence was a CONSTANT: "CHANGE ACCOUNT SECURITY SETTINGS
      // (signers, thresholds or home domain)". Measured side by side, adding an
      // attacker's key at weight 255 and setting a home domain produced the
      // IDENTICAL string, and the attacker's key appeared nowhere on screen.
      // That is blind signing with a caption, which is the exact thing
      // `DESCRIBED` exists to prevent: the rule is that the sentence gets
      // written first and the allowlist entry second.
      //
      // So every field is named. A setOptions can carry several at once and any
      // one of them can hand the account away, so they are listed rather than
      // summarised, and the strongest is not allowed to hide behind the mildest.
      // The SDK's decoded shape is wider than the fields named here (thresholds
      // and flags are optional numbers, the signer a union), so it is passed as
      // the reading this function does of it rather than cast wholesale.
      return `${n} ${describeSetOptions(op as Parameters<typeof describeSetOptions>[0])}`;
    case "accountMerge":
      return `${n} DESTROY this account and send everything to ${op.destination}`;
    case "pathPaymentStrictSend":
      return `${n} Send ${op.sendAmount} ${assetName(op.sendAsset)} converting to at least ${op.destMin} ${assetName(op.destAsset)} for ${op.destination}`;
    case "pathPaymentStrictReceive":
      return `${n} Send up to ${op.sendMax} ${assetName(op.sendAsset)} so ${op.destination} receives ${op.destAmount} ${assetName(op.destAsset)}`;
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
 * an address of its choosing and the approval screen would show one line,
 * "1. createClaimableBalance", with the amount and the beneficiary nowhere on
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
]);

/**
 * an operation with a refusal written for it, because the generic one would
 * misdescribe WHY.
 *
 * the generic refusal names the operation TYPE, which a user reasonably hears
 * as "this envelope is broken". it is not. the envelope is fine and the
 * limitation is ours, and a site hitting it needs to know that retrying or
 * re-encoding will not help.
 */
const REFUSED = new Map([
  ["invokeHostFunction", "Pocket cannot describe contract calls, so it will not sign this."],
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
      warning: "Unreadable transaction. Pocket will not sign it.",
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
      warning: "Pocket does not sign fee-bump transactions.",
    };
  }

  // an operation nobody has written a sentence for cannot be consented to, so
  // the envelope is refused whole rather than partly described. refusing whole
  // is deliberate: a list where four lines are real and the fifth is a type name
  // reads as a complete description, and the one line that is not is the one
  // carrying the operation nobody reviewed.
  //
  // `invokeHostFunction` was on the DESCRIBED list, and its whole sentence was
  // "Invoke a smart contract". No contract id, no function name, no arguments,
  // no value, and it was absent from ALARMING so nothing warned either. That is
  // the exact failure this list was added to close, reappearing on the one
  // operation that can do ANYTHING: transfer a token balance, set an approval,
  // upgrade a contract. A user reading that line has been told the operation's
  // TYPE and nothing about its effect, and Approve was live beneath it.
  //
  // Describing it properly is not a sentence, it is a feature: the effect lives
  // in ScVal arguments of arbitrary shape, and rendering some of them while
  // silently dropping the rest is the same costume worn one layer down. So it
  // is refused until that feature exists, which is what the pairing rule at
  // DESCRIBED already says: the sentence comes first, the entry second.
  const undescribable = tx.operations.filter((o) => !DESCRIBED.has(o.type));
  if (undescribable.length > 0) {
    const reasoned = undescribable.map((o) => REFUSED.get(o.type)).filter((r) => r !== undefined);
    if (reasoned.length > 0) {
      return {
        decoded: false,
        source: tx.source,
        fee: tx.fee,
        network: networkPassphrase,
        effects: [],
        // The first one. Listing several reasons for one refusal buries the
        // actionable sentence, and the envelope is refused whole regardless.
        warning: reasoned[0],
      };
    }
    const names = [...new Set(undescribable.map((o) => o.type))].join(", ");
    return {
      decoded: false,
      source: tx.source,
      fee: tx.fee,
      network: networkPassphrase,
      effects: [],
      warning: `Pocket cannot describe ${names}, so it will not sign this.`,
    };
  }

  const effects = tx.operations.map(describeOperation);
  const alarming = tx.operations.some((o) => ALARMING.has(o.type));
  // The FEE is the site's choice and nothing looked at it.
  //
  // A dApp composes the whole envelope, fee included, and the confirm screen
  // rendered it as an ordinary quiet fee row. A 100 XLM fee on a 1 XLM payment
  // is a real way to lose money to a site, it needs no unusual operation to
  // arrange, and it looked exactly like any other transaction. Measured: fee
  // 1,000,000,000 stroops, warning `undefined`.
  const steep = steepFee(tx.fee);

  return {
    decoded: true,
    source: tx.source,
    fee: tx.fee,
    network: networkPassphrase,
    memo: memoText(tx.memo),
    memoType: memoKind(tx.memo),
    effects,
    // Both can be true. The security one leads, because losing the account is
    // worse than overpaying, and the fee one still has to be said.
    warning:
      [alarming ? "This transaction changes who controls the account." : null, steep]
        .filter(Boolean)
        .join(" ") || undefined,
  };
}

/**
 * A fee far above anything this wallet's own operations cost, said plainly.
 *
 * Not a refusal: a legitimately expensive Soroban invocation exists, and a
 * wallet that refuses to describe one is a wallet that cannot be used. What
 * must not happen is a 100 XLM fee rendering as a quiet row beside a 1 XLM
 * payment.
 *
 * The threshold is measured, not guessed. The largest fee anything in this
 * product produces is a native shield at 350,412 stroops, and a classic payment
 * is 100. One XLM is 10,000,000 stroops: about 28x the largest real one, so a
 * legitimate envelope does not trip it and a punitive one cannot hide under it.
 */
function steepFee(fee: string): string | null {
  const STEEP_STROOPS = 10_000_000n;
  let stroops: bigint;
  try {
    stroops = BigInt(fee);
  } catch {
    // An unreadable fee is worth saying so about: it is a field the user is
    // being asked to accept.
    return "Unreadable network fee.";
  }
  if (stroops <= STEEP_STROOPS) return null;
  return `The site set a fee of ${formatAmount(stroops)} XLM, far above normal.`;
}
