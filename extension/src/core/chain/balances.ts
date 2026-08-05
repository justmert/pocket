// Reading public-pocket balances.
//
// For a G-address the classic trustline balance and the SAC contract balance
// are the SAME LEDGER ENTRY, addressed by a byte-identical LedgerKey. They
// cannot diverge, because the SAC dispatches on address type: an Account reads
// the AccountEntry or TrustLineEntry, a Contract reads its own ContractData.
// An address is one or the other, never both. So the public pocket needs one
// balance model, not two.
//
// We read via RPC getLedgerEntries rather than Horizon: same latency in
// practice, and it keeps us on one service, since Soroban already requires RPC.
import { Asset, StrKey, xdr } from "@stellar/stellar-sdk/base";
import type { rpc } from "@stellar/stellar-sdk";

/** Stroops per unit. Stellar uses 7 decimals throughout. */
export const STROOPS_PER_UNIT = 10_000_000n;

export interface AssetBalance {
  /** Canonical id: "native" or "CODE:ISSUER". */
  id: string;
  code: string;
  issuer?: string;
  /** Raw stroops. Amounts stay integral end to end; formatting is a display concern. */
  raw: bigint;
  /** Trustline limit in stroops, absent for native. */
  limit?: bigint;
  /**
   * Stroops already committed to open offers, which cannot be sent.
   *
   * The protocol enforces this the same way it enforces the reserve: a payment
   * that dips into selling liabilities fails with `txINSUFFICIENT_BALANCE`, and
   * the raw balance gives no hint of it. Pocket creates no offers itself, which
   * is exactly why this was easy to leave out and easy to get wrong: the same
   * G-address can hold offers made in any other wallet, and then Pocket's
   * "spendable" is simply too big.
   */
  sellingLiabilities: bigint;
  /** False when the issuer has not authorised this trustline. */
  authorized: boolean;
}

/** Account not yet created on chain. Distinct from an account with zero balance. */
export class AccountNotFoundError extends Error {
  /**
   * `accountId` is an ADDRESS, and the default message interpolates it.
   *
   * Four call sites passed a whole sentence as the id, which produced
   * "account Could not read this account's assets. Try again. does not exist on
   * this network" and put it in front of a user, because this name is on
   * `describeError`'s allowlist and its message is passed through verbatim.
   *
   * So a caller with something better to say now says it explicitly, and the
   * default stays what it was for the caller that really does have an address.
   */
  constructor(
    public readonly accountId: string,
    message?: string,
  ) {
    super(message ?? `account ${accountId} does not exist on this network`);
    this.name = "AccountNotFoundError";
  }
}

/**
 * The ledger answered with an entry that is not the one we asked about.
 *
 * Not on `describeError`'s allowlist on purpose: the user gets the generic
 * message, because the specific one would only tell them their RPC is lying,
 * which they cannot act on. What matters is that no number is rendered.
 */
/**
 * An amount the user can correct.
 *
 * Named because `describeError` allowlists by NAME, and a bare Error here
 * reached the user as "check your connection" for a comma they typed. No
 * amount of retrying fixes a comma.
 */
export class InvalidAmountError extends Error {
  override readonly name = "InvalidAmountError";
}

export class LedgerEntryMismatchError extends Error {
  override readonly name = "LedgerEntryMismatchError";
}

const accountKey = (accountId: string): xdr.LedgerKey =>
  xdr.LedgerKey.account(
    new xdr.LedgerKeyAccount({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId)),
    }),
  );

const trustlineKey = (accountId: string, asset: Asset): xdr.LedgerKey =>
  xdr.LedgerKey.trustline(
    new xdr.LedgerKeyTrustLine({
      accountId: xdr.PublicKey.publicKeyTypeEd25519(StrKey.decodeEd25519PublicKey(accountId)),
      asset: asset.toTrustLineXDRObject(),
    }),
  );

/**
 * Look up one ledger entry, distinguishing "it is not there" from "you were not
 * answered". Null means genuinely absent; anything else raises.
 *
 * This reads the RAW response rather than the SDK's parsed one, and that is the
 * whole point. `parseRawLedgerEntries` does `(raw.entries ?? []).map(...)`, so a
 * reply carrying NO `entries` field at all arrives as an empty array,
 * byte-identical to "this account does not exist". Downstream that becomes a
 * confident 0.0000000 on a funded wallet. The SDK's own type admits the shape:
 * `RawGetLedgerEntriesResponse.entries` is optional while the parsed
 * `GetLedgerEntriesResponse.entries` is not.
 *
 * Verified against live testnet: a genuinely absent account replies with an
 * explicit `entries: []`, so the distinction is real and is only lost in the
 * parser.
 *
 * The raw entry also echoes the key that was looked up, which is a stricter
 * identity check than re-deriving the address from the decoded entry: XDR
 * encoding is canonical, so a byte comparison covers the account, the asset and
 * the entry type at once. Confirmed byte-exact against live testnet.
 */
async function readEntry(
  server: rpc.Server,
  key: xdr.LedgerKey,
): Promise<xdr.LedgerEntryData | null> {
  const res = await server._getLedgerEntries(key);
  if (!Array.isArray(res.entries)) {
    throw new LedgerEntryMismatchError(
      "the ledger did not answer the question: the response carried no entries field",
    );
  }
  const raw = res.entries[0];
  if (!raw) return null;
  if (typeof raw.xdr !== "string" || raw.key !== key.toXDR("base64")) {
    throw new LedgerEntryMismatchError(
      "the ledger answered about a different entry than the one asked about",
    );
  }
  return xdr.LedgerEntryData.fromXDR(raw.xdr, "base64");
}

/**
 * Native XLM balance, minus nothing: the raw AccountEntry balance. Callers
 * needing spendable XLM must subtract the reserve themselves, since the reserve
 * depends on subentry count.
 */
export async function readNative(
  server: rpc.Server,
  accountId: string,
): Promise<{
  raw: bigint;
  subEntryCount: number;
  numSponsoring: number;
  numSponsored: number;
  sellingLiabilities: bigint;
}> {
  const val = await readEntry(server, accountKey(accountId));
  // Only an explicit empty entries array reaches here as null, and that is the
  // one condition allowed to render a zero balance.
  if (!val) throw new AccountNotFoundError(accountId);
  if (val.switch().name !== "account") {
    throw new LedgerEntryMismatchError(`asked for an account entry, got ${val.switch().name}`);
  }
  const acc = val.account();
  // Belt and braces on top of the key echo. Cheap, and it catches an RPC that
  // echoes the right key beside the wrong body. Verified: before any of this,
  // readNative returned a stranger's 12345.6789 XLM without complaint.
  const returnedId = StrKey.encodeEd25519PublicKey(acc.accountId().ed25519());
  if (returnedId !== accountId) {
    throw new LedgerEntryMismatchError(
      `asked the ledger about ${accountId} and it answered about ${returnedId}`,
    );
  }
  const ext = acc.ext().v1();
  return {
    raw: BigInt(acc.balance().toString()),
    subEntryCount: acc.numSubEntries(),
    numSponsoring: ext ? (ext.ext().v2()?.numSponsoring() ?? 0) : 0,
    numSponsored: ext ? (ext.ext().v2()?.numSponsored() ?? 0) : 0,
    // The v1 extension was already being read, for sponsorship, and its
    // liabilities were stepped straight over. An account with an open offer
    // therefore reported the offer's stroops as spendable, and the protocol
    // refuses to send them.
    sellingLiabilities: ext ? BigInt(ext.liabilities().selling().toString()) : 0n,
  };
}

/** Read one credit-asset trustline. Returns null when no trustline exists. */
export async function readTrustline(
  server: rpc.Server,
  accountId: string,
  asset: Asset,
): Promise<AssetBalance | null> {
  const val = await readEntry(server, trustlineKey(accountId, asset));
  if (!val) return null;
  if (val.switch().name !== "trustline") {
    throw new LedgerEntryMismatchError(`asked for a trustline entry, got ${val.switch().name}`);
  }
  const tl = val.trustLine();
  // Same reasoning as readNative: check the answer is about the question. A
  // trustline is (account, asset), so both halves have to match or the balance
  // shown belongs to a different holder or a different asset.
  const holder = StrKey.encodeEd25519PublicKey(tl.accountId().ed25519());
  if (holder !== accountId) {
    throw new LedgerEntryMismatchError(
      `asked the ledger about ${accountId} and it answered about ${holder}`,
    );
  }
  if (tl.asset().toXDR("base64") !== asset.toTrustLineXDRObject().toXDR("base64")) {
    throw new LedgerEntryMismatchError(`asked about ${asset.getCode()} and got another asset`);
  }
  const ext = tl.ext().v1();
  return {
    id: `${asset.getCode()}:${asset.getIssuer()}`,
    code: asset.getCode(),
    issuer: asset.getIssuer(),
    raw: BigInt(tl.balance().toString()),
    limit: BigInt(tl.limit().toString()),
    // Same omission as the account entry, same consequence. A trustline holding
    // an open sell offer reported the whole balance as spendable.
    sellingLiabilities: ext ? BigInt(ext.liabilities().selling().toString()) : 0n,
    // Bit 0 of the trustline flags is AUTHORIZED_FLAG.
    authorized: (tl.flags() & 1) === 1,
  };
}

/**
 * Minimum balance in stroops. (2 + subentries + sponsoring - sponsored) * baseReserve.
 * Reserve is a network parameter, so it is passed in rather than assumed.
 */
export function minimumBalance(
  account: { subEntryCount: number; numSponsoring: number; numSponsored: number },
  baseReserveStroops: bigint,
): bigint {
  const entries =
    2n +
    BigInt(account.subEntryCount) +
    BigInt(account.numSponsoring) -
    BigInt(account.numSponsored);
  return entries * baseReserveStroops;
}

/** Format stroops for display. Never used for arithmetic. */
export function formatAmount(raw: bigint, decimals = 7): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 7) {
    throw new Error(`decimals must be an integer in [0, 7], got ${decimals}`);
  }
  const neg = raw < 0n;
  const abs = neg ? -raw : raw;
  const whole = abs / STROOPS_PER_UNIT;
  const frac = (abs % STROOPS_PER_UNIT).toString().padStart(7, "0").slice(0, decimals);
  const body = decimals > 0 ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${body}` : body;
}

/** Parse a decimal string into stroops. Rejects excess precision rather than rounding. */
export function parseAmount(text: string): bigint {
  // The whole part is OPTIONAL, so ".5" parses as 0.5.
  //
  // It required at least one digit before the point, and a keypad that offers
  // "." as its own key invites exactly that: the wallet answered "That is not
  // an amount Pocket can read. Use digits and at most one decimal point" about
  // a string that is digits and one decimal point. Nothing downstream cares:
  // this returns stroops either way.
  //
  // "." and "-" alone are still refused, which is what the digit count below
  // enforces: the point is to accept a shorthand, not to accept nothing.
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(text.trim());
  // The message is authored and interpolates NOTHING. Allowlisting a name puts
  // the whole message on screen, so echoing `text` back rendered 100,039
  // characters of whatever was typed into a 360px popup. Repeating the typo is
  // useless anyway: it is still in the field the user is looking at.
  if (!m) {
    throw new InvalidAmountError(
      "That is not an amount Pocket can read. Use digits and at most one decimal point.",
    );
  }
  const [, sign, whole = "", frac = ""] = m;
  if (whole.length + frac.length === 0) {
    throw new InvalidAmountError(
      "That is not an amount Pocket can read. Use digits and at most one decimal point.",
    );
  }
  if (frac.length > 7) {
    throw new InvalidAmountError("Amounts go to 7 decimal places and that has more.");
  }
  const raw = BigInt(whole || "0") * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, "0") || "0");
  return sign === "-" ? -raw : raw;
}

/**
 * A fraction of an amount, exactly.
 *
 * Integer arithmetic on stroops from end to end. The obvious implementation,
 * `Number(text) * 0.25`, is wrong in a way that is invisible for small balances
 * and real for large ones, and it would put a float back into the value path
 * that everything else here exists to keep out.
 *
 * Truncates rather than rounds. A quarter of an odd number of stroops has to
 * lose something, and losing it is safe: rounding UP would offer to send a
 * stroop the account does not have, which fails at submit time with an opaque
 * error nobody could act on.
 */
export function fractionOf(text: string, numerator: bigint, denominator: bigint): string {
  if (denominator <= 0n) throw new InvalidAmountError("That is not a fraction Pocket can use.");
  const total = parseAmount(text);
  if (total <= 0n) return formatAmount(0n);
  return formatAmount((total * numerator) / denominator);
}

/**
 * What can actually leave the account, for ANY asset.
 *
 * One function because the answer was being computed in several places and each
 * one knew about a different subset of the deductions. The protocol takes all
 * of them, and a figure missing any one is a number the wallet will offer, the
 * user will accept, and the network will refuse.
 *
 * `reserve` is the base reserve times the entry count and applies to the native
 * balance only: a trustline balance is not reserved against. `sellingLiabilities`
 * applies to both. The fee is NOT taken here, because it is paid in XLM
 * regardless of which asset is moving, so it belongs to the caller that knows
 * which asset that is.
 *
 * Never negative: an account below its own reserve is at zero spendable, not in
 * debt to itself.
 */
export function availableToSend(balance: {
  raw: bigint;
  sellingLiabilities: bigint;
  reserve?: bigint;
}): bigint {
  const out = balance.raw - balance.sellingLiabilities - (balance.reserve ?? 0n);
  return out > 0n ? out : 0n;
}

/**
 * What to hold back for the fee of a SOROBAN operation, in stroops.
 *
 * `BASE_FEE` is 100 stroops and pays for a classic payment. A Soroban
 * invocation pays that plus a resource fee, which is decided by simulation and
 * is three to four orders of magnitude larger: measured on this deployment,
 * ~179,000 stroops for a swap and 350,412 for a native shield.
 *
 * "Use max" on the swap, yield, shield and unshield screens reserved 100
 * stroops, so it produced an amount that left nothing for the real fee. The
 * user pressed the button the wallet offered and the transaction could not be
 * paid for.
 *
 * The screens cannot simulate, so this is a RESERVE, not a prediction: rounded
 * up well past the largest figure measured, because reserving too much costs a
 * fraction of an XLM that stays in the account, and reserving too little costs
 * a failed transaction. The worker re-checks against the real fee once
 * simulation has produced one, so this only has to be close enough to keep
 * "use max" honest.
 */
export const SOROBAN_FEE_RESERVE_STROOPS = 5_000_000n; // 0.5 XLM

/**
 * XLM to keep back for the SECOND leg of a two-leg bridge.
 *
 * A CCTP send is an approve and then a burn. The burn is built at confirm time,
 * against the sequence the approve consumed and the allowance it created, so it
 * cannot be simulated before the approve exists and its fee cannot be quoted.
 * That left a real gap: an account with just enough XLM for the approve was
 * allowed through, paid for it, and then lost the burn for want of a fee, with
 * a standing allowance left over and no way to resume.
 *
 * A RESERVE rather than a prediction, and sized from the ledger:
 * `deposit_for_burn` fees measured on testnet were 32,559, 32,557 and 51,228
 * stroops (txs fa4fc0cb, f249c20d, a5f34762). 200,000 is close to four times
 * the largest of those, which costs 0.02 XLM of headroom in the account and
 * buys the difference between a bridge that completes and one that strands.
 *
 * Deliberately much smaller than the 0.5 XLM screen reserve above: that one
 * guards an unsimulated amount the user typed, this one guards a single known
 * invocation whose cost has been measured three times.
 */
export const CCTP_BURN_FEE_RESERVE_STROOPS = 200_000n; // 0.02 XLM

/**
 * The most that can actually be SENT of the native asset, once the fee is paid.
 *
 * "Use max" that produces a transaction the account cannot afford is worse than
 * no button at all: it fails after the review step, on a screen that has already
 * told someone the amount is fine. The spendable figure already excludes the
 * protocol reserve; this takes off the fee as well.
 *
 * `feeStroops` is the fee the transaction will actually carry, so this stays
 * correct if the wallet ever pays more than base fee.
 */
export function sendableAfterFee(text: string, feeStroops: bigint): string {
  const total = parseAmount(text);
  const left = total - feeStroops;
  return formatAmount(left > 0n ? left : 0n);
}

/**
 * cap a decimal amount to at most `places` fraction digits, TRUNCATING rather
 * than rounding: a value derived for "use max" or a slider must never be nudged
 * ABOVE what is spendable, so the extra digits are dropped, not rounded. this is
 * a compose-screen nicety (four places reads cleaner than seven); the amount is
 * still a decimal string, and the worker parses the full thing to stroops. pure
 * string work, no float.
 */
export function capDecimals(value: string, places: number): string {
  const dot = value.indexOf(".");
  if (dot < 0) return value;
  return value
    .slice(0, dot + 1 + places)
    .replace(/0+$/, "")
    .replace(/\.$/, "");
}

/**
 * an amount to put IN the compose field, shortened for readability but never
 * shortened to nothing.
 *
 * Four fraction digits reads better than Stellar's seven, and truncating (never
 * rounding) is what keeps "use max" from offering more than is spendable. But
 * the whole of a small balance can live below the fourth place: pressing Use max
 * on 0.00009 XLM truncated to the string "0" and filled the field with zero,
 * with Continue still live, so the one control whose job is "send everything"
 * answered "send nothing".
 *
 * So the cap is a PREFERENCE, not a rule. When applying it would erase a nonzero
 * value the field keeps the exact amount instead, which is longer and correct.
 * Still truncation, never rounding: the returned string is either the capped
 * value or the input unchanged, and both are <= the input.
 */
export function composeAmount(value: string, places: number): string {
  const capped = capDecimals(value, places);
  if (/[1-9]/.test(value) && !/[1-9]/.test(capped)) return value;
  return capped;
}

/**
 * an amount for DISPLAY: shortened the same way, but never shown as zero when it
 * is not zero.
 *
 * `capDecimals` truncates, which is right for the value paths it was written for
 * and wrong for a screen. Stellar carries seven decimals and the display cap is
 * four, so every amount smaller than 0.0001 truncated to the string "0", and a
 * history row would state that an account received 0 XLM from somebody. That is
 * not a rounding artefact, it is the screen asserting nothing moved when
 * something did, and the row offers no way to find out otherwise.
 *
 * Separate from `capDecimals` rather than folded into it, deliberately: that
 * function feeds "use max" and the slider, where a value must never be nudged
 * ABOVE what is spendable, and "<0.0001" is not a number those can submit.
 */
export function displayAmount(value: string, places = 4): string {
  const capped = capDecimals(value, places);
  // A significant digit before the cap and none after it: the whole value lies
  // below what this many places can express.
  if (/[1-9]/.test(value) && !/[1-9]/.test(capped)) {
    return `<0.${"0".repeat(Math.max(0, places - 1))}1`;
  }
  return capped;
}
