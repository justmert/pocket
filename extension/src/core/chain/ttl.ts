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
// testnet against 2,073,600 on mainnet. Read live from getLedgerEntries on the
// ConfigSettingStateArchival key on 2026-07-31: both figures confirmed, and
// max_entry_ttl is 3,110,400 on both. Converted at the measured close times
// below that is about 7.0 days on testnet against 133.6 on mainnet, so the
// mainnet floor is an order of magnitude more forgiving and nothing calibrated
// against the testnet number will be too aggressive there.
import type { rpc } from "@stellar/stellar-sdk";
import { Address, xdr } from "@stellar/stellar-sdk/base";

/**
 * Measured ledger close time.
 *
 * Not nominal 5s: measured over 199 consecutive ledgers from Horizon on
 * 2026-07-31 as 5.0101s on testnet and 5.5678s on mainnet. The two differ by
 * 11%, which is why this is a per-network table and not a single constant.
 */
export const SECONDS_PER_LEDGER = { testnet: 5.01, mainnet: 5.57 } as const;

/** A network to read TTLs against. Never defaulted: see readAccountTtl. */
export type TtlNetwork = keyof typeof SECONDS_PER_LEDGER;

/** Bump when fewer than this many days remain, so a failure is never a surprise. */
export const KEEPALIVE_THRESHOLD_DAYS = 7;

const SECONDS_PER_DAY = 86_400;
const MS_PER_DAY = SECONDS_PER_DAY * 1000;

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
 *
 * `network` is REQUIRED and deliberately has no default. Defaulting it to
 * testnet would silently price mainnet ledgers 11% short on the day the wallet
 * is pointed at mainnet, and the resulting date would be wrong on a screen the
 * user is told to act on. A missing argument must be a compile error, not a
 * quietly wrong expiry.
 */
/**
 * `getLedgerEntries` is the SDK's PARSED accessor, and it does
 * `(raw.entries ?? []).map(...)`. So a reply carrying no `entries` field at
 * all, or `entries: null`, arrives as an empty array and is indistinguishable
 * from "there is no such ledger entry".
 *
 * That is the same defect `balances.ts` was fixed for, and it is worse here.
 * A degraded RPC makes a LIVE confidential account read as `absent`, and the
 * private-pocket screen then offers to set one up: a one-time, publicly
 * visible transaction that binds an auditor PERMANENTLY, to a user who already
 * has one and merely went dormant. The two instructions are opposite and one
 * of them cannot be undone.
 *
 * So: ask the raw endpoint and refuse a shape that cannot answer the question.
 */
async function entriesOrRefuse(
  server: rpc.Server,
  key: xdr.LedgerKey,
): Promise<{ entries: { liveUntilLedgerSeq?: number }[]; latestLedger: number }> {
  const raw = (await server._getLedgerEntries(key)) as {
    entries?: unknown;
    latestLedger?: unknown;
  };
  if (!Array.isArray(raw.entries) || typeof raw.latestLedger !== "number") {
    throw new LedgerReadError(
      "the ledger did not answer the question: the response carried no entries field",
    );
  }
  return raw as { entries: { liveUntilLedgerSeq?: number }[]; latestLedger: number };
}

/** A TTL read that could not be answered. Never confused with "absent". */
export class LedgerReadError extends Error {
  override readonly name = "LedgerReadError";
}

export async function readAccountTtl(
  server: rpc.Server,
  tokenId: string,
  account: string,
  network: TtlNetwork,
): Promise<TtlStatus> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(tokenId).toScAddress(),
      key: accountStorageKey(account),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const res = await entriesOrRefuse(server, key);
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

  return classifyRemaining(liveUntil - res.latestLedger, network);
}

/**
 * Ledgers remaining to a user-facing status.
 *
 * Shared by both readers so the close-time conversion exists once. Two copies
 * drifting apart would mean an account and the verifier it depends on being
 * judged by different clocks.
 */
function classifyRemaining(ledgersLeft: number, network: TtlNetwork): TtlStatus {
  const secondsLeft = ledgersLeft * SECONDS_PER_LEDGER[network];
  const daysRemaining = secondsLeft / SECONDS_PER_DAY;
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
  const base = baseDays * MS_PER_DAY;
  const jitter = Math.random() * MS_PER_DAY;
  return Math.max(0, base - jitter);
}

/**
 * The TTL of a CONTRACT's own instance entry.
 *
 * This is the systemic hazard and it is easy to overlook. The verifier holds
 * all six verification keys in INSTANCE storage, and the module documentation
 * states plainly that instance-TTL management is the contract developer's
 * responsibility and that the module never calls extend_ttl on it.
 *
 * If the verifier's instance entry archives, EVERY confidential operation on
 * EVERY token pointing at it fails. One expiry breaks the whole deployment.
 * Since we deployed our own verifier, that is ours to watch.
 */
export async function readInstanceTtl(
  server: rpc.Server,
  contractId: string,
  network: TtlNetwork,
): Promise<TtlStatus> {
  const key = xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: Address.fromString(contractId).toScAddress(),
      key: xdr.ScVal.scvLedgerKeyContractInstance(),
      durability: xdr.ContractDataDurability.persistent(),
    }),
  );

  const res = await entriesOrRefuse(server, key);
  const entry = res.entries[0];
  if (!entry?.liveUntilLedgerSeq) return { kind: "absent" };
  if (entry.liveUntilLedgerSeq <= res.latestLedger) return { kind: "archived" };

  return classifyRemaining(entry.liveUntilLedgerSeq - res.latestLedger, network);
}
