// Keep-alive submission. Spec 18.1, decision D12.
//
// TTL monitoring tells us an account is about to archive. This actually stops
// it. Without submission the monitoring is a warning nobody acts on, and our
// stated target persona is exactly the user it fails: someone who shields and
// holds archives on schedule.
//
// `merge` is the natural vehicle: it requires auth, requires NO proof, is a
// single point addition, and touches the account entry, which is what bumps the
// TTL. A merge on an empty receiving balance is a no-op in state terms and
// still writes the entry.
//
// PARTIALLY VALIDATED on testnet, and the gap matters.
//
// Confirmed: an empty merge IS accepted on chain and emits a Merge event
// (tx submitted 2026-07-31 against our deployment).
//
// NOT yet confirmed: that it actually extends the TTL. The library calls
// `extend_ttl(key, ACCOUNT_TTL_THRESHOLD, ACCOUNT_EXTEND_AMOUNT)` with a
// threshold of 29 days and an extend of 30, and Soroban's extend_ttl is a
// no-op when the current TTL is ABOVE the threshold. Our test account sits at
// 30.03 days, so no extension was possible and none was observed. Observing one
// requires an account whose TTL has fallen below 29 days, i.e. about a day of
// waiting or a manipulated test ledger.
//
// The mechanism is sound on reading the source. If it ever proves otherwise,
// the fallback is an explicit ExtendFootprintTTL operation, which does not
// depend on the contract's own extension policy at all.
import {
  Account,
  BASE_FEE,
  Contract,
  TransactionBuilder,
  nativeToScVal,
  Address,
} from "@stellar/stellar-sdk/base";
import type { Transaction } from "@stellar/stellar-sdk/base";
import { needsKeepAlive, jitteredDelayMs, type TtlStatus } from "./ttl";
import { DEFAULT_TIMEOUT_SECONDS } from "./submit";

/**
 * Build the keep-alive. Unsigned: the caller signs and submits, so this module
 * stays free of key material.
 */
export function buildKeepAlive(
  source: Account,
  tokenId: string,
  account: string,
  networkPassphrase: string,
): Transaction {
  return new TransactionBuilder(source, { fee: BASE_FEE, networkPassphrase })
    .addOperation(new Contract(tokenId).call("merge", nativeToScVal(Address.fromString(account))))
    .setTimeout(DEFAULT_TIMEOUT_SECONDS)
    .build();
}

export interface KeepAlivePlan {
  /** Submit now. */
  due: boolean;
  /** Milliseconds until the next check, jittered. */
  nextCheckMs: number;
  /** What to tell the user, if anything. */
  notice?: string;
}

/**
 * Decide whether to bump, and when to look again.
 *
 * Never a fixed cadence. A keep-alive transaction is publicly visible and its
 * timing is observable, so every Pocket user bumping on the same clock would be
 * a signature. Real user activity is preferred over a synthetic bump: any
 * submitted operation touches the entry, so an active account never needs one.
 */
export function planKeepAlive(status: TtlStatus, userWasActiveRecently: boolean): KeepAlivePlan {
  if (status.kind === "archived") {
    return {
      due: false,
      nextCheckMs: jitteredDelayMs(1),
      notice:
        "Your private pocket is dormant. Reactivating it costs a small fee and restores access.",
    };
  }
  if (status.kind === "absent") {
    return { due: false, nextCheckMs: jitteredDelayMs(7) };
  }

  // Any submitted operation bumps the TTL, so an active account needs nothing.
  if (userWasActiveRecently) {
    return { due: false, nextCheckMs: jitteredDelayMs(Math.max(1, status.daysRemaining - 7)) };
  }

  if (needsKeepAlive(status)) {
    return {
      due: true,
      nextCheckMs: jitteredDelayMs(7),
      notice: `Keeping your private pocket active. It would otherwise go dormant in ${Math.round(status.daysRemaining)} days.`,
    };
  }

  // Check back once there is roughly a week of headroom left.
  return { due: false, nextCheckMs: jitteredDelayMs(Math.max(1, status.daysRemaining - 7)) };
}
