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
 * Native XLM balance, minus nothing: the raw AccountEntry balance. Callers
 * needing spendable XLM must subtract the reserve themselves, since the reserve
 * depends on subentry count.
 */
export async function readNative(
  server: rpc.Server,
  accountId: string,
): Promise<{ raw: bigint; subEntryCount: number; numSponsoring: number; numSponsored: number }> {
  const res = await server.getLedgerEntries(accountKey(accountId));
  const entry = res.entries[0];
  if (!entry) throw new AccountNotFoundError(accountId);
  const acc = entry.val.account();
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
  const res = await server.getLedgerEntries(trustlineKey(accountId, asset));
  const entry = res.entries[0];
  if (!entry) return null;
  const tl = entry.val.trustLine();
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
  if (!m) throw new Error(`not a valid amount: ${text}`);
  const [, sign, whole, frac = ""] = m;
  if (frac.length > 7) {
    throw new Error(`amount has more than 7 decimal places: ${text}`);
  }
  const raw = BigInt(whole as string) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, "0") || "0");
  return sign === "-" ? -raw : raw;
}
