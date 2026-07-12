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
  /** False when the issuer has not authorised this trustline. */
  authorized: boolean;
}

/** Account not yet created on chain. Distinct from an account with zero balance. */
export class AccountNotFoundError extends Error {
  constructor(public readonly accountId: string) {
    super(`account ${accountId} does not exist on this network`);
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
): Promise<{ raw: bigint; subEntryCount: number; numSponsoring: number; numSponsored: number }> {
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
  return {
    id: `${asset.getCode()}:${asset.getIssuer()}`,
    code: asset.getCode(),
    issuer: asset.getIssuer(),
    raw: BigInt(tl.balance().toString()),
    limit: BigInt(tl.limit().toString()),
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
  const m = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text.trim());
  // The message is authored and interpolates NOTHING. Allowlisting a name puts
  // the whole message on screen, so echoing `text` back rendered 100,039
  // characters of whatever was typed into a 360px popup. Repeating the typo is
  // useless anyway: it is still in the field the user is looking at.
  if (!m) {
    throw new InvalidAmountError(
      "That is not an amount Pocket can read. Use digits and at most one decimal point.",
    );
  }
  const [, sign, whole, frac = ""] = m;
  if (frac.length > 7) {
    throw new InvalidAmountError("Amounts go to 7 decimal places and that has more.");
  }
  const raw = BigInt(whole as string) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, "0") || "0");
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
