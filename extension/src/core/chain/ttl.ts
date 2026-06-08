// State archival and TTL. Spec 18.1, decision D12.
//
// Soroban persistent entries carry a TTL and are ARCHIVED when it lapses. The
// confidential account entry is persistent, and the library extends it to 30
// days on read-or-write, but only inside a SUBMITTED transaction: a simulated
// read bumps nothing.
//
// So an account that neither sends nor receives for 30 days is archived, and
// every subsequent operation fails until it is restored. That lands squarely on
// the saver persona: someone who shields and holds is exactly the user who
// archives on schedule. An account receiving regular payments is fine, because
// inbound transfers write to the receiving balance and bump the TTL.
//
// Never calibrate this on testnet. min_persistent_ttl is 120,960 ledgers on
// testnet against 2,073,600 on mainnet, roughly 7 days against 120.
import type { rpc } from "@stellar/stellar-sdk";
import { Address, xdr } from "@stellar/stellar-sdk/base";

/** Measured ledger close time. Testnet ~5.01s, mainnet ~5.57s. */
export const SECONDS_PER_LEDGER = { testnet: 5.01, mainnet: 5.57 } as const;

/** Bump when fewer than this many days remain, so a failure is never a surprise. */
export const KEEPALIVE_THRESHOLD_DAYS = 7;

export type TtlStatus =
  | { kind: "healthy"; expiresAt: Date; daysRemaining: number }
  /** Still live, but inside the keep-alive window. */
  | { kind: "expiring"; expiresAt: Date; daysRemaining: number }
  /** Archived. Recoverable, but every operation fails until it is restored. */
  | { kind: "archived" }
  /** No such entry: the account was never registered on this deployment. */
  | { kind: "absent" };

/**
 * Read the live TTL of an account's confidential entry.
 *
 * Reported as a DATE, not a ledger number: "expires 14 March" is actionable and
 * "liveUntilLedgerSeq 3900347" is not.
 */
export async function readAccountTtl(
  server: rpc.Server,
  tokenId: string,
  account: string,
  network: keyof typeof SECONDS_PER_LEDGER = "testnet",
): Promise<TtlStatus> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(tokenId).toScAddress(),
      key: accountStorageKey(account),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const res = await server.getLedgerEntries(key);
  const entry = res.entries[0];
  if (!entry) {
    // getLedgerEntries omits archived entries entirely, so absent and archived
    // look identical here. The caller distinguishes them by whether it has ever
    // seen a Register event for this account.
    return { kind: "absent" };
  }

  const liveUntil = entry.liveUntilLedgerSeq;
  if (liveUntil === undefined) return { kind: "absent" };
  if (liveUntil <= res.latestLedger) return { kind: "archived" };

  const ledgersLeft = liveUntil - res.latestLedger;
  const secondsLeft = ledgersLeft * SECONDS_PER_LEDGER[network];
  const daysRemaining = secondsLeft / 86_400;
  const expiresAt = new Date(Date.now() + secondsLeft * 1000);

  return daysRemaining <= KEEPALIVE_THRESHOLD_DAYS
    ? { kind: "expiring", expiresAt, daysRemaining }
    : { kind: "healthy", expiresAt, daysRemaining };
}

/**
 * The storage key for an account's ConfidentialAccount entry.
 *
 * The library keys it as an enum variant carrying the address, which the host
 * renders as a vector of [symbol, address].
 */
function accountStorageKey(account: string): xdr.ScVal {
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Account"), Address.fromString(account).toScVal()]);
}

/** True when a keep-alive should be submitted now. */
export function needsKeepAlive(status: TtlStatus): boolean {
  return status.kind === "expiring";
}

/**
 * Jitter a keep-alive by up to a day.
 *
 * A keep-alive transaction is publicly visible and its timing is observable. A
 * fixed cadence would fingerprint Pocket users, so the schedule is randomised
 * and real user activity is preferred over a synthetic bump whenever any is
 * available.
 */
export function jitteredDelayMs(baseDays: number): number {
  const base = baseDays * 86_400_000;
  const jitter = Math.random() * 86_400_000;
  return Math.max(0, base - jitter);
}
