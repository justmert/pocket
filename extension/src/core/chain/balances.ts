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
  if (!m) throw new InvalidAmountError(`That is not an amount Pocket can read: ${text}`);
  const [, sign, whole, frac = ""] = m;
  if (frac.length > 7) {
    throw new InvalidAmountError(`Amounts go to 7 decimal places and that has more: ${text}`);
  }
  const raw = BigInt(whole as string) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, "0") || "0");
  return sign === "-" ? -raw : raw;
}
