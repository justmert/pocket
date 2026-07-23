// The wallet controller. Owns the vault, the session and every chain call.
// Runs in the service worker; the popup never touches keys.
import { rpc } from "@stellar/stellar-sdk";
import {
  Account,
  Asset,
  Keypair,
  BASE_FEE,
  type Transaction,
  type xdr,
} from "@stellar/stellar-sdk/base";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { NETWORKS, DEFAULT_NETWORK, type NetworkId, type ConfidentialDeployment } from "./config";
import { createVault, unlockVault, WrongPasswordError } from "./vault/vault";
import type { VaultHeader, Bytes } from "./vault/envelope";
import {
  setSession,
  clearSession,
  clearPersistedSession,
  getSession,
  requireSession,
  readPersistedUnlock,
  sessionDeadline,
  touchDeadline,
} from "./session";
import {
  KEYS,
  readLocal,
  writeLocal,
  removeLocal,
  openingKey,
  openingKeys,
  auditorIdKeys,
} from "../lib/storage";
import {
  readNative,
  readTrustline,
  formatAmount,
  parseAmount,
  availableToSend,
  minimumBalance,
  AccountNotFoundError,
  CCTP_BURN_FEE_RESERVE_STROOPS,
} from "./chain/balances";
// aliased: the controller exposes methods of the same names, and an unqualified
// call inside the class would silently resolve to the module function.
import {
  priceSeries as readPriceSeries,
  assetMarket as readAssetMarket,
  isPriceable,
  RANGES,
  type RangeId,
} from "./chain/prices";
import { balanceHistory } from "./chain/balance-history";
import { valueSeries, sumSeries, changePct } from "./chain/portfolio";
import { buildPayment } from "./chain/payment";
import {
  submitAndConfirm,
  pollToTerminal,
  chainNow,
  describeOutcome,
  DEFAULT_TIMEOUT_SECONDS,
  SubmitOutcomeError,
  type SubmitOutcome,
} from "./chain/submit";
import { parseAddress } from "./chain/address";
import { withRequestDeadline } from "./chain/http";
import type {
  PublicBalance,
  WalletStatus,
  TransferSummary,
  PrivatePocket,
  ValueChart,
  AssetMarketView,
  HistoryEntry,
  HistoryPage,
  YieldMoveSummary,
  SwapSummary,
  SwapQuoteView,
  CctpSummary,
  TrustlineSummary,
} from "./messages";
import {
  readConfidentialAccount,
  readAuditorKey,
  explainSimulationFailure,
} from "./chain/confidential";
import { assertVerificationKey, type CircuitName } from "./chain/verification-key";
import { readAccountTtl, jitteredDelayMs, type TtlStatus } from "./chain/ttl";
import { buildKeepAlive, planKeepAlive, type KeepAlivePlan } from "./chain/keepalive";
import { balancesOf, verifyAgainstChain, applyMerge, credit, ZERO_OPENING } from "./private";
import type { Opening, ConfidentialAccount } from "./witness/types";
import type { Point } from "./crypto/grumpkin";
import type { OpContext } from "./confidential-ops";
import type { TxSummary as DappTxSummary } from "./provider/describe-tx";
import type { PrivateOpRequest, PrivateOpSummary, YieldPosition } from "./messages";
import { deriveEd25519 } from "./keys/sep5";

/** 0.5 XLM. A network parameter, currently identical on testnet and mainnet. */
const BASE_RESERVE_STROOPS = 5_000_000n;

/**
 * A private-pocket condition the user can act on, phrased for them.
 *
 * Named rather than generic so `describeError` can pass it through on the
 * allowlist. Every message it carries is authored here, never taken from an
 * RPC or a contract, so nothing it renders can leak witness material.
 */
export class PrivatePocketError extends Error {
  override readonly name = "PrivatePocketError";
}

/**
 * The destination cannot hold the classic asset this operation would deliver.
 *
 * Its own name rather than a reused one because the remedy is specific and
 * self-serve: add the trustline, then retry. The alternative was the SAC's
 * `Error(Contract, #13)`, which arrives as a bare `Error`, is on neither
 * allowlist in `dispatch.ts`, and therefore reached the user as "check your
 * connection" on a deterministic refusal no retry can fix.
 *
 * Only the asset CODE is interpolated, and codes come from `config.ts` or from
 * an `Asset` the wallet itself constructed, so nothing a contract authored can
 * reach a user through this.
 */
export class TrustlineRequiredError extends Error {
  override readonly name = "TrustlineRequiredError";
}

/**
 * A wallet is already installed here.
 *
 * Named so the message survives `describeError`. Told "Something went wrong,
 * try again", a user retries, keeps failing, and the obvious next move is to
 * remove the extension, which is the one action that discards the confidential
 * openings for good.
 */
export class WalletExistsError extends Error {
  override readonly name = "WalletExistsError";
}

/** The envelope this handle named is gone: already signed, or expired. */
export class StaleHandleError extends Error {
  override readonly name = "StaleHandleError";
}

/** A well-formed address of the wrong KIND for what the user is doing. */
export class InvalidAddressKindError extends Error {
  override readonly name = "InvalidAddressKindError";
}

/** More than the account can actually send, once the reserve is accounted for. */
export class InsufficientBalanceError extends Error {
  override readonly name = "InsufficientBalanceError";
}

/** A trustline the user can act on: a bad asset, or a handle no longer pending.
 *  Its messages are authored prose, safe to surface verbatim. */
export class TrustlineError extends Error {
  override readonly name = "TrustlineError";
}

/** A recovery attempt the user can correct: a bad phrase, or the wrong wallet. */
export class RecoveryError extends Error {
  override readonly name = "RecoveryError";
}

/**
 * A previous submission has not resolved, so building another one is refused.
 *
 * Two transactions in flight at once is how a user pays twice: the first may
 * still land, and the second consumes the sequence number the first was built
 * against. Refusing at build time is the only place that cannot be bypassed by
 * a popup that never mounted the unfinished-transaction screen.
 */
export class UnresolvedTransactionError extends Error {
  override readonly name = "UnresolvedTransactionError";
}

/** Testnet friendbot funding the user can act on. Its messages are authored
 *  prose, safe to surface verbatim; the address it names is our session's. */
export class FriendbotError extends Error {
  override readonly name = "FriendbotError";
}

/**
 * Which circuit each operation proves against. Merge and shield have none:
 * a deposit and a merge are authorised, not proved.
 */
const CIRCUIT_FOR: Record<PrivateOpRequest["kind"], CircuitName | null> = {
  register: "register",
  shield: null,
  merge: null,
  transfer: "transfer",
  unshield: "withdraw",
};

/** The state that follows a staged private operation, once it lands. */
interface StagedAfter {
  resolve: StagedResolution;
  /** True when this is a shield: a second transaction makes the deposit spendable. */
  follow?: boolean;
}

/**
 * What must be written locally once a submitted operation is known to have
 * landed, expressed so it can survive to disk.
 *
 * Relative where it can be ("credit this much", "fold receiving in") rather
 * than absolute, so it resolves against whatever is stored at resolution time
 * instead of a snapshot taken before submission. Every form is idempotent under
 * the chain check in `persistVerified`, which is what makes replaying one after
 * a crash safe.
 */
type StagedResolution =
  | {
      kind: "openings";
      spendable: [string, string];
      receiving: [string, string];
      /**
       * The last ledger whose inbound transfers are all already in `receiving`.
       * INCLUSIVE, so a scan resumes at `syncedThrough + 1`.
       *
       * Two places produce it, `creditInboundTransfers` here and
       * `recoverOpenings` from the archive's `ingested_through`, and both must
       * mean the same thing, because only one of them reads it back. It is a
       * high-water mark of what has been ACCOUNTED FOR, never a chain tip or a
       * wall-clock of when a scan ran: a cursor one ledger optimistic re-reads
       * an event that is already credited, and the all-or-nothing check in
       * `creditInbound` turns that into a pocket that refuses to reconcile on
       * every retry rather than a balance that is merely stale.
       */
      syncedThrough: number;
    }
  /**
   * A spend sets the SPENDABLE side and deliberately says nothing about the
   * receiving side or the cursor.
   *
   * Transfer and unshield used the absolute form above, carrying `receiving` as
   * it was read at BUILD time. That is a claim the sender is not entitled to
   * make. The contract does not touch the sender's `receiving_commitment` in
   * either operation (`storage.rs:711-712` for `confidential_transfer`, `627`
   * for `withdraw`), so the only thing that moves it is somebody ELSE paying
   * you, which needs no transaction of yours and no permission.
   *
   * Proving takes tens of seconds. A payment arriving inside that window is
   * ordinary, and it made the staged post-state wrong about a side the
   * operation never changed: `persistVerified` compared the stale sum against
   * the chain, refused, and the pocket sat `diverged` after an operation that
   * had SUCCEEDED. Carrying the build-time `syncedThrough` was the same mistake
   * one level down, rolling the scan cursor back over the credit that had just
   * advanced it.
   *
   * So the post-state is absolute exactly where it has to be, because the new
   * spendable opening comes out of the proof and cannot be recomputed, and
   * silent everywhere else.
   */
  | { kind: "spend"; spendable: [string, string] }
  /** A deposit credits the receiving side by a public amount, blinding zero. */
  | { kind: "credit"; amount: string }
  /** A merge folds the whole receiving side into spendable. */
  | { kind: "merge" };

/** A submission whose local consequence has not been written yet. */
interface StagedRecord {
  hash: string;
  token: string;
  address: string;
  resolve: StagedResolution;
}

/**
 * Where the staged record lives.
 *
 * Belongs in `lib/storage`'s KEYS with every other key; declared here because
 * this pass does not own that file. See the PATCH-REQUEST to A8.
 */
const STAGED_KEY = "pocket.staged";

/**
 * The idle-lock window, in minutes, and the bounds it is clamped to.
 *
 * Configurable like MetaMask/Rabby/Phantom, but bounded: "never" is deliberately
 * not offered, since a funded wallet that never idle-locks is the single outcome
 * this timer exists to prevent.
 */
const DEFAULT_AUTO_LOCK_MINUTES = 15;
const MIN_AUTO_LOCK_MINUTES = 1;
const MAX_AUTO_LOCK_MINUTES = 8 * 60;

interface PersistedSettings {
  network: NetworkId;
  /** Idle auto-lock in minutes. Absent on installs that predate the setting. */
  autoLockMinutes?: number;
}

/**
 * The longest expiry the wallet will submit behind.
 *
 * Everything Pocket builds itself uses `DEFAULT_TIMEOUT_SECONDS` (180). This is
 * the ceiling for an envelope that arrived from somewhere else, and it exists
 * only to bound the damage: an unresolved record blocks every further build
 * until its envelope can no longer be included, so a long bound is a long brick.
 */
const MAX_ACCEPTABLE_TIMEOUT_SECONDS = 3600;

/**
 * Refuse an envelope whose expiry cannot be decided.
 *
 * `submitAndConfirm` documents this as its precondition: "tx must already carry
 * timeBounds; without them expiry is undecidable and a stuck transaction can
 * never be safely rebuilt." Nothing enforced it, and it is not hypothetical. A
 * live DeFindex deposit envelope, fetched 2026-08-07, carries
 * `timeBounds: {minTime: "0", maxTime: "0"}`.
 *
 * maxTime 0 means "no upper bound": the transaction can be included at any time,
 * so `inFlight()` can never report it expired, `assertNothingUnresolved` refuses
 * every subsequent build, and the only user-reachable exit is erase, which
 * removes every `pocket.openings.*` blob. A permanently bricked wallet whose
 * escape hatch destroys the private pocket.
 *
 * Callers that receive a foreign envelope rebind it with `withOwnDeadline`
 * rather than relying on this to pass.
 */
function assertExpirable(tx: Transaction): void {
  // BigInt, not Number. `maxTime` is an int64 arriving from an envelope a third
  // party may have composed, and reading it through a double would make the
  // comparison approximate at exactly the values an attacker would reach for.
  // Nothing here is a money amount, but the same discipline applies.
  let maxTime: bigint;
  try {
    maxTime = BigInt(tx.timeBounds?.maxTime ?? 0);
  } catch {
    throw new UnresolvedTransactionError(
      "That transaction's expiry could not be read, so Pocket will not submit it.",
    );
  }
  if (maxTime <= 0n) {
    throw new UnresolvedTransactionError(
      "That transaction has no expiry, so Pocket could never tell whether it had stopped being " +
        "able to land. It will not submit one it cannot time out.",
    );
  }
  const now = Math.floor(Date.now() / 1000);
  if (maxTime - BigInt(now) > BigInt(MAX_ACCEPTABLE_TIMEOUT_SECONDS)) {
    throw new UnresolvedTransactionError(
      "That transaction stays valid for far longer than Pocket submits behind, so a stuck one " +
        "would block the wallet for hours. It will not submit it.",
    );
  }
}

/**
 * Re-bind a foreign envelope to the wallet's own expiry policy.
 *
 * Rebuilding rather than refusing, because the alternative is that a service
 * which omits time bounds simply cannot be used. `cloneFrom` copies the
 * operations verbatim, auth entries included, and drops the Soroban resource
 * data, which is correct here: `signAndSubmit` re-simulates immediately
 * afterwards and repopulates it. The sequence number is preserved.
 */
async function withOwnDeadline(tx: Transaction): Promise<Transaction> {
  const { TransactionBuilder } = await import("@stellar/stellar-sdk/base");
  const now = Math.floor(Date.now() / 1000);
  return TransactionBuilder.cloneFrom(tx, {
    timebounds: { minTime: 0, maxTime: now + DEFAULT_TIMEOUT_SECONDS },
  }).build();
}

/** The single contract call an envelope makes, decoded far enough to check it. */
interface Invocation {
  contract: string;
  functionName: string;
  /** Every `Address` anywhere in the arguments, including inside vectors and maps. */
  addresses: string[];
  /** Every integer anywhere in the arguments. i128 amounts arrive as bigint. */
  numbers: bigint[];
}

/**
 * Read the ONE contract call an envelope makes, or null if it is not that shape.
 *
 * The yield path used to ask only "which contracts does this touch", which is
 * all the yield path used to ask. That is not enough to sign on: it says nothing
 * about WHICH FUNCTION is called or WITH WHAT, so a third-party service that
 * builds the envelope can pick both. This reads the parts a caller has to check.
 *
 * Arguments are walked RECURSIVELY. A DeFindex deposit carries its amounts
 * inside `Vec<i128>` and its caller as a bare `Address`, so a check that looked
 * only at the top level would miss the amounts entirely. Verified against a live
 * testnet deposit envelope on 2026-08-07:
 *
 *   deposit(Vec<i128> amounts_desired, Vec<i128> amounts_min, Address caller, bool invest)
 *
 * Returns null rather than throwing: the caller decides what a shape it cannot
 * read means, and for every current caller that means refusing to sign.
 */
async function readSingleInvocation(tx: Transaction): Promise<Invocation | null> {
  const { Address, scValToNative } = await import("@stellar/stellar-sdk/base");
  if (tx.operations.length !== 1) return null;
  const op = tx.operations[0]!;
  if (op.type !== "invokeHostFunction") return null;
  try {
    const fn = (
      op as unknown as {
        func: {
          switch(): { name: string };
          invokeContract(): {
            contractAddress(): unknown;
            functionName(): { toString(): string };
            args(): xdr.ScVal[];
          };
        };
      }
    ).func;
    if (fn.switch().name !== "hostFunctionTypeInvokeContract") return null;
    const ic = fn.invokeContract();
    const addresses: string[] = [];
    const numbers: bigint[] = [];

    const walk = (v: xdr.ScVal): void => {
      const kind = v.switch().name;
      if (kind === "scvAddress") {
        addresses.push(Address.fromScVal(v).toString());
        return;
      }
      if (kind === "scvVec") {
        for (const inner of v.vec() ?? []) walk(inner);
        return;
      }
      if (kind === "scvMap") {
        for (const entry of v.map() ?? []) {
          walk(entry.key());
          walk(entry.val());
        }
        return;
      }
      // i128/u128/i64/u64/u32/i32 all decode to a JS number or bigint. Anything
      // that does not is not a quantity and is left alone.
      try {
        const native = scValToNative(v) as unknown;
        if (typeof native === "bigint") numbers.push(native);
        else if (typeof native === "number" && Number.isInteger(native)) {
          numbers.push(BigInt(native));
        }
      } catch {
        /* not a scalar we can read; nothing to check */
      }
    };
    for (const a of ic.args()) walk(a);

    return {
      contract: Address.fromScAddress(ic.contractAddress() as never).toString(),
      functionName: ic.functionName().toString(),
      addresses,
      numbers,
    };
  } catch {
    return null;
  }
}

/**
 * The three answers a parked dApp approval can have.
 *
 * "busy" is separate from "declined" because they are different facts about the
 * user. One of them is a decision they made; the other is a request that never
 * reached them.
 */
type DappVerdict = "approved" | "declined" | "busy";

export class WalletController {
  private network: NetworkId = DEFAULT_NETWORK;
  private autoLockMinutes_ = DEFAULT_AUTO_LOCK_MINUTES;
  private servers = new Map<NetworkId, rpc.Server>();

  private server(): rpc.Server {
    const id = this.network;
    let s = this.servers.get(id);
    if (!s) {
      // Without a deadline a server that accepts the connection and never
      // answers leaves the read unsettled forever, and the popup shows
      // "Reading the ledger" with nothing scheduled to end it.
      s = withRequestDeadline(new rpc.Server(NETWORKS[id].rpcUrl));
      this.servers.set(id, s);
    }
    return s;
  }

  async init(): Promise<void> {
    const settings = await readLocal<PersistedSettings>(KEYS.settings);
    if (settings?.network) this.network = settings.network;
    if (settings?.autoLockMinutes) {
      this.autoLockMinutes_ = this.clampAutoLock(settings.autoLockMinutes);
    }
    // A worker restart within the idle window comes back UNLOCKED, from the DEK
    // mirrored in session storage (RAM, wiped on browser close). Past the
    // deadline, or after an explicit lock or a browser close, the mirror is gone
    // and this is a no-op, which is the lock.
    await this.restoreSession();
  }

  /** Re-open the vault from the mirrored DEK after a worker restart. */
  private async restoreSession(): Promise<void> {
    const rec = await readPersistedUnlock(Date.now());
    if (!rec) return;
    try {
      await this.hydrate(rec.dek, rec.lockAt);
    } catch {
      // The mirror did not match the vault on disk (a reset under a still-warm
      // mirror, say). Fail closed: purge it and stay locked.
      await clearPersistedSession();
    }
  }

  /**
   * Everything that builds against a sequence number, signs, submits, or writes
   * openings runs one at a time.
   *
   * Nothing here is called from a single caller: the popup and the keep-alive
   * alarm are independent, and two submissions overlapping share one account
   * sequence and one in-flight record. Interleaved, one transaction fails with
   * tx_bad_seq and the other's in-flight record is erased by its neighbour's
   * terminal outcome, which is exactly the record the unfinished-transaction
   * screen exists to find.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    // Runs on both settle paths, so one failure does not wedge the queue.
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * A transaction that was submitted but whose outcome we never saw, because
   * the worker died or the popup closed. Never resend it: poll by hash, and
   * only rebuild once the ledger has said it does not have it AND its
   * timeBounds have passed.
   *
   * `windowPassed` and `expired` are two different facts and were one field.
   *
   * `windowPassed` is about the ENVELOPE: its maxTime is behind us, so it can
   * never be included from now on. That is what the unfinished-transaction
   * screen states, and it is true regardless of what anyone has heard.
   *
   * `expired` is a DECISION: it is safe to build a replacement. That needs the
   * second fact, because an envelope being un-includable now says nothing about
   * whether it was included before maxTime, and the only thing that rules that
   * out is the ledger having answered. `submit.ts` says exactly this at the one
   * call site that had it right, and the three gates here read the field that
   * did not: an RPC outage spanning the 180-second window opened all three for
   * a transaction that may have succeeded, and the next submission then
   * overwrote the record that pointed at its unwritten openings.
   */
  async inFlight(): Promise<{
    hash: string;
    maxTime: number;
    windowPassed: boolean;
    answered: boolean;
    expired: boolean;
    /** when it was submitted. absent on a record from an earlier build. */
    at?: number;
  } | null> {
    const e = await readLocal<{
      hash: string;
      maxTime: number;
      answered?: boolean;
      at?: number;
    }>(KEYS.inFlight);
    if (!e) return null;
    // The LEDGER's clock, not this machine's. timeBounds is enforced against
    // the ledger's close time, and deciding on a local clock that runs fast
    // declares an envelope dead while the network will still include it, which
    // is a window in which a replacement can be built for a live transaction.
    const windowPassed = e.maxTime > 0 && chainNow() > e.maxTime;
    // Absent on a record written by an earlier build, and absent means "nobody
    // has heard anything", which is the honest reading and the safe one: the
    // record stays unresolved until a poll answers rather than being rebuilt
    // over. `reconcileInFlight` runs on popup mount and supplies the answer.
    const answered = e.answered === true;
    return { ...e, answered, windowPassed, expired: windowPassed && answered };
  }

  /**
   * Resolve an in-flight transaction by polling its hash.
   *
   * This is the other half of the crash story. A private operation that landed
   * while the worker was dying left its consequence staged and unwritten, and
   * the openings it produced exist nowhere else: without them the balance is
   * visible on chain and permanently unspendable. So a `succeeded` verdict here
   * finishes the write, against the commitment the contract now holds.
   */
  async reconcileInFlight(): Promise<SubmitOutcome | null> {
    return this.exclusive(async () => {
      const e = await readLocal<{ hash: string; maxTime: number }>(KEYS.inFlight);
      if (!e) return null;
      // `maxTime` is passed so a NOT_FOUND from an RPC that has aged this
      // window out of its retention is not counted as an answer. Measured: four
      // transactions in this project's own testnet-evidence.md answer NOT_FOUND
      // today and `successful: true` on Horizon. Without it, leaving Pocket
      // closed for a week made every unresolved record read as "never landed",
      // and this function deletes the staged openings on that reading.
      let outcome = await pollToTerminal(this.server(), e.hash, {
        attempts: 3,
        maxTime: e.maxTime,
      });

      // Still not included, and it can never be included now. Left as "pending"
      // the record is unclearable, and the screen that renders it sits in front
      // of the whole wallet on every popup mount, forever.
      //
      // `answered` gates it, and has to. This rewrite routes the operation to
      // `discardStaged`, which deletes the only copy of the post-state that
      // exists, so the reasoning behind it has to be sound: an envelope past
      // its maxTime can never apply FROM NOW ON, which says nothing whatever
      // about whether it applied earlier. The one thing that rules that out is
      // the ledger having answered NOT_FOUND, and `pollToTerminal` returns
      // "pending" both when it heard that and when it heard nothing at all.
      // Conflating them turned an RPC outage lasting longer than a
      // three-minute timeBounds window into the deletion of the openings of a
      // confidential operation that had succeeded.
      //
      // Unanswered stays pending: unresolved is the honest report, and it is
      // recoverable on the next poll that gets through.
      if (
        outcome.kind === "pending" &&
        outcome.answered &&
        e.maxTime > 0 &&
        chainNow() > e.maxTime
      ) {
        outcome = { kind: "expired", hash: e.hash };
      }
      if (outcome.kind === "pending") {
        // Answered, but still inside the window. The record survives this call
        // and the build gates read it later, so the fact has to be on disk: it
        // is the difference between "cannot be included from now on" and "safe
        // to build a replacement", and only the second permits a resend.
        if (outcome.answered) await this.inFlightSink().answered(e.hash);
        return outcome;
      }

      if (outcome.kind === "succeeded") {
        // Throws on a mismatch, and must: a wrong opening is indistinguishable
        // from a lost one later, and the in-flight record stays put so the user
        // is brought back here rather than told everything is fine.
        await this.applyStaged(e.hash);
      } else {
        await this.discardStaged(e.hash);
      }
      await removeLocal(KEYS.inFlight);
      return outcome;
    });
  }

  /** The consequence of a submitted operation, held until the ledger decides. */
  private async writeStaged(record: StagedRecord): Promise<void> {
    const { dek } = requireSession();
    const { sealPayload } = await import("./vault/vault");
    // Sealed: a resolution carries an amount, which is exactly as sensitive as
    // the openings it turns into.
    await writeLocal(STAGED_KEY, await sealPayload(dek, record));
  }

  private async readStaged(): Promise<StagedRecord | null> {
    const { dek } = requireSession();
    const sealed = await readLocal<{ v: number; iv: string; ct: string }>(STAGED_KEY);
    if (!sealed) return null;
    const { openPayload } = await import("./vault/vault");
    return openPayload<StagedRecord>(dek, sealed);
  }

  /** Drop a staged record, but only the one belonging to this hash. */
  private async discardStaged(hash: string): Promise<void> {
    const rec = await this.readStaged();
    if (rec?.hash === hash) await removeLocal(STAGED_KEY);
  }

  /**
   * Write the consequence of a landed operation.
   *
   * Applied to whatever is stored NOW, not to a snapshot taken before
   * submission, and verified against the chain before it is trusted. The staged
   * record is only dropped once the write succeeded: a failed chain read must
   * leave it recoverable rather than silently discard the one copy of an
   * opening that exists.
   */
  private async applyStaged(hash: string): Promise<void> {
    const rec = await this.readStaged();
    if (!rec || rec.hash !== hash) return;

    // A relative resolution applied to a missing base assumes zero. That is
    // deliberate and it is safe, because the chain check below is the real
    // authority: if the account truly was at zero the write is correct and
    // heals a register whose persist was lost, and if it was not, verification
    // refuses. What it must not do is blame the user's records for a state this
    // device never had, so the absence is passed down to phrase the failure.
    const base = await this.readOpenings(rec.address, rec.token);
    const stored = base ?? { spendable: ZERO_OPENING, receiving: ZERO_OPENING, syncedThrough: 0 };
    await this.persistVerified(
      rec.address,
      { token: rec.token },
      resolveStaged(stored, rec.resolve),
      // Only a RELATIVE resolution is explained by a missing base. An absolute
      // one carries the whole post-state, so if that disagrees with the chain
      // the cause is a genuine divergence and saying otherwise misdirects.
      base !== null || rec.resolve.kind === "openings",
    );
    await removeLocal(STAGED_KEY);
  }

  async status(): Promise<WalletStatus> {
    const header = await readLocal<VaultHeader>(KEYS.vaultHeader);
    const session = getSession();
    const confidential = NETWORKS[this.network].confidential;
    return {
      initialised: header !== undefined,
      locked: session === null,
      network: this.network,
      address: session?.address,
      privateEnabled: this.readyAssets.size > 0,
      privateAvailable: confidential.length > 0,
      privateAssets: confidential.map((c) => ({
        symbol: c.symbol,
        token: c.token,
        underlying: c.underlying,
      })),
      autoLockMinutes: this.autoLockMinutes_,
    };
  }

  /**
   * Fund this account from friendbot. Testnet only, and gated on the network
   * actually having a friendbot: `friendbotUrl` is absent on mainnet by design
   * (config.ts), so this refuses there rather than pretending. Friendbot creates
   * the account with a starting XLM balance, which is what a freshly onboarded
   * wallet needs before it can hold a trustline, set up a private pocket, or pay.
   *
   * We wait for the created account to actually read back before returning, so
   * the popup's next balance read finds the funds rather than racing the ledger
   * the way a bare "friendbot answered 200" would.
   */
  async fundTestnet(): Promise<WalletStatus> {
    const { address } = requireSession();
    const net = NETWORKS[this.network];
    if (!net.friendbotUrl) {
      throw new FriendbotError("Funding from friendbot is only available on testnet.");
    }

    let res: Response;
    try {
      res = await fetch(`${net.friendbotUrl}?addr=${encodeURIComponent(address)}`, {
        method: "GET",
        signal: AbortSignal.timeout(20_000),
        headers: { accept: "application/json" },
      });
    } catch {
      throw new FriendbotError("Could not reach the testnet funding service. Try again.");
    }

    // Friendbot answers 400 for an account it has already funded. That is not a
    // failure the user must fix: if the account already reads back, the funds
    // are there and this counts as success.
    if (!res.ok) {
      try {
        await readNative(this.server(), address);
        return this.status();
      } catch {
        throw new FriendbotError(
          "The testnet funding service could not fund this account right now. Try again shortly.",
        );
      }
    }

    // Wait for the create-account to land before answering, so the popup's next
    // balance read finds it. Bounded: friendbot's transaction is usually visible
    // within a few seconds, and the worker is never blocked indefinitely.
    for (let i = 0; i < 10; i++) {
      try {
        await readNative(this.server(), address);
        break;
      } catch (e) {
        if (!(e instanceof AccountNotFoundError)) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    return this.status();
  }

  /**
   * Confidential wrapper tokens known ready this session, so `status` stays
   * cheap. A Set, not a boolean, because readiness is PER ASSET: a wallet can
   * have XLM ready and USDC unregistered at once. Refreshed per token by
   * privatePocket(), cleared on lock/erase/network change.
   */
  private readyAssets = new Set<string>();

  /**
   * The private pocket's state for this account.
   *
   * Every branch that is not "ready" is a state the user must be told about
   * plainly. A diverged wallet in particular MUST NOT be spent from and MUST
   * NOT silently resync: a silent resync would mask exactly the archive
   * integrity failure the design relies on catching.
   */
  async privatePocket(asset?: string): Promise<PrivatePocket> {
    const { address } = requireSession();
    const list = NETWORKS[this.network].confidential;
    // No asset named means the primary (first configured), so callers that
    // predate multi-asset are unchanged. A named asset resolves by wrapper
    // token, underlying SAC, or symbol.
    const cfg = asset
      ? list.find((c) => c.token === asset || c.underlying === asset || c.symbol === asset)
      : list[0];
    if (!cfg) {
      return { state: "unavailable", message: "No private pocket is deployed on this network." };
    }
    // Every non-"unavailable" return carries this, so a caller holding several
    // pockets (privatePockets) can tell them apart.
    const id = { symbol: cfg.symbol, token: cfg.token, underlying: cfg.underlying };

    // A brand-new wallet has no ledger entry at all. That is a normal state,
    // not a failure: the private pocket is simply unregistered, and the user
    // needs to fund the account before anything else can happen.
    //
    // Asked through `readNative`, not `getAccount`. `getAccount` rejects for
    // ANY reason, so a bare catch turned an RPC outage, a timeout or a 5xx into
    // a confident "this account does not exist on the network yet" for a funded
    // user. `readNative` throws the typed AccountNotFoundError only when the
    // entry is genuinely absent and lets transport errors through, which is the
    // rule `balances()` already follows a hundred lines below.
    try {
      await readNative(this.server(), address);
    } catch (e) {
      if (!(e instanceof AccountNotFoundError)) throw e;
      this.readyAssets.delete(cfg.token);
      return {
        ...id,
        state: "unfunded",
        // XLM, not the pocket's symbol: the account needs an XLM reserve to
        // exist on the network at all, whichever asset this pocket wraps.
        message:
          "This account does not exist on the network yet. Receive some XLM first, " +
          "then you can set up a private pocket.",
      };
    }
    const source = await this.server().getAccount(address);

    const account = await readConfidentialAccount(
      this.server(),
      cfg.token,
      address,
      source,
      NETWORKS[this.network].passphrase,
    );

    if (!account) {
      this.readyAssets.delete(cfg.token);
      const ttl = await readAccountTtl(this.server(), cfg.token, address, this.network);
      // An archived account reads as absent, so distinguish by whether we have
      // ever seen it registered.
      if (ttl.kind === "archived") {
        return {
          ...id,
          state: "archived",
          message:
            "Your private pocket is dormant. Reactivating it costs a small fee and restores access.",
        };
      }
      return {
        ...id,
        state: "unregistered",
        message:
          // "an auditor" reads as a third party, and the post-commit screen then
          // says the opposite: "Bind your OWN auditor key, derived from your
          // recovery phrase. Nobody else can read your amounts." That sentence
          // arrived one irreversible transaction too late, and the bullet it came
          // from used to sit on the FIRST screen before it was removed. This is
          // not a softening of the disclosure: the transaction really is public
          // and really is permanent, and both still say so. It is the disclosure
          // being specific about WHOSE key it is, which is the fact that decides
          // whether the sentence is frightening or merely true.
          "Hides your amounts, never your addresses. Setting it up is a one-time, " +
          "publicly visible transaction that permanently binds an auditor key who can " +
          "see your amounts. That key is YOUR OWN, derived from your recovery phrase, " +
          "so nobody else can read them.",
      };
    }

    this.readyAssets.add(cfg.token);
    const ttl = await readAccountTtl(this.server(), cfg.token, address, this.network);

    // The account READ succeeded, so the entry is reachable. If its TTL says
    // otherwise, the entry has archived and the network restored it to answer
    // us. Both facts are true at once, and only one of them was being reported.
    //
    // This deployment is soroban-rpc 27.1.1 / protocol 27, where an archived
    // persistent entry is AUTO-RESTORED into the readWrite footprint instead of
    // coming back as a `restorePreamble`. Measured on a real archived entry
    // (`liveUntilLedgerSeq: 0`, lastModified 3086116 against latest 4019256): no
    // preamble, a real result, and `transactionData` carrying
    // `archivedSorobanEntries`, which `assembleTransaction` copies verbatim so
    // the network performs the restore as part of the transaction.
    //
    // Two consequences, and the second is the one that was missed. The first:
    // `readConfidentialAccount` now returns a real account for an archived
    // pocket, so the `state: "archived"` branch above is unreachable on this
    // deployment, and reporting dormancy through it would be reporting a state
    // the chain no longer produces. The second: the pocket therefore reads as
    // fully READY, which is not wrong (it is genuinely spendable) and is not the
    // whole truth either, because the next operation silently carries a restore
    // and its fee.
    //
    // So the state stays `ready`, because forcing a usable pocket into a dormant
    // dead end would be the worse error, and the fact is said in the message
    // instead. `getLedgerEntries` omits an evicted entry entirely, which is why
    // `absent` counts here: a registered account whose entry cannot be found has
    // been evicted, and that is exactly the archived case.
    const restored = ttl.kind === "archived" || ttl.kind === "absent";

    // Openings live in the encrypted vault; without them the commitments on
    // chain are visible but unspendable, which is precisely why that store is
    // not an evictable cache.
    const stored = await this.readOpenings(address, cfg.token);
    if (!stored) {
      return {
        ...id,
        state: "needsRecovery",
        auditorId: account.auditorId,
        ...ttlFields(ttl),
        // Says what is true, not what was planned. Rebuilding means replaying
        // the event history from a durable archive, and no archive is
        // configured in this build, so nothing here can do it. `core/sync.ts`
        // implements the replay and is not reachable from any bundle. Naming a
        // recovery the wallet cannot perform, in the one state where a user is
        // deciding whether to panic, is the same defect as a fabricated
        // balance.
        message:
          "This account has a private pocket but this device has no record of its balances. " +
          `Your funds are safe on chain. ${rebuildAdvice(NETWORKS[this.network].archiveUrl)}`,
      };
    }

    // A received transfer moves the chain's receiving accumulator and this
    // device knows nothing about it until we look. Doing that BEFORE the
    // divergence check is the whole point: otherwise every inbound transfer
    // reads as "records do not match the ledger" and the money is unreachable.
    const credited = await this.creditInboundTransfers(stored, account, cfg);
    const check = verifyAgainstChain(credited, account);
    if (!check.ok) {
      return {
        ...id,
        state: "diverged",
        auditorId: account.auditorId,
        ...ttlFields(ttl),
        message:
          `Local records for the ${check.which} balance do not match the ledger. ` +
          (this.lastInboundFailure ? `${this.lastInboundFailure} ` : "") +
          "Pocket will not spend from this state. Your funds are safe on chain. " +
          rebuildAdvice(NETWORKS[this.network].archiveUrl),
      };
    }

    const b = balancesOf({
      kind: "ready",
      spendable: credited.spendable,
      receiving: credited.receiving,
      auditorId: account.auditorId,
      syncedThrough: credited.syncedThrough,
    })!;

    return {
      ...id,
      state: "ready",
      spendable: formatAmount(b.spendable),
      receiving: formatAmount(b.receiving),
      mergeAvailable: b.mergeAvailable,
      auditorId: account.auditorId,
      ...ttlFields(ttl),
      ...(restored
        ? {
            message:
              "This private pocket went dormant and the network restored it to read it. " +
              "Your balances are correct and still spendable. The next operation you make " +
              "will restore the entry as part of itself and cost a little more in fees.",
          }
        : {}),
    };
  }

  /**
   * Every private pocket this network has, one per configured confidential
   * asset (XLM, USDC, ...), in config order. The plural of privatePocket, for a
   * UI that shows more than one. Serial rather than parallel: each call may
   * credit inbound transfers, which takes the write queue, and one shared RPC
   * should not be hit with N concurrent replays.
   */
  async privatePockets(): Promise<PrivatePocket[]> {
    requireSession();
    const out: PrivatePocket[] = [];
    for (const c of NETWORKS[this.network].confidential) {
      out.push(await this.privatePocket(c.token));
    }
    return out;
  }

  /**
   * Persist openings for this (account, deployment).
   *
   * Written BEFORE an operation is considered done. These are what make the
   * on-chain commitments spendable, and nothing else holds them: losing them
   * leaves funds visible on chain and permanently unspendable. Encrypted at
   * rest under the DEK, alongside the seed, because an opening reveals an
   * amount and is exactly as sensitive as a key.
   */
  private async writeOpenings(
    address: string,
    token: string,
    state: { spendable: Opening; receiving: Opening; syncedThrough: number },
  ): Promise<void> {
    const { dek } = requireSession();
    const { sealPayload } = await import("./vault/vault");
    await writeLocal(
      openingKey(token, address),
      await sealPayload(dek, {
        spendable: {
          value: state.spendable.value.toString(),
          randomness: state.spendable.randomness.toString(),
        },
        receiving: {
          value: state.receiving.value.toString(),
          randomness: state.receiving.randomness.toString(),
        },
        syncedThrough: state.syncedThrough,
      }),
    );
  }

  /**
   * Rebuild this account's openings from the durable event history.
   *
   * The route out of `needsRecovery` and `diverged`, and the reason
   * `indexer/` exists. Refuses rather than guessing when no archive is
   * configured, when the archive cannot serve a gap-free window, or when the
   * replayed result does not reproduce the commitments the contract holds.
   */
  /**
   * Could a rebuild actually work right now?
   *
   * Asked immediately before erase, which is the one irreversible act in the
   * product. The copy there used to promise "they can be rebuilt afterwards" on
   * `Boolean(archiveUrl)` alone, which says only that a URL is configured: not
   * that the archive answers, not that it is current, not that it holds this
   * contract. Measured on the configured archive, ingested_through 4033277
   * against a chain at 4035534, three hours behind, so a private movement in
   * that window would meet RecoveryMismatchError with the keys already gone.
   *
   * Every failure is reported as "not ready" rather than thrown. A user asking
   * "can I get this back" is owed an answer either way, and an exception on
   * this screen would render as the generic sentence beside an Erase button.
   */
  async archiveReadiness(): Promise<{
    configured: boolean;
    reachable: boolean;
    ingestedThrough: number | null;
    chainLedger: number | null;
  }> {
    requireSession();
    const net = NETWORKS[this.network];
    if (!net.archiveUrl) {
      return { configured: false, reachable: false, ingestedThrough: null, chainLedger: null };
    }
    const token = net.confidential[0]?.token;
    if (!token) {
      return { configured: true, reachable: false, ingestedThrough: null, chainLedger: null };
    }
    const { ArchiveClient } = await import("./chain/archive");
    let ingestedThrough: number | null = null;
    let reachable = false;
    try {
      ingestedThrough = (await new ArchiveClient(net.archiveUrl).health(token)).ingested_through;
      reachable = true;
    } catch {
      // Unreachable is an ANSWER here, not an error: it is precisely the state
      // the user needs to know about before erasing.
    }
    let chainLedger: number | null = null;
    try {
      chainLedger = (await this.server().getLatestLedger()).sequence;
    } catch {
      // Same: without the chain's own position, "up to date" cannot be claimed,
      // and the readiness sentence says so rather than guessing.
    }
    return { configured: true, reachable, ingestedThrough, chainLedger };
  }

  async rebuildFromHistory(asset?: string): Promise<PrivatePocket> {
    const cfg = this.confidentialConfig(asset);
    await this.exclusive(async () => {
      const { address } = requireSession();
      const account = await this.readOwnAccount(address, cfg);
      const ctx = await this.opContext(cfg.token);
      const { deriveConfidentialKeys } = await import("./confidential-ops");
      const { vk } = await deriveConfidentialKeys(ctx);
      const { recoverOpenings } = await import("./recover-openings");

      const rebuilt = await recoverOpenings(
        NETWORKS[this.network].archiveUrl,
        cfg.token,
        address,
        vk,
        account,
      );
      await this.writeOpenings(address, cfg.token, rebuilt);
      this.lastInboundFailure = null;
    });
    // OUTSIDE the queue. `privatePocket` credits inbound transfers on its way
    // through, and that write is serialised too, so calling it from inside
    // would have the queue wait on itself.
    return this.privatePocket(cfg.token);
  }

  /**
   * The yield vault's state, or a plain reason there is none.
   *
   * Yield lives in the PUBLIC pocket and structurally cannot move to the
   * private one: a Pedersen commitment is additively homomorphic and nothing
   * more, so a vault cannot compute a share price over one.
   */
  async yieldPosition(): Promise<YieldPosition> {
    const { address } = requireSession();
    const cfg = NETWORKS[this.network].defindex;
    if (!cfg?.vault || !cfg.apiKey) {
      return {
        available: false,
        reason:
          "Yield is not configured for this network. Nothing is at risk; there is simply no " +
          "vault to deposit into.",
      };
    }
    const { DefindexClient, describeApy } = await import("./integrations/defindex");
    const client = new DefindexClient({
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      network: this.network,
    });
    // A failure in either read is reported, never rendered as a zero: a
    // fabricated yield figure is exactly as bad as a fabricated balance.
    const [vault, position] = await Promise.all([
      client.vault(cfg.vault),
      client.position(cfg.vault, address),
    ]);
    // The API returns i128 SUBUNITS as integer strings (dfTokens and the
    // underlyingBalance), so "1319997712" is 131.9997712, not 1.3 billion. Format
    // to a decimal amount the way every other balance in the wallet is shown; the
    // guard passes through a value that is already decimal (the shape check permits
    // one) rather than feeding a "." to BigInt.
    const toUnits = (raw: string): string => (raw.includes(".") ? raw : formatAmount(BigInt(raw)));
    return {
      available: true,
      vault: cfg.vault,
      apy: describeApy(vault.apy, 7),
      // The API reports SHARES, not underlying. Calling it a balance would
      // invite a user to read it as XLM, which it is not.
      balance: toUnits(position.shares),
      underlying: vault.assets?.[0]?.symbol ?? "XLM",
      // What those shares are worth in the underlying, when the vault reports it:
      // the withdrawable amount (a decimal amount), so the withdraw form can size a
      // MAX and refuse an over-withdrawal before it is built.
      underlyingBalance: position.underlying != null ? toUnits(position.underlying) : undefined,
    };
  }

  /**
   * Build a yield deposit or withdrawal, returning what the approval screen
   * renders. Nothing is signed here.
   *
   * DeFindex builds the envelope server-side, so it chooses the entry point and
   * every argument. The bytes are therefore decoded and pinned to the operation
   * that was asked for before they are offered for signing: one contract call,
   * on the configured vault, naming the expected function, addressing nobody but
   * this account, and moving no more than the amount entered.
   *
   * This is NOT "the same rule as signing for a dApp", which is what this
   * comment used to claim. The dApp path is not stronger here: `describeTx`
   * admits `invokeHostFunction` and renders it as the five words "Invoke a smart
   * contract", naming neither function nor arguments. The two paths are
   * differently wrong. That one shows a contract call it cannot describe; this
   * one describes a call in terms the user chose, which is worse unless the
   * bytes are checked against those terms. Hence the checks below.
   */
  async buildYieldMove(
    kind: "deposit" | "withdraw",
    amountStr: string,
  ): Promise<{ handle: string; summary: YieldMoveSummary }> {
    return this.exclusive(async () => {
      const { address } = requireSession();
      // Refuse while an earlier submission is unresolved: it may still land,
      // and a second envelope built now takes the sequence number the first
      // one claimed. The private path has always done this; the integration
      // builders did not, so a swap or a claim could displace the in-flight
      // pointer of a private operation and orphan its openings.
      await this.assertNothingUnresolved();
      const cfg = NETWORKS[this.network].defindex;
      const { DefindexClient, DefindexError } = await import("./integrations/defindex");
      if (!cfg?.vault || !cfg.apiKey) {
        throw new DefindexError("Yield is not configured for this network.");
      }
      const amount = parseAmount(amountStr);
      if (amount <= 0n) throw new DefindexError("Enter an amount greater than zero.");

      const client = new DefindexClient({
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        network: this.network,
      });

      // A DEPOSIT spends a wallet balance, and nothing here read it. Positivity
      // and the vault target were checked; the quantity leaving the account was
      // not, so an over-balance deposit was built, reviewed, signed, submitted
      // and refused by the network with a fee paid.
      //
      // A WITHDRAW is not guarded here because it does not spend a wallet
      // balance at all: it redeems vault shares, and the figure to check it
      // against is `position.underlying`, which the withdraw form already sizes
      // its maximum from.
      //
      // Best effort on the ASSET, deliberately. The vault names its underlying
      // by symbol, and resolving a symbol to an issuer needs `knownAssets`. If
      // that lookup fails the guard is skipped rather than refusing: this check
      // exists to stop a spend that cannot work, and it must never become the
      // reason a spend that would have worked does not happen.
      if (kind === "deposit") {
        const asset = await this.yieldUnderlying(client, cfg.vault);
        if (asset) await this.assertCanSpend(asset, amount);
      }

      const built =
        kind === "deposit"
          ? await client.buildDeposit(cfg.vault, { caller: address, amounts: [amount] })
          : await client.buildWithdraw(cfg.vault, { caller: address, amounts: [amount] });

      // DeFindex returns `timeBounds: {minTime: "0", maxTime: "0"}` (verified
      // against the live API, 2026-08-07), which is "no upper bound". An
      // unresolved record for such a transaction can never be reported expired,
      // so it would block every later build permanently and the only exit would
      // be erase. Rebind it to the same 180s window everything else uses, before
      // it is hashed or stored, so the handle names the envelope we will submit.
      const decoded = await withOwnDeadline(await this.decodeOwnEnvelope(built.xdr, address));

      // DeFindex composes this envelope, so it chooses the function and every
      // argument. Checking only that the vault appears among the targets, which
      // is all this did, leaves the service free to pick any entry point on that
      // contract with any arguments, while the screen below states an amount and
      // a direction taken from what the user typed rather than from the bytes.
      //
      // So the one invocation is read and pinned to the operation we asked for.
      // Verified against a live testnet envelope on 2026-08-07:
      //   deposit(Vec<i128> desired, Vec<i128> min, Address caller, bool invest)
      const call = await readSingleInvocation(decoded);
      if (!call) {
        throw new DefindexError(
          "The yield transaction is not the single contract call Pocket expected, so it will " +
            "not sign it.",
        );
      }
      if (call.contract !== cfg.vault) {
        throw new DefindexError(
          "The yield transaction does not target the configured vault, so Pocket will not sign it.",
        );
      }
      // The entry point. Without this the service can call any method the vault
      // exposes, `transfer` and `approve` among them, and the screen would still
      // read "Deposit N into the yield vault".
      if (call.functionName !== kind) {
        throw new DefindexError(
          `The yield transaction calls "${call.functionName}" rather than "${kind}", so Pocket ` +
            `will not sign it.`,
        );
      }
      // Every address in the arguments must be this wallet. A deposit names the
      // caller, and that is the field a hostile answer would repoint.
      const stranger = call.addresses.find((a) => a !== address);
      if (stranger !== undefined) {
        throw new DefindexError(
          "The yield transaction names an account that is not yours, so Pocket will not sign it.",
        );
      }
      // An UPPER BOUND rather than equality, deliberately. A vault takes both a
      // desired amount and a slippage floor, and the floor is legitimately
      // smaller; requiring equality would refuse an honest envelope. What must
      // never pass is a quantity larger than the one the user typed and the
      // screen is about to show.
      const inflated = call.numbers.find((n) => n > amount);
      if (inflated !== undefined) {
        throw new DefindexError(
          "The yield transaction moves more than the amount you entered, so Pocket will not " +
            "sign it.",
        );
      }

      // The real fee, from DeFindex's own composed envelope. The guard before
      // the build could only assume the base fee, and a vault deposit is a
      // Soroban invocation costing orders of magnitude more.
      if (kind === "deposit") {
        const asset = await this.yieldUnderlying(client, cfg.vault);
        if (asset) await this.assertCanAffordFee(decoded, asset, amount);
      }

      const handle = decoded.hash().toString("hex");
      this.pending.set(handle, { xdr: decoded.toXDR(), at: Date.now(), kind: `yield:${kind}` });
      this.prunePending();
      return {
        handle,
        summary: {
          kind,
          amount: formatAmount(amount),
          fee: formatAmount(BigInt(decoded.fee)),
          effects: [
            kind === "deposit"
              ? `Deposit ${formatAmount(amount)} into the yield vault`
              : `Withdraw ${formatAmount(amount)} from the yield vault`,
            "This is in the PUBLIC pocket and is visible on the ledger",
            `Pay a network fee of ${formatAmount(BigInt(decoded.fee))} XLM`,
          ],
        },
      };
    });
  }

  /** Sign and submit a yield move this controller built and verified. */
  async confirmYieldMove(handle: string): Promise<{ hash: string; ledger: number }> {
    return this.exclusive(async () => {
      this.prunePending();
      const entry = this.pending.get(handle);
      if (!entry || !entry.kind?.startsWith("yield:")) {
        const { DefindexError } = await import("./integrations/defindex");
        throw new DefindexError(
          "That yield operation is no longer pending confirmation. Build it again and review it.",
        );
      }
      this.pending.delete(handle);
      const decoded = await this.decodeOwnEnvelope(entry.xdr, requireSession().address);
      // No openings to stage: yield lives in the public pocket, so a landed
      // transaction has no local secret to write. Submit is the whole job.
      const outcome = await this.signAndSubmit(decoded, null, entry.kind);
      if (outcome.kind !== "succeeded") {
        throw new SubmitOutcomeError(describeOutcome(outcome), outcome);
      }
      return { hash: outcome.hash, ledger: outcome.ledger };
    });
  }

  /**
   * Build a changeTrust that opens a trustline for a classic asset, so the
   * account can hold and RECEIVE it (a swap into USDC, or a plain receive). This
   * is the self-serve answer to "you need a USDC trustline before you can receive
   * it": the wallet can add it rather than sending the user elsewhere. A trustline
   * locks a 0.5 XLM reserve, stated plainly in the effects. Nothing is signed
   * here; confirmAddTrustline signs and submits, exactly like a payment.
   */
  async buildAddTrustline(
    assetCode: string,
    issuer: string,
  ): Promise<{ handle: string; summary: TrustlineSummary }> {
    return this.exclusive(async () => {
      const { address } = requireSession();
      // Refuse while an earlier submission is unresolved: it may still land,
      // and a second envelope built now takes the sequence number the first
      // one claimed. The private path has always done this; the integration
      // builders did not, so a swap or a claim could displace the in-flight
      // pointer of a private operation and orphan its openings.
      await this.assertNothingUnresolved();
      const net = NETWORKS[this.network];
      const { Asset, Operation, TransactionBuilder, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      let asset: InstanceType<typeof Asset>;
      try {
        asset = new Asset(assetCode, issuer);
      } catch {
        throw new TrustlineError(`${assetCode} / ${issuer} is not a valid asset.`);
      }
      if (asset.isNative()) {
        throw new TrustlineError("XLM is the native asset and needs no trustline.");
      }
      const source = await this.server().getAccount(address);
      const tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(Operation.changeTrust({ asset }))
        .setTimeout(180)
        .build();
      const handle = tx.hash().toString("hex");
      this.pending.set(handle, { xdr: tx.toXDR(), at: Date.now(), kind: "trustline" });
      this.prunePending();
      return {
        handle,
        summary: {
          assetCode: asset.getCode(),
          issuer,
          fee: formatAmount(BigInt(tx.fee)),
          effects: [
            `Open a trustline so this account can hold ${asset.getCode()}`,
            // The ISSUER, in full, as its own effect. Testnet returns several
            // assets all called USDC with different issuers, and the code is not
            // identity: without this line the confirm for a genuine USDC and a
            // counterfeit one were identical strings. `ChooseAsset` passes no
            // `to`, so `WalletReview`'s full-address block never renders and this
            // is the only place the issuer can reach the screen. Never truncated,
            // for the same reason no address in this wallet is.
            `Trust the issuer ${issuer}`,
            "This locks 0.5 XLM as a reserve while the trustline is open; removing it later releases the reserve",
            "This is in the PUBLIC pocket and is visible on the ledger",
            `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
          ],
        },
      };
    });
  }

  /** Sign and submit a trustline this controller built and staged. */
  async confirmAddTrustline(handle: string): Promise<{ hash: string; ledger: number }> {
    return this.exclusive(async () => {
      this.prunePending();
      const entry = this.pending.get(handle);
      if (!entry || entry.kind !== "trustline") {
        throw new TrustlineError(
          "That trustline is no longer pending confirmation. Build it again and review it.",
        );
      }
      this.pending.delete(handle);
      const decoded = await this.decodeOwnEnvelope(entry.xdr, requireSession().address);
      // A changeTrust is a CLASSIC operation, so sign and submit it directly the
      // way a payment does. It must NOT go through `signAndSubmit`: that path
      // Soroban-simulates every envelope (prepareTransaction), which a classic tx
      // cannot pass, so routing a trustline through it failed at simulation and
      // surfaced as the generic "something went wrong". No openings to stage
      // either: a trustline holds no local secret.
      decoded.sign(this.keypair());
      const outcome = await submitAndConfirm(this.server(), decoded, {
        inFlight: this.inFlightSink("trustline"),
      });
      if (outcome.kind === "succeeded") {
        return { hash: outcome.hash, ledger: outcome.ledger };
      }
      throw new SubmitOutcomeError(describeOutcome(outcome), outcome);
    });
  }

  /**
   * Every classic trustline the account holds, for the manage-assets list.
   *
   * `balances()` only probes the configured `knownAssets`, so it cannot show an
   * asset the user added by hand. Enumerating an account's subentries is not a
   * thing the Soroban RPC can do, so this reads Horizon's `/accounts/{id}` and
   * returns its non-native lines. It never signs and holds no secret.
   */
  async trustlines(): Promise<
    { code: string; issuer: string; balance: string; limit: string; authorized: boolean }[]
  > {
    const { address } = requireSession();
    const net = NETWORKS[this.network];
    let res: Response;
    try {
      res = await fetch(`${net.horizonUrl}/accounts/${address}`, {
        method: "GET",
        signal: AbortSignal.timeout(15_000),
        headers: { accept: "application/json" },
      });
    } catch {
      throw new AccountNotFoundError("Could not read this account's assets. Try again.");
    }
    // A brand-new account that has never been funded has no trustlines yet.
    if (res.status === 404) return [];
    if (!res.ok) throw new AccountNotFoundError("Could not read this account's assets.");
    const body = (await res.json()) as {
      balances?: {
        balance: string;
        limit?: string;
        asset_type: string;
        asset_code?: string;
        asset_issuer?: string;
        is_authorized?: boolean;
        selling_liabilities?: string;
      }[];
    };
    const out: {
      code: string;
      issuer: string;
      balance: string;
      limit: string;
      authorized: boolean;
    }[] = [];
    for (const b of body.balances ?? []) {
      // native XLM and liquidity-pool shares are not trustlines the user manages.
      if (b.asset_type === "native" || !b.asset_code || !b.asset_issuer) continue;
      // SPENDABLE, matching what `balances()` publishes for the same asset.
      //
      // This passed Horizon's raw `balance` straight through while `balances()`
      // subtracted selling liabilities, so with one open offer Home said 60
      // USDC and Settings > Your assets said 100, both unlabelled and both
      // claiming to be the amount held. `balances.ts` documents that exact bug
      // being fixed on its own side and it was never applied to this reader.
      const locked = parseAmount(b.selling_liabilities ?? "0");
      const held = parseAmount(b.balance);
      out.push({
        code: b.asset_code,
        issuer: b.asset_issuer,
        balance: formatAmount(held > locked ? held - locked : 0n),
        limit: b.limit ?? "0",
        authorized: b.is_authorized !== false,
      });
    }
    return out;
  }

  /**
   * Search the StellarExpert directory for a classic asset to trust. A keyless,
   * read-only search; contract-only tokens (no classic issuer) are dropped by the
   * client, because there is no trustline to open for them.
   */
  async assetSearch(query: string) {
    requireSession();
    const { StellarExpertClient } = await import("./integrations/stellar-expert");
    const network = this.network === "mainnet" ? "public" : "testnet";
    return new StellarExpertClient({
      baseUrl: "https://api.stellar.expert",
      network,
    }).searchAssets(query);
  }

  /**
   * Build a changeTrust that CLOSES a trustline (limit 0), so the account stops
   * holding an asset and the 0.5 XLM reserve it locked is released. Stellar
   * refuses to close a line with a non-zero balance, so this refuses first, with
   * a message the user can act on. `confirmAddTrustline` signs it (same staged
   * "trustline" kind as an add).
   */
  async buildRemoveTrustline(
    assetCode: string,
    issuer: string,
  ): Promise<{ handle: string; summary: TrustlineSummary }> {
    return this.exclusive(async () => {
      const { address } = requireSession();
      const net = NETWORKS[this.network];
      const { Asset, Operation, TransactionBuilder, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      let asset: InstanceType<typeof Asset>;
      try {
        asset = new Asset(assetCode, issuer);
      } catch {
        throw new TrustlineError(`${assetCode} / ${issuer} is not a valid asset.`);
      }
      if (asset.isNative()) {
        throw new TrustlineError("XLM is the native asset and has no trustline to remove.");
      }
      const tl = await readTrustline(this.server(), address, asset);
      if (tl && tl.raw > 0n) {
        throw new TrustlineError(
          `You still hold ${formatAmount(tl.raw)} ${assetCode}. Send or swap all of it out ` +
            "before removing the trustline.",
        );
      }

      // The classic balance is not the only thing that needs this line.
      //
      // A private pocket for the same asset delivers THROUGH it: the wrapper's
      // `withdraw` ends in a transfer on the underlying SAC, and that SAC is the
      // classic asset this trustline is for. Close it while private funds are
      // still inside and the unshield fails on chain with nothing on any screen
      // connecting the two, on a path whose only other exit is a private
      // transfer to somebody else.
      //
      // Checked against the local openings rather than the chain, because a
      // pocket whose balance this device cannot read is exactly the one that
      // must not lose its way out.
      const wrapper = net.confidential.find((c) => c.symbol === assetCode);
      if (wrapper) {
        const stored = await this.readOpenings(address, wrapper.token);
        const held = (stored?.spendable.value ?? 0n) + (stored?.receiving.value ?? 0n);
        if (held > 0n) {
          throw new TrustlineError(
            `Your private pocket still holds ${formatAmount(held)} ${assetCode}, and it comes ` +
              `back out through this trustline. Unshield it first, then remove ${assetCode}.`,
          );
        }
      }
      const source = await this.server().getAccount(address);
      const tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(Operation.changeTrust({ asset, limit: "0" }))
        .setTimeout(180)
        .build();
      const handle = tx.hash().toString("hex");
      this.pending.set(handle, { xdr: tx.toXDR(), at: Date.now(), kind: "trustline" });
      this.prunePending();
      return {
        handle,
        summary: {
          assetCode: asset.getCode(),
          issuer,
          fee: formatAmount(BigInt(tx.fee)),
          effects: [
            `Remove the ${asset.getCode()} trustline; this account will no longer hold ${asset.getCode()}`,
            // Which of several same-coded assets is being dropped.
            `Stop trusting the issuer ${issuer}`,
            "This releases the 0.5 XLM reserve the trustline locked",
            "This is in the PUBLIC pocket and is visible on the ledger",
            `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
          ],
        },
      };
    });
  }

  /**
   * Decode an envelope this controller is about to sign, refusing anything it
   * cannot vouch for. A fee-bump wraps someone else's transaction; a mismatched
   * source is not ours to sign. Returns the classic Transaction on success.
   */
  private async decodeOwnEnvelope(xdr: string, expectedSource: string): Promise<Transaction> {
    const { TransactionBuilder, Transaction: Tx } = await import("@stellar/stellar-sdk/base");
    const decoded = TransactionBuilder.fromXDR(xdr, NETWORKS[this.network].passphrase);
    if (!(decoded instanceof Tx)) {
      throw new Error("refusing to sign a fee-bump envelope here");
    }
    if (decoded.source !== expectedSource) {
      throw new Error("refusing to sign a transaction from a different source account");
    }
    return decoded;
  }

  /**
   * A swap quote to show before building. A read: it hits Aquarius for a route
   * and returns amounts. Nothing is signed or staged.
   */
  async swapQuote(assetIn: string, assetOut: string, amountStr: string): Promise<SwapQuoteView> {
    requireSession();
    const cfg = NETWORKS[this.network].aquarius;
    const { AquariusClient, AquariusError } = await import("./integrations/aquarius");
    if (!cfg) throw new AquariusError("Swaps are not available on this network.");
    const amount = parseAmount(amountStr);
    if (amount <= 0n) throw new AquariusError("Enter an amount greater than zero.");
    const inA = this.assetSac(assetIn);
    const outA = this.assetSac(assetOut);
    const path = await new AquariusClient({ apiUrl: cfg.apiUrl }).findPath(
      inA.sac,
      outA.sac,
      amount,
    );
    return {
      assetIn: inA.code,
      assetOut: outA.code,
      amountIn: formatAmount(amount),
      estOut: formatAmount(path.amount),
      route: path.tokens,
    };
  }

  /**
   * Build a swap, returning what the approval screen renders. Aquarius supplies
   * only the ROUTE (swap_chain_xdr); this method BUILDS the swap_chained call
   * itself, so the bytes signed are Pocket's own invocation of the configured
   * router, not a server-built envelope.
   */
  async buildSwap(
    assetIn: string,
    assetOut: string,
    amountStr: string,
    slippageBps = 100,
  ): Promise<{ handle: string; summary: SwapSummary }> {
    return this.exclusive(async () => {
      const { address } = requireSession();
      // Refuse while an earlier submission is unresolved: it may still land,
      // and a second envelope built now takes the sequence number the first
      // one claimed. The private path has always done this; the integration
      // builders did not, so a swap or a claim could displace the in-flight
      // pointer of a private operation and orphan its openings.
      await this.assertNothingUnresolved();
      const net = NETWORKS[this.network];
      const cfg = net.aquarius;
      const { AquariusClient, AquariusError, readRouteEndpoints } = await import(
        "./integrations/aquarius"
      );
      if (!cfg) throw new AquariusError("Swaps are not available on this network.");
      const amount = parseAmount(amountStr);
      if (amount <= 0n) throw new AquariusError("Enter an amount greater than zero.");
      if (slippageBps < 0 || slippageBps > 10_000) {
        throw new AquariusError("Slippage must be between 0 and 100%.");
      }
      const inA = this.assetSac(assetIn);
      const outA = this.assetSac(assetOut);
      // The IN balance, which nothing here read. Positivity, slippage and the
      // OUT trustline were all checked and the one quantity actually being
      // spent was not, so a swap for more XLM than the account holds was
      // routed, priced, reviewed, signed, submitted and refused by the network.
      await this.assertCanSpend(inA.asset, amount);

      // Receiving a classic asset needs a trustline, or the swap reverts at
      // submit with an opaque error. This was the ONLY path that checked, and
      // the unshield and CCTP claim paths end in the same SAC transfer and did
      // not. One method now, so there is one rule to keep right.
      await this.assertCanReceive(outA.asset, address, "swap");

      const path = await new AquariusClient({ apiUrl: cfg.apiUrl }).findPath(
        inA.sac,
        outA.sac,
        amount,
      );

      // The route decides what the user RECEIVES, and nothing else does.
      //
      // `swap_chained` takes (user, swaps_chain, token_in, in_amount, out_min).
      // `token_in` and `in_amount` are pinned below, so what LEAVES is ours. There
      // is no token_out argument: the delivered asset is whatever the last hop of
      // `swaps_chain` names, and `out_min` is a bare scalar in that token's own
      // units, so it bounds quantity and cannot bind identity. `assetOut` was only
      // ever a request parameter to find-path, and the answer is a third party's.
      //
      // So the route is read and checked against the asset the confirm screen is
      // about to name. Without this the sheet can promise USDC over an envelope
      // that delivers any other token with a pool.
      const route = readRouteEndpoints(path.swapChainXdr);
      if (route.terminal !== outA.sac) {
        throw new AquariusError(
          `The swap route does not end in ${outA.code}, so Pocket will not sign it. ` +
            `Get a fresh quote and try again.`,
        );
      }
      // Defence in depth: `token_in` is pinned below, so this cannot change what
      // leaves. It catches a route answering about a pair nobody asked for.
      if (!route.firstPair.includes(inA.sac)) {
        throw new AquariusError(
          `The swap route does not start from ${inA.code}, so Pocket will not sign it. ` +
            `Get a fresh quote and try again.`,
        );
      }

      // out_min = estimate * (1 - slippage), integer math on stroops.
      const outMin = (path.amount * BigInt(10_000 - slippageBps)) / 10_000n;

      const { TransactionBuilder, Contract, Address, nativeToScVal, xdr, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      const source = await this.server().getAccount(address);
      const rawSwap = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(
          new Contract(cfg.router).call(
            "swap_chained",
            nativeToScVal(Address.fromString(address)),
            // The route, verbatim from find-path. Not re-encoding it stops us
            // corrupting what we were handed; it is `readRouteEndpoints` above
            // that establishes the route ends in the asset the screen names.
            xdr.ScVal.fromXDR(path.swapChainXdr, "base64"),
            nativeToScVal(Address.fromString(inA.sac)),
            // u128, per the deployed contract's signature (NOT i128).
            nativeToScVal(amount, { type: "u128" }),
            nativeToScVal(outMin, { type: "u128" }),
          ),
        )
        .setTimeout(180)
        .build();
      // Simulated now, so the fee the sheet states is the fee that gets signed.
      const tx = await this.prepareForReview(rawSwap);
      // ...and the first moment the real fee is known. A swap costs orders of
      // magnitude more than the base fee the guard above had to assume.
      await this.assertCanAffordFee(tx, inA.asset, amount);

      const handle = tx.hash().toString("hex");
      this.pending.set(handle, { xdr: tx.toXDR(), at: Date.now(), kind: "swap" });
      this.prunePending();
      return {
        handle,
        summary: {
          assetIn: inA.code,
          assetOut: outA.code,
          amountIn: formatAmount(amount),
          estOut: formatAmount(path.amount),
          minOut: formatAmount(outMin),
          fee: formatAmount(BigInt(tx.fee)),
          route: path.tokens,
          effects: [
            `Swap ${formatAmount(amount)} ${inA.code} for about ${formatAmount(path.amount)} ${outA.code}`,
            `You receive at least ${formatAmount(outMin)} ${outA.code}, or the swap reverts`,
            "This is in the PUBLIC pocket and is visible on the ledger",
            `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
          ],
        },
      };
    });
  }

  /** Sign and submit a swap this controller built and staged. */
  async confirmSwap(handle: string): Promise<{ hash: string; ledger: number }> {
    return this.exclusive(async () => {
      this.prunePending();
      const entry = this.pending.get(handle);
      if (!entry || entry.kind !== "swap") {
        const { AquariusError } = await import("./integrations/aquarius");
        throw new AquariusError(
          "That swap is no longer pending confirmation. Get a fresh quote and review it.",
        );
      }
      this.pending.delete(handle);
      const decoded = await this.decodeOwnEnvelope(entry.xdr, requireSession().address);
      const outcome = await this.signAndSubmit(decoded, null, "swap");
      if (outcome.kind !== "succeeded") {
        throw new SubmitOutcomeError(describeOutcome(outcome), outcome);
      }
      return { hash: outcome.hash, ledger: outcome.ledger };
    });
  }

  /** Map an assetId ("native" or "CODE:ISSUER") to its SAC id and display code. */
  private assetSac(assetId: string): { sac: string; code: string; asset: Asset } {
    const asset = assetId === "native" ? Asset.native() : this.assetFromId(assetId);
    return {
      sac: asset.contractId(NETWORKS[this.network].passphrase),
      code: asset.isNative() ? "XLM" : asset.getCode(),
      asset,
    };
  }

  // ---- CCTP: cross-chain USDC (public pocket, Stellar legs only) ----

  /** The USDC SAC (SEP-41 contract) for this network, from the classic asset. */
  private cctpUsdcSac(usdcClassic: string): string {
    const issuer = usdcClassic.split("-")[1];
    if (!issuer) throw new Error("CCTP USDC asset is misconfigured");
    return new Asset("USDC", issuer).contractId(NETWORKS[this.network].passphrase);
  }

  /**
   * Bridge USDC OUT to another chain. Two Stellar transactions: approve the
   * TokenMessengerMinter, then burn. Only the approve is built here; the burn is
   * built at confirm from the spec stored on the pending entry, exactly like a
   * shield's follow-merge. Completion on the destination chain needs a tx THERE,
   * which this Stellar wallet cannot make, so the summary says so plainly.
   */
  async buildCctpSend(
    destinationDomain: number,
    recipient: string,
    amountStr: string,
    fast = false,
  ): Promise<{ handle: string; summary: CctpSummary }> {
    return this.exclusive(async () => {
      const { address } = requireSession();
      // Refuse while an earlier submission is unresolved: it may still land,
      // and a second envelope built now takes the sequence number the first
      // one claimed. The private path has always done this; the integration
      // builders did not, so a swap or a claim could displace the in-flight
      // pointer of a private operation and orphan its openings.
      await this.assertNothingUnresolved();
      const net = NETWORKS[this.network];
      const cctp = await import("./integrations/cctp");
      const chain = cctp.CCTP[this.network];
      if (destinationDomain === cctp.STELLAR_DOMAIN) {
        throw new cctp.CctpParameterError(
          "That is Stellar's own domain; choose a different chain.",
        );
      }
      // Being NAMED is not being reachable. BNB Smart Chain sits in the name
      // table and the picker offered it, and no route exists: the approve was
      // charged and the burn then trapped at Error(Contract, #7106), every
      // time. Refused here as well as hidden in the picker, because the picker
      // is a screen and this is the thing that spends money.
      if (!cctp.cctpCanBurnTo(destinationDomain)) {
        throw new cctp.CctpParameterError(
          `CCTP cannot carry USDC from Stellar to ${cctp.cctpDomainName(destinationDomain)}. ` +
            `Nothing has been sent and nothing has been charged. Choose another chain.`,
        );
      }
      const amount = parseAmount(amountStr);
      if (amount <= 0n) throw new cctp.CctpParameterError("amount must be positive");
      const mintRecipient = cctp.evmAddressToBytes32(recipient); // throws on a bad address
      const { cctpAmount, dust } = cctp.toCctpAmount(amount);
      if (cctpAmount <= 0n) {
        throw new cctp.CctpParameterError(
          "That is below the smallest bridgeable amount (0.000001 USDC).",
        );
      }
      // SPEND what crosses, not what was typed.
      //
      // CCTP carries six decimals and Stellar USDC has seven, so the last digit
      // of an amount cannot be represented in the message. This path used to
      // approve and burn the full 7dp `amount` while the sheet said the dust
      // "stays on Stellar": the wallet handed the whole sum to the token
      // messenger and told the user they had kept part of it. Whether Circle's
      // contract truncates, refunds or simply consumes that digit is not
      // knowable from this side, and it is not a thing to guess about with
      // someone's money.
      //
      // Rounding DOWN to the representable amount removes the question instead
      // of answering it. The dust is never spent, so it stays in the account by
      // construction rather than by claim, and one number now describes the
      // approve, the burn, the headline and the receipt. Down, never up: this
      // is the amount someone authorises, and it must not exceed what they
      // asked for.
      const bridged = cctp.fromCctpAmount(cctpAmount);

      // The USDC balance, which nothing here read. This is the path where the
      // omission costs the most: `confirmCctpSend` submits TWO transactions,
      // and leg one is a SAC `approve`, which requires no balance at all. So an
      // over-balance bridge paid for a successful approve and then failed on
      // the burn, and reported it as a connection problem.
      //
      // Against `bridged`, not the typed amount, because the rounded-down
      // figure is what the approve and the burn actually move. Guarding the
      // larger number would refuse a bridge of an exact balance that would in
      // fact have succeeded.
      const usdcIssuer = chain.usdc.split("-")[1];
      if (usdcIssuer) await this.assertCanSpend(new Asset("USDC", usdcIssuer), bridged);

      const maxFee = 0n; // standard transfer; no fast-transfer fee
      const minFinality = fast ? cctp.FINALITY.fast : cctp.FINALITY.standard;
      const usdcSac = this.cctpUsdcSac(chain.usdc);

      const { TransactionBuilder, Contract, Address, nativeToScVal, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      const source = await this.server().getAccount(address);
      const latest = await this.server().getLatestLedger();
      const expiration = latest.sequence + 6 * 3600; // generous window; burn follows now
      const rawApprove = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(
          new Contract(usdcSac).call(
            "approve",
            nativeToScVal(Address.fromString(address)),
            nativeToScVal(Address.fromString(chain.tokenMessengerMinter)),
            // `bridged`, not `amount`: the allowance must not exceed what the
            // burn will actually take.
            nativeToScVal(bridged, { type: "i128" }),
            nativeToScVal(expiration, { type: "u32" }),
          ),
        )
        .setTimeout(180)
        .build();
      // Simulated now, so the fee the sheet states is the fee that gets signed.
      const approveTx = await this.prepareForReview(rawApprove);
      // The real fee for this leg, finally known: a Soroban invocation costs
      // orders of magnitude more than the base fee the guard above had to
      // assume, and an approve the account cannot pay for must not be signed.
      //
      // This covers leg ONE only. The burn is built at confirm time, against
      // the sequence the approve consumed and the allowance it created, so it
      // cannot be simulated before the approve exists. That is why the balance
      // is checked up front instead: the remaining exposure is a burn that
      // fails for a fee the approve left too little of, which is far narrower
      // than the over-balance case that used to reach here.
      // Sized for BOTH legs. The burn's own fee cannot be simulated yet, so a
      // measured reserve stands in for it (see CCTP_BURN_FEE_RESERVE_STROOPS):
      // without it an account holding exactly the approve's fee was allowed
      // through, charged for the approve, and then lost the burn for want of a
      // fee, leaving a standing allowance and nothing to resume.
      const twoLegFee = BigInt(approveTx.fee) + CCTP_BURN_FEE_RESERVE_STROOPS;
      if (usdcIssuer) await this.assertCanSpend(new Asset("USDC", usdcIssuer), bridged, twoLegFee);

      const handle = approveTx.hash().toString("hex");
      this.pending.set(handle, {
        xdr: approveTx.toXDR(),
        at: Date.now(),
        kind: "cctpSend",
        cctpBurn: {
          destinationDomain,
          mintRecipient: Buffer.from(mintRecipient).toString("hex"),
          amount: bridged.toString(),
          maxFee: maxFee.toString(),
          minFinality,
          burnToken: usdcSac,
        },
      });
      this.prunePending();
      const chainName = cctp.cctpDomainName(destinationDomain);
      return {
        handle,
        summary: {
          direction: "out",
          chain: chainName,
          amount: formatAmount(bridged),
          // Decoded back out of the bytes just recorded, NOT the string the
          // form passed in. The sheet stated an amount and a chain and never
          // said where the money was going, so the one irreversible field in
          // the flow was reviewable only on the screen the user had left.
          recipient: cctp.bytes32ToEvmAddress(mintRecipient),
          dust: dust > 0n ? formatAmount(dust) : undefined,
          // The approve's simulated fee plus the reserve held back for the
          // burn. It was the approve alone, on a flow that signs and pays for
          // two transactions, so the sheet understated the cost by 2.3x to 3.1x
          // against fees measured on chain. The burn cannot be simulated until
          // the approve has landed, so this figure is honest about being an
          // upper bound rather than a quote, and the effect line says so.
          fee: formatAmount(twoLegFee),
          effects: [
            `Bridge ${formatAmount(bridged)} USDC from Stellar to ${chainName}`,
            "This burns the USDC on Stellar; the amount and both addresses are PUBLIC",
            ...(dust > 0n
              ? [
                  `${formatAmount(dust)} USDC stays in this account: CCTP carries 6 decimals ` +
                    `and Stellar USDC has 7, so that last digit cannot cross. It is not spent.`,
                ]
              : []),
            `It is minted on ${chainName} by a separate transaction THERE, which this wallet ` +
              "cannot make: you need gas on that chain, or a relayer, to finish it",
            "Two Stellar signatures: approve, then burn",
            `The network fee shown covers both, and the burn's share is an estimate: ` +
              `it cannot be priced until the approve has landed`,
          ],
        },
      };
    });
  }

  /** Sign and submit a CCTP outbound bridge: approve, then burn. */
  async confirmCctpSend(
    handle: string,
  ): Promise<{ approveHash: string; hash: string; ledger: number }> {
    return this.exclusive(async () => {
      this.prunePending();
      const entry = this.pending.get(handle);
      const cctp = await import("./integrations/cctp");
      if (!entry || entry.kind !== "cctpSend" || !entry.cctpBurn) {
        throw new cctp.CctpParameterError(
          "That bridge is no longer pending confirmation. Build it again and review it.",
        );
      }
      this.pending.delete(handle);
      const { address } = requireSession();
      const net = NETWORKS[this.network];
      const chain = cctp.CCTP[this.network];

      const approve = await this.decodeOwnEnvelope(entry.xdr, address);
      const approveOut = await this.signAndSubmit(approve, null, "cctpApprove");
      if (approveOut.kind !== "succeeded") {
        throw new SubmitOutcomeError(describeOutcome(approveOut), approveOut);
      }

      const spec = entry.cctpBurn;
      const { TransactionBuilder, Contract, Address, nativeToScVal, xdr, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      const source = await this.server().getAccount(address);
      const burnTx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(
          new Contract(chain.tokenMessengerMinter).call(
            "deposit_for_burn",
            nativeToScVal(Address.fromString(address)),
            nativeToScVal(BigInt(spec.amount), { type: "i128" }),
            nativeToScVal(spec.destinationDomain, { type: "u32" }),
            xdr.ScVal.scvBytes(Buffer.from(spec.mintRecipient, "hex")),
            nativeToScVal(Address.fromString(spec.burnToken)),
            xdr.ScVal.scvBytes(Buffer.from(cctp.zeroBytes32())),
            nativeToScVal(BigInt(spec.maxFee), { type: "i128" }),
            nativeToScVal(spec.minFinality, { type: "u32" }),
          ),
        )
        .setTimeout(180)
        .build();
      // A simulation failure THROWS rather than returning an outcome, so the
      // sentence below was unreachable for the commonest way the burn fails:
      // the user saw a bare contract refusal with no mention of the approve
      // they had already paid for. Caught here so every way the burn can fail
      // ends in a sentence that accounts for both legs.
      let burnOut: SubmitOutcome;
      try {
        burnOut = await this.signAndSubmit(burnTx, null, "cctpBurn");
      } catch (e) {
        throw new cctp.CctpParameterError(
          `The approval landed and was charged for, and the burn was refused before it was ` +
            `sent (${e instanceof Error ? e.message : "unknown reason"}). Nothing has been ` +
            `bridged and your USDC has not moved. The approval stays valid, so fixing the ` +
            `reason and bridging again does not pay for it twice.`,
        );
      }
      if (burnOut.kind === "pending") {
        // NOT "nothing has been bridged". `pending` means the ledger never told
        // us either way, so the burn may well have landed, and this sentence
        // used to end with "try the bridge again": the one instruction that
        // turns an unresolved burn into a second one.
        throw new SubmitOutcomeError(
          `The approval landed, and the burn was submitted but has not confirmed. It may still ` +
            `land, so do not bridge again yet: check ${burnOut.hash} first.`,
          burnOut,
        );
      }
      if (burnOut.kind !== "succeeded") {
        // The approve landed, so the allowance is set; only the burn need retry.
        throw new cctp.CctpParameterError(
          `The approval landed but the burn did not (${describeOutcome(burnOut)}). ` +
            "Nothing has been bridged; try the bridge again.",
        );
      }
      return { approveHash: approveOut.hash, hash: burnOut.hash, ledger: burnOut.ledger };
    });
  }

  /** Poll Circle's attestation service for a burn, by source domain and tx hash. */
  async cctpAttestation(
    sourceDomain: number,
    txHash: string,
  ): Promise<{ status: string; ready: boolean }> {
    requireSession();
    const { IrisClient } = await import("./integrations/iris");
    const { CCTP } = await import("./integrations/cctp");
    const att = await new IrisClient({ baseUrl: CCTP[this.network].iris }).attestation(
      sourceDomain,
      txHash,
    );
    return { status: att.status, ready: att.ready };
  }

  /**
   * Build a claim of USDC bridged TO Stellar: fetch the attestation for the
   * source burn, then mint_and_forward on the CctpForwarder. The burn was on the
   * source chain (not this wallet); this is the self-serviceable Stellar leg.
   */
  async buildCctpClaim(
    sourceDomain: number,
    txHash: string,
  ): Promise<{ handle: string; summary: CctpSummary }> {
    return this.exclusive(async () => {
      const { address } = requireSession();
      // Refuse while an earlier submission is unresolved: it may still land,
      // and a second envelope built now takes the sequence number the first
      // one claimed. The private path has always done this; the integration
      // builders did not, so a swap or a claim could displace the in-flight
      // pointer of a private operation and orphan its openings.
      await this.assertNothingUnresolved();
      const net = NETWORKS[this.network];
      const { IrisClient, IrisError } = await import("./integrations/iris");
      const cctp = await import("./integrations/cctp");
      const chain = cctp.CCTP[this.network];
      // Before Circle is even asked. A claim ends in a CLASSIC USDC transfer to
      // this account: measured on tx 7793604b, `mint_and_forward` mints to the
      // forwarder and then transfers to the recipient G address, and that leg
      // needs a trustline. Without one the whole claim reverts and the user was
      // told to check their connection, having already bridged the money.
      const [claimCode, claimIssuer] = chain.usdc.split("-");
      if (claimCode && claimIssuer) {
        await this.assertCanReceive(new Asset(claimCode, claimIssuer), address, "claim");
      }
      const att = await new IrisClient({ baseUrl: chain.iris }).attestation(sourceDomain, txHash);
      if (!att.ready || !att.message || !att.attestation) {
        // Split on WHAT Circle answered. These were one sentence, and the one it
        // chose was the one that can never come true for the commonest mistake on
        // this screen: a hash that is not a CCTP burn returned "try again
        // shortly", forever, next to a button 4.3 had also disabled.
        throw new IrisError(
          att.status === "not_found"
            ? "Circle has no record of that burn. Check the transaction hash and the chain it was " +
              "burned on. If you burned it in the last few minutes, it may not be indexed yet."
            : "This transfer is not ready to claim yet: Circle has not published its attestation. " +
              "Try again shortly.",
        );
      }

      const { TransactionBuilder, Contract, xdr, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      const source = await this.server().getAccount(address);
      const rawClaim = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(
          new Contract(chain.forwarder).call(
            "mint_and_forward",
            xdr.ScVal.scvBytes(Buffer.from(att.message.replace(/^0x/, ""), "hex")),
            xdr.ScVal.scvBytes(Buffer.from(att.attestation.replace(/^0x/, ""), "hex")),
          ),
        )
        .setTimeout(180)
        .build();
      // Simulated now, so the fee the sheet states is the fee that gets signed.
      const claimTx = await this.prepareForReview(rawClaim);
      const handle = claimTx.hash().toString("hex");
      this.pending.set(handle, { xdr: claimTx.toXDR(), at: Date.now(), kind: "cctpClaim" });
      this.prunePending();
      const chainName = cctp.cctpDomainName(sourceDomain);
      return {
        handle,
        summary: {
          direction: "in",
          chain: chainName,
          fee: formatAmount(BigInt(claimTx.fee)),
          // No `recipient`. Outbound, the destination is decoded back out of the
          // 32 bytes this wallet recorded, so the sheet can state it. Inbound it
          // is inside Circle's attested message, behind a CCTP v2 header this
          // module does not parse, and a claim mints to whoever the SOURCE burn
          // named rather than to whoever pays for the claim. Leaving the field
          // absent is the true answer; filling it with our own address would be
          // a guess presented as a fact, on the one line that matters.
          effects: [
            `Claim the USDC you bridged from ${chainName}`,
            "This completes the mint on Stellar; the amount is set by your source burn",
            "It arrives at whichever Stellar account your original burn named, which Pocket " +
              "cannot read out of Circle's attestation, so check it landed afterwards",
          ],
        },
      };
    });
  }

  /** Sign and submit a CCTP claim (mint_and_forward). */
  async confirmCctpClaim(handle: string): Promise<{ hash: string; ledger: number }> {
    return this.exclusive(async () => {
      this.prunePending();
      const entry = this.pending.get(handle);
      if (!entry || entry.kind !== "cctpClaim") {
        const { IrisError } = await import("./integrations/iris");
        throw new IrisError("That claim is no longer pending confirmation. Build it again.");
      }
      this.pending.delete(handle);
      const decoded = await this.decodeOwnEnvelope(entry.xdr, requireSession().address);
      const outcome = await this.signAndSubmit(decoded, null, "cctpClaim");
      if (outcome.kind !== "succeeded") {
        throw new SubmitOutcomeError(describeOutcome(outcome), outcome);
      }
      return { hash: outcome.hash, ledger: outcome.ledger };
    });
  }

  /**
   * What the worker is doing right now, for the popup to show.
   *
   * A long operation is a sequence of REAL, distinguishable phases and the
   * worker is the only context that knows which one it is in. A single
   * unchanging sentence over eight seconds is the picture a hung app shows,
   * and this wallet has just told the user the binding is permanent.
   *
   * Not a progress bar and not a percentage: those would be invented. Each
   * phase is named only when it actually starts.
   */
  private phase: string | null = null;

  private setPhase(p: string | null): void {
    this.phase = p;
  }

  /** The current phase, or null when nothing long is running. */
  currentPhase(): string | null {
    return this.phase;
  }

  /**
   * dApp approvals waiting on the user, keyed by an id the popup returns.
   *
   * BOUNDED, and bounded per origin, because this map is the only place a web
   * page can make the worker allocate. Unbounded, the failure is not memory,
   * it is consent: `pendingDappRequest` hands the popup the FIRST entry, so a
   * page looping `signTransaction` parks a queue of its own requests ahead of
   * anybody else's, calls `chrome.action.openPopup()` once per lap, and turns
   * every answer the user gives into another identical prompt. Nothing there
   * crashes and nothing there is refused; the user simply keeps being asked
   * until one of the presses lands on approve. That is click fatigue as an
   * exploit, and the twentieth prompt is the one that gets signed.
   *
   * So a second request is REFUSED rather than queued. One at a time per
   * origin, few at a time overall. A dapp that has already asked and not been
   * answered has nothing to gain from asking again, and an origin waiting on a
   * slot loses nothing that a retry cannot recover: the cap fails closed, and
   * a site denied a prompt is a far better outcome than a user worn into
   * approving one.
   */
  private dappPending = new Map<
    string,
    { origin: string; summary: DappTxSummary; resolve: (verdict: DappVerdict) => void }
  >();

  /**
   * How many sites may be waiting on the user at once.
   *
   * Four, not one, because distinct origins are not each other's problem and a
   * user with two tabs open has done nothing wrong. It is a cap on the queue,
   * not a queue: the fifth is told to try again, not remembered.
   */
  private static readonly MAX_PARKED_APPROVALS = 4;

  /**
   * Park a signing request until the user answers it in the popup.
   *
   * The worker never decides this. It holds the request, opens the popup and
   * waits. A timeout resolves to REFUSED, never approved: a user who walked
   * away has not consented.
   */
  private awaitDappApproval(origin: string, summary: DappTxSummary): Promise<DappVerdict> {
    // Checked BEFORE the promise, so a refused request costs no timer, no map
    // entry and no popup call. A flood has to be cheap to turn away or turning
    // it away is itself the denial of service.
    for (const parked of this.dappPending.values()) {
      if (parked.origin === origin) return Promise.resolve("busy");
    }
    if (this.dappPending.size >= WalletController.MAX_PARKED_APPROVALS) {
      return Promise.resolve("busy");
    }
    const id = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    return new Promise((resolve) => {
      const done = (verdict: DappVerdict) => {
        this.dappPending.delete(id);
        resolve(verdict);
      };
      this.dappPending.set(id, { origin, summary, resolve: done });
      void chrome.action?.openPopup?.().catch(() => undefined);
      setTimeout(() => {
        if (this.dappPending.has(id)) done("declined");
      }, 280_000);
    });
  }

  /** What the popup should be asking about, if anything. */
  pendingDappRequest(): { id: string; origin: string; summary: DappTxSummary } | null {
    const first = [...this.dappPending.entries()][0];
    if (!first) return null;
    return { id: first[0], origin: first[1].origin, summary: first[1].summary };
  }

  /** The user's answer. Anything other than an explicit yes is a refusal. */
  /**
   * Answer a parked approval, and say whether there was still one to answer.
   *
   * `?.resolve(...)` on a missing id is a no-op that returns void, so an approval
   * screen that outlived the worker's own timeout answered Approve by resolving
   * normally and closing exactly as a success does, while the site had been told
   * `USER_REJECTED "You declined that in Pocket."` minutes earlier and SEP-43
   * tells a site not to retry a rejection. The popup's `catch` for this case has
   * the right comment ("a refusal that failed to reach the worker must not close
   * the screen") and could never run, because nothing threw.
   *
   * It fails SAFE, which is why the answer is a boolean rather than an exception:
   * nothing was signed, and the screen simply needs to say the request expired
   * instead of implying it went through.
   */
  resolveDappRequest(id: string, approved: boolean): boolean {
    requireSession();
    const parked = this.dappPending.get(id);
    if (!parked) return false;
    parked.resolve(approved ? "approved" : "declined");
    return true;
  }

  /** Sites connected to this wallet, most recent first. */
  async dappSessions(): Promise<{ origin: string; connectedAt: number; address: string }[]> {
    requireSession();
    const { listSessions } = await import("./provider/session");
    return listSessions();
  }

  /**
   * Grant a site a connection.
   *
   * Only ever reached from the popup, by a user who confirmed the origin. A
   * page cannot cause this: `sep43` refuses an unknown origin and tells the
   * user to open Pocket, rather than raising a prompt a page could spam.
   */
  async connectDapp(origin: string): Promise<{ origin: string; connectedAt: number }> {
    const { address } = requireSession();
    const { connect } = await import("./provider/session");
    return connect(origin, address);
  }

  async disconnectDapp(origin: string): Promise<void> {
    requireSession();
    const { disconnect } = await import("./provider/session");
    await disconnect(origin);
  }

  /**
   * Answer a SEP-43 call from a page.
   *
   * The rules, in order of how much they matter:
   *   1. A locked wallet reveals nothing and signs nothing.
   *   2. `getAddress` requires a live session for that exact origin, or it
   *      raises a connection prompt. Nothing else creates a session.
   *   3. Every signature is approved individually. A session never authorises
   *      one, because an approval the user cannot see is a blind signature.
   *   4. The private pocket is unreachable from here. The allowlist is empty
   *      by default and confidential methods are refused by name, because a
   *      denylist would fail open the moment a method is added.
   */
  async sep43(origin: string, method: string, params: unknown[]): Promise<unknown> {
    const { ERROR, err, dappForbiddenInvocation } = await import("./provider/sep43");
    const sessions = await import("./provider/session");

    if (method === "getNetwork") {
      // Public information about the wallet, not about the user. Safe while
      // locked and without a session: it tells a dapp whether to bother.
      return {
        network: this.network,
        networkPassphrase: NETWORKS[this.network].passphrase,
      };
    }

    if (!getSession()) return err(ERROR.USER_REJECTED, "Pocket is locked.");

    const live = await sessions.sessionFor(origin);
    if (!live) {
      return err(
        ERROR.USER_REJECTED,
        "This site is not connected to Pocket. Open Pocket and connect it first.",
      );
    }

    // The address the user consented to reveal is recorded ON the session,
    // and it is the consent. Answering with whatever address is loaded now
    // means: connect a site to wallet A, recover into wallet B on the same
    // device, and the still-live grant hands that site wallet B with no
    // prompt. The datum is public, so nothing secret leaks; what leaks is the
    // LINK between a user's old and new addresses, to a third party, which is
    // exactly what a wallet shipping a private pocket must not do.
    const current = requireSession().address;
    if (live.address !== current) {
      await sessions.disconnect(origin);
      return err(
        ERROR.USER_REJECTED,
        "The wallet on this device changed since this site connected, so Pocket dropped the " +
          "connection. Reconnect if you still want the site to see this account.",
      );
    }

    switch (method) {
      case "getAddress":
        return { address: current };

      case "signTransaction": {
        const xdr = params[0];
        if (typeof xdr !== "string") {
          return err(ERROR.INVALID_REQUEST, "signTransaction needs a transaction envelope.");
        }
        const { describeTransaction } = await import("./provider/describe-tx");
        const summary = describeTransaction(xdr, NETWORKS[this.network].passphrase);

        // The absolute rule: bytes we cannot describe are never offered for
        // approval. An undecodable envelope, or a fee bump wrapping somebody
        // else's transaction, is refused HERE rather than shown to a user as a
        // hash to trust.
        if (!summary.decoded) {
          return err(ERROR.INVALID_REQUEST, summary.warning ?? "Pocket could not read that.");
        }
        // The wallet signs as ITSELF. An envelope sourced from another account
        // would take our signature somewhere we never looked.
        if (summary.source !== current) {
          return err(
            ERROR.INVALID_REQUEST,
            "That transaction is from a different account, so Pocket will not sign it.",
          );
        }
        // The private pocket is unreachable from a site by design, and this is
        // where that stops being a design and becomes a check. It was
        // `void CONFIDENTIAL_METHODS`, which reads like a boundary and does
        // nothing; what actually kept a site out was that no screen can
        // describe a contract call, so none reached here. That barrier is real
        // and it is incidental, and it would fall silently the day contract
        // calls become describable.
        const forbidden = dappForbiddenInvocation(xdr, NETWORKS[this.network].passphrase);
        if (forbidden) {
          return err(
            ERROR.INVALID_REQUEST,
            `Pocket does not sign contract calls for websites (${forbidden}). Your private ` +
              `pocket is not reachable from a site at all.`,
          );
        }

        // Parked until the user answers in the popup. A timeout resolves to
        // REFUSED: someone who walked away has not consented.
        const verdict = await this.awaitDappApproval(origin, summary);
        // "Busy" is INVALID_REQUEST, not USER_REJECTED, and the difference is
        // load-bearing: SEP-43 says a dapp must not retry a rejection, and a
        // site that already has a prompt open is exactly the one that should
        // wait and ask again. Reporting a refusal the user never gave would
        // also be a lie about consent, which is the thing this path exists to
        // get right.
        if (verdict === "busy") {
          return err(
            ERROR.INVALID_REQUEST,
            "Pocket is already asking about a request from this site. Answer that one first.",
          );
        }
        if (verdict === "declined") {
          return err(ERROR.USER_REJECTED, "You declined that in Pocket.");
        }
        const { TransactionBuilder } = await import("@stellar/stellar-sdk/base");
        const tx = TransactionBuilder.fromXDR(xdr, NETWORKS[this.network].passphrase);
        tx.sign(this.keypair());
        return { signedTxXdr: tx.toXDR(), signerAddress: current };
      }

      case "signAuthEntry":
      case "signMessage": {
        // Still refused, for the reason signTransaction used to be: there is
        // no screen that can show a user what an auth entry or an arbitrary
        // message commits them to. Refusing beats a signature nobody could read.
        void params;
        return err(
          ERROR.INVALID_REQUEST,
          "Pocket does not sign this yet. It will not sign anything it cannot show you first.",
        );
      }

      default:
        return err(ERROR.INVALID_REQUEST, "Unsupported method.");
    }
  }

  /** Openings for this (account, deployment). Encrypted at rest under the DEK. */
  private async readOpenings(
    address: string,
    token: string,
  ): Promise<{ spendable: Opening; receiving: Opening; syncedThrough: number } | null> {
    const { dek } = requireSession();
    const sealed = await readLocal<{ v: number; iv: string; ct: string }>(
      openingKey(token, address),
    );
    if (!sealed) return null;
    const { openPayload } = await import("./vault/vault");
    const raw = await openPayload<{
      spendable: { value: string; randomness: string };
      receiving: { value: string; randomness: string };
      syncedThrough: number;
    }>(dek, sealed);
    return {
      spendable: {
        value: BigInt(raw.spendable.value),
        randomness: BigInt(raw.spendable.randomness),
      },
      receiving: {
        value: BigInt(raw.receiving.value),
        randomness: BigInt(raw.receiving.randomness),
      },
      syncedThrough: raw.syncedThrough,
    };
  }

  /**
   * Create a new wallet. Returns the mnemonic exactly once, for backup.
   *
   * SERIALISED, because the read-then-write here is not atomic and the popup
   * is an ordinary extension page that opens in a tab, so two of them can run
   * this at once. Both passed the guard, both installed a seed, and both were
   * shown a phrase under the words "the only way to recover your wallet".
   * Last write won, so one of those two phrases owned nothing and its holder
   * had no way to know: the phrase is shown exactly once and never again.
   *
   * `import` and `recoverFromMnemonic` race the same way and are harmless,
   * because they converge on the same seed. Only `create` invents one.
   */
  async create(password: string): Promise<{ mnemonic: string; address: string }> {
    return this.exclusive(async () => {
      // Re-read INSIDE the critical section. Checking outside it is what made
      // this a race rather than a guard.
      if (await readLocal<VaultHeader>(KEYS.vaultHeader)) {
        throw new WalletExistsError("a wallet already exists on this device");
      }
      const mnemonic = generateMnemonic(wordlist, 256);
      const address = await this.installSeed(password, mnemonic);
      return { mnemonic, address };
    });
  }

  /**
   * SERIALISED, for the same reason `create` is.
   *
   * The guard below is a read followed by three writes in `installSeed`
   * (address, then header, then state). Two tabs importing different phrases,
   * or one creating while another imports, both pass the guard and interleave
   * those writes. The mild outcome is a user shown an address the device does
   * not hold. The bad one is a header from one wallet beside state from the
   * other: the DEK in that header cannot decrypt that state, so the vault is
   * bricked and neither phrase opens it.
   *
   * `exclusive` is a promise chain, not a re-entrant lock, so the inner half
   * is split out and `recoverFromMnemonic` calls THAT rather than this, or the
   * queue would wait on itself forever.
   */
  async import(password: string, mnemonic: string): Promise<{ address: string }> {
    return this.exclusive(() => this.doImport(password, mnemonic));
  }

  private async doImport(password: string, mnemonic: string): Promise<{ address: string }> {
    // Without this guard, any path that sends {type:"import"} replaces a
    // funded wallet's seed, and the previous mnemonic is the only recovery
    // material. Deliberate replacement goes through reset(), which requires
    // the current password.
    if (await readLocal<VaultHeader>(KEYS.vaultHeader)) {
      throw new WalletExistsError(
        "a wallet already exists on this device. Remove it first if you mean to replace it.",
      );
    }
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    if (!validateMnemonic(phrase, wordlist)) {
      // Named, like every other authored refusal. Unnamed it reached the user
      // as "check your connection", for a phrase they mistyped.
      throw new RecoveryError(
        "That is not a valid recovery phrase. Check the words and the order.",
      );
    }
    return { address: await this.installSeed(password, phrase) };
  }

  private async installSeed(password: string, mnemonic: string): Promise<string> {
    const { header, dek } = await createVault(password);
    const seed = new Uint8Array(await mnemonicToSeed(mnemonic)) as Bytes;
    const kp = deriveEd25519(seed, 0);

    // Address FIRST, then the vault. The dangerous half-written state is "a
    // vault exists but its address does not", because that is the one
    // `recoverFromMnemonic` cannot authorise against. Writing the address
    // before the header means a crash between these lines leaves a stray
    // address and no vault, which the next create or import simply overwrites.
    // The address is public the moment the account is funded, so writing it
    // ahead of the vault reveals nothing.
    await writeLocal(KEYS.publicAddress, kp.publicKey());
    await writeLocal(KEYS.vaultHeader, header);
    await writeLocal(KEYS.state, await this.sealState(dek, { mnemonic }));

    this.beginSession(dek, seed, kp.publicKey());
    return kp.publicKey();
  }

  private async sealState(dek: Bytes, value: unknown) {
    const { sealPayload } = await import("./vault/vault");
    return sealPayload(dek, value);
  }

  async unlock(password: string): Promise<WalletStatus> {
    const header = await readLocal<VaultHeader>(KEYS.vaultHeader);
    if (!header) throw new Error("no wallet to unlock");
    const dek = await unlockVault(header, password); // throws WrongPasswordError
    return this.hydrate(dek);
  }

  /**
   * Open the vault with a DEK already in hand and install the session.
   *
   * Shared by `unlock` (DEK derived from the password) and `restoreSession` (DEK
   * from the RAM mirror after a worker restart). On restore `lockAt` is passed
   * through so the idle window is not extended by a mere restart; a fresh unlock
   * passes none and gets a full window.
   */
  private async hydrate(dek: Bytes, lockAt?: number): Promise<WalletStatus> {
    const sealed = await readLocal<Parameters<typeof this.openState>[1]>(KEYS.state);
    if (!sealed) throw new Error("vault header exists but wallet state is missing");
    const { mnemonic } = await this.openState(dek, sealed);
    const seed = new Uint8Array(await mnemonicToSeed(mnemonic)) as Bytes;
    const kp = deriveEd25519(seed, 0);

    // Back-fill the stored address if this install predates it, or lost it to a
    // crash between the two writes in `installSeed`.
    //
    // The address is what authorises `recoverFromMnemonic`, which now refuses
    // outright without it. Writing it here is safe precisely because getting
    // this far required the DEK: the value is derived from the seed the vault
    // just yielded, so it cannot be planted by anyone who could not have opened
    // the vault anyway. This is what makes that refusal a one-unlock migration
    // instead of a permanent dead end.
    if ((await readLocal<string>(KEYS.publicAddress)) !== kp.publicKey()) {
      await writeLocal(KEYS.publicAddress, kp.publicKey());
    }

    this.beginSession(dek, seed, kp.publicKey(), lockAt);
    return this.status();
  }

  private async openState(dek: Bytes, sealed: { v: number; iv: string; ct: string }) {
    const { openPayload } = await import("./vault/vault");
    return openPayload<{ mnemonic: string }>(dek, sealed);
  }

  /** Install the in-memory session and mirror its DEK, with a fresh or restored deadline. */
  private beginSession(dek: Bytes, seed: Bytes, address: string, lockAt?: number): void {
    const now = Date.now();
    setSession({ dek, seed, address, unlockedAt: now, lockAt: lockAt ?? now + this.autoLockMs() });
  }

  /** The idle-lock window in minutes, for the alarm the worker arms. */
  autoLockMinutes(): number {
    return this.autoLockMinutes_;
  }

  /** The epoch-ms deadline the current session locks at, or null when locked. */
  sessionDeadline(): number | null {
    return sessionDeadline();
  }

  /** Slide the idle deadline forward by the current window, on real activity. */
  slideDeadline(): void {
    touchDeadline(Date.now() + this.autoLockMs());
  }

  private autoLockMs(): number {
    return this.autoLockMinutes_ * 60_000;
  }

  private clampAutoLock(minutes: number): number {
    if (!Number.isFinite(minutes)) return DEFAULT_AUTO_LOCK_MINUTES;
    return Math.min(MAX_AUTO_LOCK_MINUTES, Math.max(MIN_AUTO_LOCK_MINUTES, Math.round(minutes)));
  }

  /**
   * Change the idle-lock window. Clamped to the allowed range, persisted, and
   * applied to the live session at once so it takes effect now rather than at the
   * next unlock. The worker re-arms its alarm off this value on the activity that
   * carried the change.
   */
  async setAutoLock(minutes: number): Promise<WalletStatus> {
    this.autoLockMinutes_ = this.clampAutoLock(minutes);
    await this.writeSettings();
    if (getSession()) this.slideDeadline();
    return this.status();
  }

  /**
   * Persist BOTH device settings together. A partial write (`{ network }`
   * alone) would drop the auto-lock preference, and vice versa, since each write
   * replaces the whole record.
   */
  private async writeSettings(): Promise<void> {
    await writeLocal(KEYS.settings, {
      network: this.network,
      autoLockMinutes: this.autoLockMinutes_,
    } satisfies PersistedSettings);
  }

  /**
   * Everything the controller holds in memory about an unlocked wallet.
   *
   * Shared by `lock` and `erase` so the two cannot drift, which they had: both
   * dropped the session and the readiness flags, and neither dropped the built
   * envelopes. Synchronous, and called before anything that awaits, so a status
   * read landing mid-cleanup cannot see a half-locked wallet.
   */
  private dropVolatileState(): void {
    // Cached from the last private-pocket read, and only true for the account
    // that read it. Left set, a locked wallet still reports privateEnabled and
    // the home screen offers to open a pocket it cannot reach.
    this.readyAssets.clear();
    // Decrypted history entries must not outlive the session.
    this.privHistoryMemo = undefined;
    // Nor do built-but-unconfirmed envelopes. A staged private operation holds
    // its post-state openings in `pending` as plain decimal strings, value and
    // blinding both, alongside the unsigned envelope; a payment holds the
    // recipient and the memo. Nothing expires them on its own, because
    // `prunePending` only ever runs from inside a build or a confirm, so the
    // ten-minute TTL is enforced by nothing once the user has walked away.
    // `lock`'s own comment promises everything in memory goes first, and this
    // was not going at all.
    this.pending.clear();
    // Pending dApp approvals are RESOLVED as refused rather than dropped. The
    // map holds each site's `resolve`, so clearing it alone would leave the page
    // hanging until its own timeout. A lock is an answer, and the answer is no.
    for (const parked of this.dappPending.values()) parked.resolve("declined");
    this.dappPending.clear();
  }

  async lock(): Promise<void> {
    // Everything in memory goes first and synchronously, so nothing can read a
    // locked wallet's state during the part of the cleanup that suspends. The
    // readiness flags in particular are cleared HERE rather than at the end,
    // because everything below awaits and a status read landing in that window
    // would otherwise see them stale.
    clearSession();
    this.dropVolatileState();
    // The RAM mirror is what a restart would restore from, so a real lock must
    // take it too, or the wallet would come straight back unlocked. `clearSession`
    // above only dropped the in-memory copy.
    await clearPersistedSession();
    // A session grants seeing the address and asking to sign. Neither is true
    // of a locked wallet, so the grant goes with it.
    //
    // AWAITED, not fire-and-forget. `void import(...).then(...)` left the end
    // state correct and the ordering guaranteed by nothing: a caller that
    // locked and immediately asked `sep43` for the address raced a promise
    // nobody was holding. A lock that has returned must have finished locking.
    const { clearSessions } = await import("./provider/session");
    await clearSessions();
  }

  /**
   * Destroy the wallet on this device. Requires the current password, so a
   * stray message cannot do it. The seed is gone afterwards: only the user's
   * written-down phrase recovers the funds.
   */
  async reset(password: string): Promise<void> {
    const header = await readLocal<VaultHeader>(KEYS.vaultHeader);
    if (!header) return;
    await unlockVault(header, password); // throws WrongPasswordError
    await this.erase();
  }

  /**
   * Show the recovery phrase again, gated on the current password.
   *
   * The phrase IS the seed, so this re-authenticates against the vault rather
   * than trusting the live session: an already-unlocked wallet still has to
   * prove the password to see its own words, the same gate `reset` stands
   * behind. The DEK is derived from the password, never read from the session,
   * and the method installs no session and writes nothing. It opens the sealed
   * state, reads the mnemonic, and returns it. A wrong password throws
   * WrongPasswordError, which dispatch maps to "Wrong password."; the phrase
   * never reaches an error string.
   *
   * NOT in ALLOWED_WHILE_LOCKED: a locked wallet refuses this outright, because
   * the lock is exactly the guard on the seed. Re-deriving the DEK here means a
   * correct password is required even so, so an idle-locked screen left open
   * cannot be made to cough up the words without it.
   */
  async revealPhrase(password: string): Promise<string> {
    const header = await readLocal<VaultHeader>(KEYS.vaultHeader);
    if (!header) throw new Error("no wallet to reveal");
    const dek = await unlockVault(header, password); // throws WrongPasswordError
    const sealed = await readLocal<Parameters<typeof this.openState>[1]>(KEYS.state);
    if (!sealed) throw new Error("vault header exists but wallet state is missing");
    const { mnemonic } = await this.openState(dek, sealed);
    return mnemonic;
  }

  /**
   * Remove everything this device holds about the wallet.
   *
   * The openings must go with it. A new vault gets a fresh random DEK, so a
   * surviving opening blob is undecryptable forever, and re-importing the same
   * mnemonic would reproduce the same storage key and hit that blob rather
   * than a clean slate. Leaving it behind turns "start again" into a permanent
   * failure with no way out.
   *
   * `keepAuditorIds` is the ONE thing the two callers disagree about, and they
   * disagree because they are different events.
   *
   * `pocket.auditorid.<registry>.<token>.<address>` records the id the registry
   * allocated for this account's own auditor key. It was surviving both paths,
   * which is right for exactly one of them:
   *
   *   - `recoverFromMnemonic` brings the SAME account back, and the record is
   *     load-bearing. `ownAuditorId` reuses it after checking it against the
   *     chain; without it the next registration allocates a second id for a key
   *     that already has one, orphaning the first, which is the failure the key's
   *     own comment in `storage.ts` warns about. Keep it.
   *   - `reset` is a person saying remove this wallet from this device. What
   *     survived was a storage key with the erased account's STELLAR ADDRESS in
   *     its name, sitting beside no vault, saying that this device held that
   *     account and used the private pocket. No amount leaks, and no money is at
   *     risk; the wallet simply failed to do the thing the user asked for, in a
   *     product whose whole claim is about what it does not reveal. Sweep it.
   *
   * The default is to sweep, so a future caller has to think about it rather
   * than inherit the leak by saying nothing.
   */
  private async erase({ keepAuditorIds = false } = {}): Promise<void> {
    clearSession();
    this.dropVolatileState();
    // The RAM mirror goes with the rest of the wallet, so nothing can restore a
    // session for a device that no longer holds a vault.
    await clearPersistedSession();
    // ONE call, not seven awaits in a row.
    //
    // Interrupted between separate removes this left a half-erased device, and
    // WHICH half survived mattered enormously. The old order got it right by
    // accident: vault first, openings last, so a kill left orphaned blobs and
    // no vault. That is recoverable, because a fresh install sweeps them. The
    // reverse would have been catastrophic: a working wallet whose openings
    // were gone means funds visible on chain and permanently unspendable.
    //
    // Chrome documents the array signature but does not promise atomicity, so
    // this is one window rather than seven, not a transaction. The ordering
    // argument above is still load-bearing and must not be "simplified" into
    // removing openings first.
    await removeLocal([
      KEYS.vaultHeader,
      KEYS.state,
      KEYS.inFlight,
      // Sealed under the DEK about to be discarded, so leaving it behind
      // leaves an undecryptable blob the next wallet would trip over.
      STAGED_KEY,
      KEYS.publicAddress,
      // A grant says a site may see this wallet's address. Erasing the wallet
      // and leaving the grant behind means the NEXT wallet installed here
      // inherits every connection the last one made, silently.
      KEYS.dappSessions,
      ...(await openingKeys()),
      ...(keepAuditorIds ? [] : await auditorIdKeys()),
    ]);
  }

  /**
   * Erase this wallet and restore it from its recovery phrase.
   *
   * The route for a forgotten password, which `reset` cannot serve because it
   * asks for the very thing that is lost. Authorised by the phrase instead:
   * the mnemonic MUST derive the account this device already holds, so a
   * stranger's phrase cannot be used to wipe someone else's wallet. That check
   * is why the address is stored in the clear.
   *
   * This does NOT recover money. Confidential openings are destroyed with the
   * vault and are not reconstructible from the phrase, only replayed from an
   * archive. The caller must have said so before reaching here.
   */
  async recoverFromMnemonic(mnemonic: string, password: string): Promise<string> {
    return this.exclusive(() => this.doRecoverFromMnemonic(mnemonic, password));
  }

  private async doRecoverFromMnemonic(mnemonic: string, password: string): Promise<string> {
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    if (!validateMnemonic(phrase, wordlist)) {
      throw new RecoveryError(
        "That is not a valid recovery phrase. Check the words and the order.",
      );
    }

    // The authorisation, and it MUST fail closed.
    //
    // This is the one destructive path reachable while locked, so the attacker
    // to beat is someone holding the device without the password. Guarding it
    // with `if (existing)` meant that when the address was absent there was no
    // check at all, and ANY valid BIP-39 phrase erased the vault and every
    // confidential opening. Two ways to reach that: a vault created before the
    // address key existed, and the window in `installSeed`, which writes the
    // header, then the state, then the address.
    //
    // So: no stored address, no erase. A wallet whose owner can prove the
    // password still recovers, because `unlock` back-fills the address, which
    // turns this refusal into a one-unlock migration rather than a dead end.
    const existing = await readLocal<string>(KEYS.publicAddress);
    if (!existing) {
      throw new RecoveryError(
        "Pocket cannot check that this phrase belongs to the wallet on this device, so it will " +
          "not erase it. Unlock the wallet once with its password and this will work afterwards. " +
          "If the password is genuinely lost, removing and reinstalling the extension clears the " +
          "device deliberately, and your phrase restores the account from there.",
      );
    }

    const seed = new Uint8Array(await mnemonicToSeed(phrase)) as Bytes;
    if (deriveEd25519(seed, 0).publicKey() !== existing) {
      throw new RecoveryError(
        "That phrase belongs to a different wallet. Pocket will not erase this one with it.",
      );
    }

    // The same account is coming straight back, so its registered auditor ids
    // are still ITS ids. Sweeping them here would orphan a key on chain and
    // make the next register allocate a second one for it.
    await this.erase({ keepAuditorIds: true });
    // doImport, not import: we already hold the queue.
    const { address } = await this.doImport(password, phrase);
    return address;
  }

  async setNetwork(network: NetworkId): Promise<WalletStatus> {
    // Belt and braces with the dispatcher's own check, and worth having twice:
    // this value is assigned to `this.network` and then PERSISTED, so an
    // unknown one leaves every later `NETWORKS[this.network]` undefined and
    // survives a restart, with no screen that can set it back. A guard that
    // only exists at one caller is a guard the next caller will not have.
    if (!Object.prototype.hasOwnProperty.call(NETWORKS, network)) {
      throw new Error("Pocket does not know that network.");
    }
    // Mainnet has no host permission in the manifest yet, so every RPC call
    // would fail with an opaque network error. Refuse the switch instead of
    // letting the wallet look broken.
    if (network === "mainnet") {
      throw new Error("Pocket is testnet-only in this build.");
    }
    this.network = network;
    // Registration is per deployment, so what was true on the old network says
    // nothing about the new one. Report unknown rather than the last answer.
    this.readyAssets.clear();
    await this.writeSettings();
    return this.status();
  }

  /** Public-pocket balances. An unfunded account reports zero, not an error. */
  async balances(): Promise<PublicBalance[]> {
    const { address } = requireSession();
    const out: PublicBalance[] = [];
    let exists = true;
    try {
      const native = await readNative(this.server(), address);
      // The reserve is locked by the protocol and cannot be sent. Presenting
      // the raw balance would let a user try to spend into it and get an
      // opaque tx_insufficient_balance at submit time. Selling liabilities are
      // locked the same way and were not being subtracted: an offer made in any
      // other wallet on this same G-address made this figure too big by exactly
      // the offer.
      const reserve = minimumBalance(native, BASE_RESERVE_STROOPS);
      const spendable = availableToSend({ ...native, reserve });
      out.push({
        id: "native",
        code: "XLM",
        amount: formatAmount(spendable),
        total: formatAmount(native.raw),
        reserved: formatAmount(reserve),
        authorized: true,
      });
    } catch (e) {
      // ONLY an account that does not exist yet may render as zero. Every other
      // failure (RPC timeout, 5xx, decode error, denied host permission) must
      // propagate, or a network hiccup shows a funded user a confident
      // 0.0000000 with no spinner and no error.
      if (!(e instanceof AccountNotFoundError)) throw e;
      exists = false;
      out.push({ id: "native", code: "XLM", amount: "0.0000000", authorized: true });
    }

    // Every credit asset the ACCOUNT actually holds, read only once it exists.
    //
    // This iterated `knownAssets`, a hardcoded list with one entry on each
    // network. Meanwhile "Add an asset" searches the whole stellar.expert
    // directory and `buildAddTrustline` opens a trustline for anything valid,
    // so an asset a user added, paid a 0.5 XLM reserve for, and received funds
    // in was invisible to every surface that reads this: Home, the send picker,
    // the swap picker, the totals. It could not be sent, and it could not be
    // removed either, because the remove path refuses a non-zero balance it
    // has no way to help the user spend down.
    //
    // The SET now comes from Horizon, which knows what the account holds, and
    // each entry's NUMBERS still come from `readTrustline` so they agree with
    // the native entry above and with the guards, which read the same way. A
    // trustline the account does not hold is simply absent from the set, which
    // keeps "you do not trust this asset" distinct from "you hold zero of it".
    if (exists) {
      for (const line of await this.trustlines()) {
        const tl = await readTrustline(this.server(), address, new Asset(line.code, line.issuer));
        if (!tl) continue;
        out.push({
          id: tl.id,
          code: tl.code,
          issuer: tl.issuer,
          // The raw trustline balance was published straight through as
          // SPENDABLE. A trustline is not reserved against, so there is no
          // reserve term here, but an open sell offer locks its stroops just as
          // firmly as it does on the native side.
          amount: formatAmount(availableToSend(tl)),
          total: formatAmount(tl.raw),
          authorized: tl.authorized,
        });
      }
    }
    return out;
  }

  /**
   * One asset's history could not be rebuilt, so no chart is drawn.
   *
   * Internal and never surfaced: it is caught by `valueSeries` itself and turned
   * into an empty chart. It exists so that a single unreadable asset abandons
   * the WHOLE total rather than being skipped, because a total quietly missing
   * one of its parts is worse than no total at all. Deliberately absent from
   * dispatch's SAFE_ERRORS: nothing about it should ever reach a screen.
   */
  private static readonly UNREADABLE = class UnreadableHistory extends Error {};

  /**
   * What the PUBLIC pocket has been worth, over one range.
   *
   * `balance_at(t) * price_at(t)`, which is a real history rather than today's
   * holdings priced backwards. The distinction is the whole point: priced
   * backwards, a deposit is invisible and only the market moves the line.
   *
   * Public only, and there is no private equivalent. The opening store keeps
   * only the current state, so a private history would need a full event replay
   * through the confidential path, and confidential events carry a ledger number
   * rather than a time. None of that is built, so none of it is offered: the
   * private pocket shows its balances and no chart.
   *
   * Every failure below returns an EMPTY chart rather than throwing. A chart is
   * decoration on a wallet that works without it, so a price feed being down
   * must not turn into an error banner over someone's balance, and it must
   * certainly not turn into a flat line at zero.
   */
  async valueSeries(range: RangeId): Promise<ValueChart> {
    const empty: ValueChart = { points: [], changePct: null };
    const { address } = requireSession();
    const since = Date.now() - RANGES[range].days * 86_400_000;
    const horizonUrl = NETWORKS[this.network].horizonUrl;

    try {
      const balances = await this.balances();
      const perAsset = await Promise.all(
        balances.map(async (b) => {
          if (!isPriceable(b.code)) return [];
          const prices = await readPriceSeries(b.code, range);
          // An unreadable PRICE abandons the total, exactly as an unreadable
          // BALANCE history does below. This returned an empty series, which
          // `sumSeries` then filters out, so the asset silently left the total.
          //
          // That is not symmetric with anything and it is not survivable. XLM
          // and USDC are read from the SAME mainnet endpoint, but USDC never
          // makes a request: `priceSeries` short-circuits on `isQuoteAsset` and
          // synthesises a full-length series at exactly 1. So the one asset that
          // can fail is the one that is usually most of the money, and when it
          // did the headline became the USDC-only figure, presented as the whole
          // account, with the chart agreeing.
          //
          // The rule is stated four lines up, on UNREADABLE itself: a total
          // quietly missing one of its parts is worse than no total at all.
          if (prices.length === 0) throw new WalletController.UNREADABLE();
          // `total`, not the spendable figure. The reserve is still money the
          // account holds; it is merely unspendable, and a chart that dropped it
          // would disagree with the ledger for no reason a user could follow.
          const history = await balanceHistory({
            horizonUrl,
            account: address,
            assetId: b.id,
            currentStroops: parseAmount(b.total ?? b.amount),
            since,
          });
          // null means the history could not be reconstructed. Skipping this
          // asset would quietly under-report the total, so the whole chart is
          // withheld instead.
          if (!history) throw new WalletController.UNREADABLE();
          return valueSeries(history, prices);
        }),
      );
      const points = sumSeries(perAsset);
      return { points, changePct: changePct(points) };
    } catch {
      return empty;
    }
  }

  /**
   * Market facts about one asset, for the detail sheet.
   *
   * The ISSUER is required to price a credit asset, and a mismatch means no
   * price rather than a wrong one. `prices.ts` keys on the bare CODE
   * (`isQuoteAsset` is `symbol.toUpperCase() === "USDC"`, and `PRICED` is a code
   * table), which was safe only while `balances()` iterated the configured
   * `knownAssets` and no other asset could reach a screen. It now reads the
   * account's real trustlines, so any asset a user adds is priced too, and an
   * asset called USDC from an issuer nobody has heard of would have been valued
   * at exactly $1.00 a row, and summed into the pocket total at the top of Home.
   *
   * A user-added asset simply has no feed here, and saying so is the honest
   * answer: the rows already fall back to the asset's own unit when the price is
   * null, which is what they do for every unpriced asset today.
   */
  async assetMarket(symbol: string, issuer?: string): Promise<AssetMarketView> {
    requireSession();
    if (issuer !== undefined) {
      const known = (NETWORKS[this.network].knownAssets ?? []).find(
        (k) => k.code === symbol && k.issuer === issuer,
      );
      if (!known) return { price: null, change24h: null, volume24h: null };
    }
    return readAssetMarket(symbol);
  }

  /** One asset's price over a range, for the detail sheet's chart. */
  async assetSeries(symbol: string, range: RangeId): Promise<ValueChart> {
    requireSession();
    const prices = await readPriceSeries(symbol, range);
    const points = prices.map((p) => ({ at: p.at, value: p.price }));
    return { points, changePct: changePct(points) };
  }

  /** Cached full private history, keyed by account+network, short-lived. */
  private privHistoryMemo?: { key: string; at: number; read: PrivateHistoryRead };

  /**
   * The account's transaction history, newest first, merged across both pockets.
   *
   * Public entries come from Horizon (full history, exact amounts). Private
   * entries come from the confidential archive, replayed to decrypt this
   * account's own amounts; they are simply absent when there is no private
   * pocket or no archive, rather than failing the whole list. One (at, id)
   * cursor paginates both sources together.
   */
  async history(
    cursor?: string,
    limit = 30,
    pocket?: "public" | "private",
    asset?: string,
  ): Promise<HistoryPage> {
    const { address } = requireSession();
    const net = NETWORKS[this.network];
    const { decodeCursor, encodeCursor, beforeCursor, byRecency, publicHistory } = await import(
      "./chain/history"
    );
    const lim = Math.min(100, Math.max(1, Math.floor(limit)));
    const before = decodeCursor(cursor);

    // Each pocket's Activity shows only its own movements. Restricting to one
    // pocket is not just a filter: viewing the PUBLIC pocket then never triggers
    // the private replay (key derivation + a full archive decrypt), which is the
    // heavy work. `pocket` undefined keeps the merged view.
    const wantPrivate = pocket !== "public";
    const wantPublic = pocket !== "private";

    // Which halves could not be read. Reported rather than swallowed: the
    // catches below are right to keep one pocket's failure off the other's
    // list, and they were wrong to return an empty page in silence, because the
    // screen renders that as "No activity yet."
    const unread: { pocket: "public" | "private"; reason: string }[] = [];

    // The private list is computed whole (a stateful replay cannot be paged) and
    // memoised, so scrolling does not re-fetch and re-replay the archive per page.
    // A failed private read is not fatal: the public half still shows.
    const privRead = wantPrivate
      ? await this.privateHistoryAll(address, asset).catch((e: unknown) => {
          unread.push({ pocket: "private", reason: describeHistoryFailure(e, "private") });
          return { entries: [] as HistoryEntry[] } as PrivateHistoryRead;
        })
      : { entries: [] as HistoryEntry[] };
    // A read that PARTLY failed reports too. The catch above only fires when
    // the whole call rejects, and it never could: every failure mode of the
    // replay sits inside a per-asset catch, so this half of the report was
    // unreachable and an archive outage rendered as "No activity yet."
    if (privRead.unreadable) unread.push({ pocket: "private", reason: privRead.unreadable });
    const privBelow = privRead.entries.filter((e) => beforeCursor(e.at, e.id, before));

    // Public is paged from Horizon. A failed public read is not fatal: the
    // private half still shows, and vice versa.
    // Every confidential wrapper's deposit/withdraw legs are the private side's
    // story, so exclude them all from the public list, not just the first.
    const confidentialTokens = net.confidential.map((c) => c.token);
    const pub = wantPublic
      ? await publicHistory({
          horizonUrl: net.horizonUrl,
          account: address,
          excludeCounterparties: confidentialTokens,
          before,
          limit: lim,
        }).catch((e: unknown) => {
          unread.push({ pocket: "public", reason: describeHistoryFailure(e, "public") });
          return {
            entries: [] as HistoryEntry[],
            more: false,
            tokenOf: {} as Record<string, string>,
          };
        })
      : { entries: [] as HistoryEntry[], more: false, tokenOf: {} as Record<string, string> };

    const merged = [...privBelow, ...pub.entries].sort(byRecency);
    const entries = merged.slice(0, lim);
    // There is more when the merge overflowed the page, or Horizon stopped at its
    // page cap with entries still below the cursor.
    const more = merged.length > lim || pub.more;

    // Horizon's own paging token for the last PUBLIC entry that SURVIVED the
    // merge, so the next call resumes there instead of walking from the newest
    // page and skipping. It has to be the surviving one, not the last one
    // fetched: the private side can fill the page and push public entries out
    // of the slice, and a token past those would skip them for good.
    //
    // Carried forward when this page kept no public entry at all, so a run of
    // private-only pages does not lose the public position.
    let token: string | undefined;
    for (let i = entries.length - 1; i >= 0 && token === undefined; i--) {
      const id = entries[i]?.id;
      if (id !== undefined && pub.tokenOf[id] !== undefined) token = pub.tokenOf[id];
    }
    token ??= before?.token;

    const last = entries[entries.length - 1];
    // `more` was dropped whenever the page came back empty, because the cursor
    // was derived from the last entry and there was no last entry. That is
    // exactly the deep-scroll case: the skip consumed all twenty pages, found
    // nothing, correctly reported `more: true`, and the null cursor then told
    // the popup there was nothing further. `loadMore` returned early forever
    // and the list stopped, silently. With a token to resume from there is
    // something to say even with no entries.
    const nextCursor =
      last && more
        ? encodeCursor({ at: last.at, id: last.id, ...(token ? { token } : {}) })
        : more && before
          ? encodeCursor({ ...before, ...(token ? { token } : {}) })
          : null;
    return { entries, cursor: nextCursor, ...(unread.length ? { unread } : {}) };
  }

  private async privateHistoryAll(address: string, asset?: string): Promise<PrivateHistoryRead> {
    // Asset in the key: a filtered view and the merged view are different lists
    // and must not share a memo slot.
    const key = `${this.network}:${address}:${asset ?? "all"}`;
    const memo = this.privHistoryMemo;
    if (memo && memo.key === key && Date.now() - memo.at < 20_000) return memo.read;
    // NOT caught here, and NOT memoised on failure. Swallowing it produced an
    // empty list, and memoising that pinned "you have no private history" in
    // front of the user for twenty seconds after the read recovered. The caller
    // catches this and reports it as an unread half.
    const read = await this.computePrivateHistory(address, asset);
    // A read that could not see part of itself is not a result worth pinning.
    // Memoising a partial answer kept "you have no private history" on screen
    // for twenty seconds after the archive came back, which is the same defect
    // the line above was written to prevent, one level down.
    if (!read.unreadable) this.privHistoryMemo = { key, at: Date.now(), read };
    return read;
  }

  /**
   * Private history across every configured confidential asset (or one, when
   * `asset` is given), merged. Each wrapper has its own event stream, its own
   * viewing key and its own symbol, so each is replayed separately; one asset
   * failing (an archive gap, say) drops only that asset, not the others.
   */
  private async computePrivateHistory(
    address: string,
    asset?: string,
  ): Promise<PrivateHistoryRead> {
    const net = NETWORKS[this.network];
    // No archive is NOT "no history". Nothing else about the private pocket
    // needs one: register, shield, private transfer, merge and unshield all run
    // off local openings and Soroban RPC, and only the rebuild reads the
    // archive. So a build shipped without VITE_ARCHIVE_URL has a fully working
    // private pocket whose Activity read "No activity yet. Your transactions
    // will appear here." forever, which is a statement about the account and is
    // false. `.env.production` ships the variable commented out, so this is not
    // a hypothetical configuration.
    if (!net.archiveUrl) {
      return {
        entries: [],
        unreadable:
          "Private activity needs the durable event archive, and this build has none configured. " +
          "Your private transactions still happened and your balances are unaffected.",
      };
    }
    const assets = asset
      ? net.confidential.filter(
          (c) => c.token === asset || c.underlying === asset || c.symbol === asset,
        )
      : net.confidential;
    if (assets.length === 0) return { entries: [] };

    const { deriveConfidentialKeys } = await import("./confidential-ops");
    const { ArchiveClient } = await import("./chain/archive");
    const { privateHistory } = await import("./private-history");
    const client = new ArchiveClient(net.archiveUrl);

    const all: HistoryEntry[] = [];
    // Which assets could not be read, so a partial list can say it is partial.
    // The per-asset isolation below is right and stays; the SILENCE was the
    // defect. Every failure mode of the replay lives inside that try, so the
    // method could never throw, so `describeHistoryFailure` and the `unread`
    // banner built to prevent exactly this were unreachable code, and an
    // archive outage rendered as a positive claim that the account has no
    // private history at all.
    const failed: string[] = [];
    for (const cfg of assets) {
      try {
        const ctx = await this.opContext(cfg.token);
        const { vk } = await deriveConfidentialKeys(ctx);
        // `allEvents` throws IncompleteHistoryError on a gap, caught per asset
        // below so one asset's gap does not blank the whole private history, and
        // it pages under a budget rather than trusting the archive to stop
        // handing out cursors.
        const stored = await client.allEvents(cfg.token, address);
        all.push(...privateHistory(stored, { vk, address }, cfg.symbol));
      } catch {
        // Named, not described: the symbol is ours and from a closed set, while
        // an archive's own error text is not something to put in front of a user.
        failed.push(cfg.symbol);
      }
    }
    if (failed.length === 0) return { entries: all };
    return {
      entries: all,
      unreadable:
        `Pocket could not read the private activity for ${listOf(failed)}. ` +
        `Anything shown below is incomplete. Your balances are unaffected.`,
    };
  }

  private keypair(): Keypair {
    const { seed } = requireSession();
    return deriveEd25519(seed, 0);
  }

  /**
   * Build an unsigned payment and the summary an approval screen renders.
   * Nothing is signed here: the summary is presented first, and signing only
   * happens on explicit confirmation.
   */
  async buildPayment(req: {
    to: string;
    amount: string;
    assetId: string;
    memo?: string;
  }): Promise<{ xdr: string; summary: TransferSummary }> {
    return this.exclusive(() => this.doBuildPayment(req));
  }

  /**
   * Refuse a spend the account cannot actually make, BEFORE anything is built.
   *
   * One method because there were five build paths and only one of them did
   * this. `buildSwap` validated positivity, slippage and the destination
   * trustline; `buildYieldMove` validated positivity and the vault; and
   * `buildCctpSend` validated positivity, the six-decimal floor and the EVM
   * address. None of the three ever read the balance it was about to spend
   * from, so every one of them ended the same way: review, sign, submit, fail
   * on chain, pay a fee for the privilege.
   *
   * The argument for putting it at the worker is the one already written above
   * the payment guard, and it applies unchanged to the other four: a popup
   * showing a spendable figure is display, and the check has to sit where
   * whatever calls the worker cannot go round it.
   *
   * `feeStroops` is subtracted from the NATIVE balance only, because that is
   * where the fee is paid from. A Soroban invocation costs far more than base
   * fee, and the caller that built it is the one that knows, so it passes what
   * the envelope will really carry rather than this guessing.
   */
  /**
   * The classic asset a vault takes deposits in, or null if it cannot be named.
   *
   * The API reports the underlying by SYMBOL and by SAC address. A `Asset`
   * needs code and issuer, so the symbol is matched against this network's
   * `knownAssets`, which is the same way the yield screen resolves it.
   *
   * Null rather than a throw on anything unrecognised: the only caller uses
   * this to decide whether it can check a balance, and "we could not tell" must
   * degrade to the behaviour that existed before the check, not to a refusal.
   */
  /**
   * The classic asset a symbol names on this network, or null.
   *
   * A wrapper records its underlying as a SAC CONTRACT id and its display
   * symbol separately, and an `Asset` needs code and issuer, so neither field
   * can be used directly. The symbol is matched against `knownAssets`, which is
   * how the screens resolve it too.
   */
  private assetForSymbol(symbol: string | undefined): Asset | null {
    if (!symbol) return null;
    if (symbol === "XLM") return Asset.native();
    const known = (NETWORKS[this.network].knownAssets ?? []).find((a) => a.code === symbol);
    return known ? new Asset(known.code, known.issuer) : null;
  }

  private async yieldUnderlying(
    client: { vault(address: string): Promise<{ assets?: { symbol?: string }[] }> },
    vaultAddress: string,
  ): Promise<Asset | null> {
    try {
      return this.assetForSymbol((await client.vault(vaultAddress)).assets?.[0]?.symbol);
    } catch {
      return null;
    }
  }

  /**
   * The same affordability question, asked again once the fee is REAL.
   *
   * `assertCanSpend` runs before anything is built, so the only fee it can
   * assume is `BASE_FEE`: 100 stroops. A Soroban invocation costs three to four
   * orders of magnitude more than that (measured on this deployment: ~179,000
   * for a swap, 350,412 for a native shield), and simulation is the first
   * moment the number exists. So the early check catches the gross cases
   * cheaply and this one catches the case it structurally cannot: an amount
   * that fits the balance and leaves nothing for the fee.
   *
   * Called after `prepareForReview`, before the handle is retained, so a
   * transaction that cannot be paid for is never offered for signature.
   */
  private async assertCanAffordFee(tx: Transaction, asset: Asset, amount: bigint) {
    await this.assertCanSpend(asset, amount, BigInt(tx.fee));
  }

  /**
   * Refuse to deliver a classic asset to an account that cannot hold it.
   *
   * A classic credit asset arriving at a G address needs a trustline there. The
   * SAC refuses without one, and it refuses with `Error(Contract, #13)`, which
   * the SDK raises as a bare `Error`. "Error" is on neither of `dispatch.ts`'s
   * allowlists, so the user was told to check their connection about a
   * deterministic refusal that no retry can affect and that names, precisely,
   * the one thing they need to do.
   *
   * `buildSwap` already checked this and nothing else did, which is the shape
   * that recurred five times in the last audit: fixed on one surface, live on
   * the others. Three paths end in exactly the same SAC transfer to the user's
   * own address and all three skipped it:
   *
   *   unshield    `withdraw` ends in `token.transfer(contract, to, amount)`
   *               on the underlying SAC (storage.rs:629-630), after a proof
   *               that can take 165 seconds
   *   CCTP claim  `mint_and_forward` ends in a classic USDC transfer from the
   *               forwarder to the recipient (measured on tx 7793604b)
   *   swap        the original, kept here so there is one rule
   *
   * `who` is the user's own address on every current caller. It is a parameter
   * anyway because the contract's is, and a check that silently assumes the
   * recipient is the caller would be wrong the day one of them changes.
   */
  private async assertCanReceive(asset: Asset, who: string, verb: string): Promise<void> {
    if (asset.isNative()) return;
    const tl = await readTrustline(this.server(), who, asset);
    if (!tl) {
      throw new TrustlineRequiredError(
        `You need a ${asset.getCode()} trustline before you can receive it. ` +
          `Add ${asset.getCode()} to your assets first, then ${verb}.`,
      );
    }
    if (!tl.authorized) {
      throw new TrustlineRequiredError(
        `Your ${asset.getCode()} trustline is not authorised by its issuer, so this account ` +
          `cannot receive ${asset.getCode()} yet. The issuer has to approve it.`,
      );
    }
  }

  private async assertCanSpend(asset: Asset, amount: bigint, feeStroops = BigInt(BASE_FEE)) {
    const { address } = requireSession();
    const fee = feeStroops;
    if (asset.isNative()) {
      const native = await readNative(this.server(), address);
      const reserve = minimumBalance(native, BASE_RESERVE_STROOPS);
      const unreserved = availableToSend({ ...native, reserve });
      // The FEE comes out of the same balance, and this guard did not count it.
      // So the exact unreserved figure, which is the number the compose screen
      // shows and the one a careful user types by hand, passed every check the
      // wallet makes and then failed on chain as `txINSUFFICIENT_BALANCE` for
      // want of 100 stroops: a fee charged, a sequence number consumed, and an
      // opaque error, which is precisely the outcome the comment above says
      // this guard exists to prevent. "Use max" was the only path that got it
      // right, because `sendableAfterFee` subtracts it there.
      const sendable = unreserved > fee ? unreserved - fee : 0n;
      if (amount > sendable) {
        throw new InsufficientBalanceError(
          `That is more than you can send. Your balance is ${formatAmount(native.raw)} XLM, ` +
            `of which ${formatAmount(reserve)} XLM is locked by the network as a reserve and ` +
            `${formatAmount(fee)} XLM pays the network fee, leaving ${formatAmount(sendable)} XLM.`,
        );
      }
    } else {
      // The same guard, for the assets the picker now offers. It sat inside
      // `if (asset.isNative())` from a time when XLM was the only sendable
      // thing, so a USDC payment for more than the trustline holds reached the
      // network unchecked and came back as an opaque failure with a fee paid.
      //
      // Three separate ways to be refused, and they are different sentences on
      // purpose: no trustline, a trustline the issuer has frozen, and simply
      // not enough. Collapsing them into "insufficient balance" describes the
      // last one and misdescribes the other two.
      const tl = await readTrustline(this.server(), address, asset);
      if (!tl) {
        throw new InsufficientBalanceError(
          `This account does not hold ${asset.getCode()}, so there is nothing to send. ` +
            `Adding the asset creates a trustline for it.`,
        );
      }
      if (!tl.authorized) {
        throw new InsufficientBalanceError(
          `The issuer of ${asset.getCode()} has not authorised this account to hold it, so ` +
            `Pocket cannot send it. The balance is ${formatAmount(tl.raw)} ${asset.getCode()} ` +
            `and the issuer controls whether it can move.`,
        );
      }
      const sendable = availableToSend(tl);
      if (amount > sendable) {
        // The fee is XLM and is not deducted from THIS asset: it does not come
        // out of it. Whether the account can cover that fee is a separate
        // question, asked below.
        throw new InsufficientBalanceError(
          `That is more than you can send. Your ${asset.getCode()} balance is ` +
            `${formatAmount(tl.raw)}, leaving ${formatAmount(sendable)} to send.`,
        );
      }

      // ...and the fee itself, which is paid in XLM whatever is moving. Left
      // unchecked, a wallet holding plenty of USDC and almost no XLM passed
      // every check and failed on chain, and on a Soroban path that fee is not
      // the 100 stroops of a classic payment: it is measured in the hundreds of
      // thousands.
      const native = await readNative(this.server(), address);
      const spare = availableToSend({
        ...native,
        reserve: minimumBalance(native, BASE_RESERVE_STROOPS),
      });
      if (spare < fee) {
        throw new InsufficientBalanceError(
          `This needs ${formatAmount(fee)} XLM for the network fee and only ` +
            `${formatAmount(spare)} XLM is free after the network's reserve. Add a little XLM ` +
            `and try again.`,
        );
      }
    }
  }

  private async doBuildPayment(req: {
    to: string;
    amount: string;
    assetId: string;
    memo?: string;
  }): Promise<{ xdr: string; summary: TransferSummary }> {
    const { address } = requireSession();
    await this.assertNothingUnresolved();
    const to = parseAddress(req.to); // throws on bad checksum
    if (to.kind === "contract") {
      // A classic PaymentOp cannot pay a C-address. Say so here rather than
      // letting it fail opaquely inside the builder after the user has already
      // entered an amount. Paying a contract needs a SAC transfer, which the
      // public pocket does not do yet.
      throw new InvalidAddressKindError(
        "That is a contract address. Pocket can only send to an account address (G...) today.",
      );
    }
    const amount = parseAmount(req.amount);
    const asset = req.assetId === "native" ? Asset.native() : this.assetFromId(req.assetId);

    // Refuse here, not in the popup. Presenting a reserve-adjusted balance is
    // display only: entering more than it still builds, signs and submits, and
    // the failure charges a fee and consumes the sequence number. The check
    // has to sit where it cannot be bypassed by whatever calls the worker.
    await this.assertCanSpend(asset, amount);

    // Does the destination exist? A PaymentOp to an account that does not can
    // never succeed: measured on testnet
    // (tx 45d35eb8bfea22f7107f4b1dd5165305ce5ad4065c334331d94cacdeb3f118f0) it
    // is INCLUDED and FAILS with `paymentNoDestination`, charging the fee and
    // consuming the sequence number. The wallet emitted `createAccount`
    // nowhere, so paying a friend's brand-new address failed every time and
    // said only "failed on chain (txFailed)".
    const createDestination = !(await this.accountExists(to.value));
    if (createDestination) {
      if (!asset.isNative()) {
        throw new AccountNotFoundError(
          `That account does not exist yet, so it cannot hold ${asset.getCode()}. ` +
            `Send it XLM first to create it, then send ${asset.getCode()}.`,
        );
      }
      // Stellar refuses a createAccount below the minimum balance, which is two
      // base reserves. Refused here rather than on chain, where it costs a fee.
      const minimum = 2n * BASE_RESERVE_STROOPS;
      if (amount < minimum) {
        throw new AccountNotFoundError(
          `That account does not exist yet, so this payment would create it, and a new account ` +
            `needs at least ${formatAmount(minimum)} XLM. Send at least that much.`,
        );
      }
    }

    const seq = await this.server().getAccount(address);
    const tx = buildPayment(
      new Account(address, seq.sequenceNumber()),
      { from: address, to: to.value, asset, amount, memo: req.memo, createDestination },
      NETWORKS[this.network].passphrase,
    );

    // Retain the exact envelope we built, keyed by hash. confirmPayment will
    // only sign one of these. The popup is a UI, not a source of truth about
    // what gets signed: without this, the worker would sign any XDR handed to
    // it, including an accountMerge or a setOptions that replaces the signers.
    const handle = tx.hash().toString("hex");
    this.pending.set(handle, { xdr: tx.toXDR(), at: Date.now() });
    this.prunePending();

    return {
      xdr: handle,
      summary: {
        decoded: true,
        to: to.value,
        amount: formatAmount(amount),
        assetCode: asset.isNative() ? "XLM" : asset.getCode(),
        fee: tx.fee,
        memo: req.memo,
        effects: [
          createDestination
            ? `CREATE this account on Stellar and fund it with ${formatAmount(amount)} XLM`
            : `Send ${formatAmount(amount)} ${asset.isNative() ? "XLM" : asset.getCode()} to this address`,
          // Creating an account is a different act from paying one and the
          // review has to say so: it is the signed operation, and the amount
          // becomes the new account's whole balance, most of it locked as its
          // minimum reserve.
          ...(createDestination
            ? [
                `The account does not exist yet. ${formatAmount(2n * BASE_RESERVE_STROOPS)} XLM ` +
                  `of this stays locked as its minimum balance`,
              ]
            : []),
          // The memo is signed, so it is an effect. Stating its absence too:
          // a missing memo is the usual way an exchange deposit is lost.
          req.memo ? `Attach the memo "${req.memo}"` : "Send with NO memo",
          `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
        ],
      },
    };
  }

  /**
   * Refuse when the slot already holds a DIFFERENT unresolved submission.
   *
   * The backstop `inFlightSink.record` has always applied, extracted so
   * `signAndSubmit` can ask it BEFORE it writes anything. It used to be asked
   * only from inside `submitAndConfirm`, which `writeStaged` runs ahead of, so
   * a submission this was about to refuse had already overwritten
   * `pocket.staged`: one slot, holding the only copy of the earlier operation's
   * post-state, destroyed by an attempt that then reported a clean refusal.
   *
   * Same hash is not another submission: that is a retry of this one, and
   * `submitAndConfirm` is safe to call again on an envelope it already recorded.
   */
  private async assertNotHoldingAnother(hash: string): Promise<void> {
    const held = await this.inFlight();
    if (held && !held.expired && held.hash !== hash) {
      throw new UnresolvedTransactionError(
        "A transaction submitted earlier has not resolved yet, and it may still land. " +
          "Pocket will not submit another one over it. Reopen Pocket and check it first.",
      );
    }
  }

  /**
   * Does this account exist on the ledger?
   *
   * Only "yes" and "no" are answers. A read that FAILS is neither, and must not
   * be read as "no": concluding absence from an RPC timeout would turn an
   * ordinary payment into a createAccount, which fails on chain against an
   * account that does exist and charges for it. So the failure propagates and
   * the send is refused, which is the same rule `balances()` states for itself.
   */
  private async accountExists(who: string): Promise<boolean> {
    try {
      await readNative(this.server(), who);
      return true;
    } catch (e) {
      if (e instanceof AccountNotFoundError) return false;
      throw e;
    }
  }

  /**
   * Refuse to build anything while an earlier submission is unresolved.
   *
   * The unfinished-transaction screen only appears when the popup mounts, so a
   * popup left open after a timeout would otherwise walk straight back into
   * composing a second payment against a sequence number the first may still
   * consume. Once the first envelope's time bounds have passed it can never be
   * included, and building again is safe.
   */
  private async assertNothingUnresolved(): Promise<void> {
    const e = await this.inFlight();
    if (!e || e.expired) return;
    throw new UnresolvedTransactionError(
      "A transaction submitted earlier has not resolved yet, and it may still land. " +
        "Reopen Pocket and check it before sending anything else.",
    );
  }

  /**
   * The in-flight slot, written and cleared in ONE place.
   *
   * There were two sinks and they disagreed: both `clear`s were meant to be
   * hash-guarded and only one was, while BOTH `record`s wrote unconditionally.
   * That asymmetry is what made a second submission able to erase the pointer to
   * a first one that had already landed. `applyStaged` is keyed on this record,
   * so losing it means the openings of the landed operation are never written,
   * and on a build with no archive they cannot be re-derived: funds visible on
   * chain and permanently unspendable.
   *
   * `assertNothingUnresolved` is the primary guard and runs at BUILD time. This
   * is the backstop, and it has to exist because the build-time check cannot see
   * a submission that starts while it is running.
   *
   * Refusing here aborts before `sendTransaction`, so nothing is submitted and
   * no sequence number is consumed. The legitimate two-transaction flows are
   * unaffected: a shield's follow-merge and a CCTP approve-then-burn each clear
   * their first record on its terminal outcome before recording the second.
   */
  private inFlightSink(kind?: string) {
    return {
      record: async (e: { hash: string; maxTime: number }) => {
        await this.assertNotHoldingAnother(e.hash);
        // WHEN, so a reader can tell a confirm that is merely in progress from
        // one nobody ever saw the end of. the record is written BEFORE
        // `sendTransaction` and cleared only on a terminal outcome, so it is on
        // disk for the whole of an ordinary confirm: a popup dismissed and
        // reopened during one found it and showed the full-screen "Unfinished
        // transaction" blocker, contradicting the "this will continue in the
        // background" the processing view had promised seconds earlier and
        // removing every other control. deriving this from `maxTime` instead
        // would be guesswork; the writer knows.
        await writeLocal(KEYS.inFlight, { ...e, at: Date.now(), ...(kind ? { kind } : {}) });
      },
      // The ledger answered "not here" about this hash, inside its window.
      //
      // Hash-guarded for the same reason `clear` is: a keep-alive answering
      // beside a payment must not mark the payment's record. Written as a patch
      // rather than a whole record so a concurrent `record` cannot be undone by
      // a stale copy read before it.
      answered: async (hash: string) => {
        const e = await readLocal<{ hash: string }>(KEYS.inFlight);
        if (e?.hash === hash) await writeLocal(KEYS.inFlight, { ...e, answered: true });
      },
      // Only ever clear our own. Without the check, a keep-alive resolving
      // beside a payment erases the payment's record, and the unfinished
      // transaction screen never appears for the one that matters.
      clear: async (hash: string) => {
        const e = await readLocal<{ hash: string }>(KEYS.inFlight);
        if (e?.hash === hash) await removeLocal(KEYS.inFlight);
      },
    };
  }

  private assetFromId(id: string): Asset {
    const [code, issuer] = id.split(":");
    if (!code || !issuer) throw new Error(`unknown asset: ${id}`);
    return new Asset(code, issuer);
  }

  /**
   * The deployment a private op runs against.
   *
   * With more than one confidential wrapper configured (XLM, USDC, ...), the
   * caller names which via `asset`: the wrapper token (preferred), the underlying
   * SAC, or the symbol. No asset means the primary (first configured), so every
   * pre-multi-asset caller resolves exactly as before.
   */
  private confidentialConfig(asset?: string): ConfidentialDeployment {
    const list = NETWORKS[this.network].confidential;
    if (asset) {
      const found = list.find(
        (c) => c.token === asset || c.underlying === asset || c.symbol === asset,
      );
      if (!found) {
        throw new PrivatePocketError(
          "No private pocket is deployed for that asset on this network.",
        );
      }
      return found;
    }
    const cfg = list[0];
    if (!cfg) throw new PrivatePocketError("No private pocket is deployed on this network.");
    return cfg;
  }

  private async opContext(asset?: string): Promise<OpContext> {
    const cfg = this.confidentialConfig(asset);
    const { BundledCircuits } = await import("./circuits");
    return {
      server: this.server(),
      networkPassphrase: NETWORKS[this.network].passphrase,
      tokenId: cfg.token,
      auditorRegistryId: cfg.auditor,
      keypair: this.keypair(),
      circuits: new BundledCircuits(),
    };
  }

  /**
   * Build a private-pocket operation, prove it, and return what the approval
   * screen renders. Nothing is signed and nothing is persisted here.
   *
   * Proving takes a few hundred milliseconds and happens in the offscreen
   * document, so this is the slow call in the private pocket. The resulting
   * envelope is retained by handle exactly as buildPayment does, so the bytes
   * signed at confirm are the bytes summarised here.
   */
  async buildPrivateOp(
    req: PrivateOpRequest,
    asset?: string,
  ): Promise<{ handle: string; summary: PrivateOpSummary }> {
    return this.exclusive(async () => {
      try {
        return await this.doBuildPrivateOp(req, asset);
      } finally {
        // Whatever happened, the worker is no longer mid-phase. Leaving a
        // stale phase behind would have the popup narrate a step that ended.
        this.setPhase(null);
      }
    });
  }

  private async doBuildPrivateOp(
    req: PrivateOpRequest,
    asset?: string,
  ): Promise<{ handle: string; summary: PrivateOpSummary }> {
    const { address } = requireSession();
    // No operation is exempt from this, including a merge. The full history,
    // because it was narrowed twice and was wrong both times:
    //
    // 1. The first version exempted EVERY merge, arguing a merge is idempotent
    //    in effect: it folds the whole receiving balance into spendable, so a
    //    repeat folds nothing. True, and it answers the wrong risk. The guard is
    //    about the SEQUENCE NUMBER, and a merge consumes one like anything else,
    //    so a merge built while a payment was unresolved took the sequence that
    //    payment had already claimed.
    //
    // 2. The second version exempted a merge only when the unresolved record was
    //    itself a merge, for the shield-recovery case: a deposit lands, its
    //    follow-merge does not, and the wallet tells the user to press "Make
    //    spendable". That is still unsafe, and it is how a wallet lost openings.
    //    An unresolved merge is one whose outcome is UNKNOWN, not one known to
    //    have failed (a terminal failure clears the record). It may still land.
    //    A second merge takes its sequence number, so the first is included and
    //    the second is rejected, and the rejection deletes the in-flight and
    //    staged records that the second submission had already relabelled with
    //    its own hash. Nothing then names the merge that actually landed,
    //    `applyStaged` never runs for it, and the pocket reads `diverged`.
    //
    // There is no third narrowing to find. `assertNothingUnresolved` already
    // returns early once the earlier envelope's time bounds have passed, which
    // is exactly when a second attempt becomes safe, so any exemption narrow
    // enough to be correct is one this line already grants.
    //
    // The dead end that motivated the exemption is closed on the other side
    // instead: the shield-failure message below now sends the user to reopen
    // Pocket, which reconciles the unresolved merge and, if it truly failed,
    // clears the record so "Make spendable" builds normally.
    await this.assertNothingUnresolved();
    const cfg = this.confidentialConfig(asset);
    // Trap 14: refuse to prove against a deployment whose verification key is
    // not the one this build proves against. A mismatch otherwise surfaces as
    // an opaque contract error at submit time, after the user has waited
    // through proving and signed.
    // Before the VK check and the circuit load, both of which are slow and
    // neither of which can rescue a request that was never going to be built.
    const refusal = refusePrivateOp(req, address);
    if (refusal) throw new PrivatePocketError(refusal);

    // Before the verification-key read and long before the proof, which can
    // take 165 seconds.
    //
    // `withdraw` ends in `token.transfer(contract, to, amount)` on the
    // underlying SAC (storage.rs:629-630), and a classic asset arriving at a G
    // address needs a trustline there. Checked after proving, the user waits
    // nearly three minutes to be told to check their connection; checked here,
    // they are told the one thing they can act on before anything happens at
    // all. Nothing about this refusal depends on the verifier or the circuit,
    // so it belongs ahead of both.
    //
    // By SYMBOL, for the same reason the shield path uses it: the wrapper
    // records its underlying as a SAC contract id, which `Asset` cannot be
    // built from. A symbol this build does not know yields null, and an unknown
    // asset is not one this check can speak about.
    if (req.kind === "unshield") {
      const out = this.assetForSymbol(cfg.symbol);
      if (out) await this.assertCanReceive(out, address, "unshield");
    }

    const circuit = CIRCUIT_FOR[req.kind];
    // Each phase is named as it STARTS, and only when it really starts. The
    // popup polls this; nothing is invented and no percentage is implied.
    if (circuit) {
      this.setPhase("Checking this deployment's verification key…");
      await this.assertVk(cfg, circuit);
    }
    this.setPhase("Loading the circuit…");
    const ctx = await this.opContext(cfg.token);
    const ops = await import("./confidential-ops");

    switch (req.kind) {
      case "register": {
        // D8: the user is their own auditor. The id is NOT chosen by the
        // caller; it is allocated by the registry and read back out, so this
        // ensures a key of ours is registered and returns the id it got.
        this.setPhase("Registering your auditor key…");
        const auditorId = await this.ownAuditorId(ctx, cfg);
        this.setPhase("Building and proving. This is the slow part…");
        const { tx: rawRegister, openings } = await ops.buildRegister(ctx, auditorId);
        // Simulated now, so the fee below is the fee that gets signed.
        const tx = await this.prepareForReview(rawRegister);
        this.setPhase(null);
        return this.stagePrivate(
          tx,
          {
            kind: "register",
            effects: [
              "Create a confidential account for this address",
              "Bind your OWN auditor key, derived from your recovery phrase. " +
                "Nobody else can read your amounts",
              "This binding is permanent and cannot be changed for this account",
              "Publish that this address has a private pocket. This is not reversible",
              `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
            ],
          },
          { resolve: openingsResolution({ ...openings, syncedThrough: 0 }) },
          cfg.token,
        );
      }

      case "shield": {
        const amount = parseAmount(req.amount);
        // Two transactions: a deposit credits the RECEIVING side, so shielding
        // without the merge leaves a zero spendable balance and no explanation.
        // Only the deposit is retained here. The merge is rebuilt at confirm
        // time against the sequence the deposit actually consumed, which is why
        // the envelope built alongside it was never signed.
        const { deposit: rawDeposit } = await ops.buildShield(ctx, amount);
        const deposit = await this.prepareForReview(rawDeposit);
        // BOTH legs, priced now.
        //
        // A shield is a deposit AND a merge: the deposit credits the RECEIVING
        // side, so without the merge the spendable balance stays at zero. Only
        // the deposit was ever priced, and the merge's fee appeared on no
        // screen, in no effect line and in no receipt. Measured on the shipped
        // XLM wrapper: deposit 110,771 stroops, merge 93,726, so the one number
        // the confirm showed was 54% of what the account was actually charged.
        //
        // `merge(account)` takes no arguments beyond the account and reads the
        // accumulators the contract already holds, so it simulates correctly
        // BEFORE the deposit lands. The envelope built here is priced and
        // discarded: the one that gets signed is rebuilt at confirm time
        // against the sequence the deposit actually consumed.
        const mergeQuote = await this.prepareForReview(await ops.buildMerge(ctx));
        const totalFee = BigInt(deposit.fee) + BigInt(mergeQuote.fee);
        // The real fee. A native shield was measured at 350,412 stroops on this
        // deployment, against the 100 the pre-build guard has to assume, so
        // "use max" plus a base-fee reservation produced an amount the account
        // could not actually pay for.
        // By SYMBOL: the wrapper records its underlying as a SAC contract id,
        // which is not something `Asset` can be built from.
        const shielded = this.assetForSymbol(cfg.symbol);
        // Sized for BOTH, which is what stops the deposit landing and the merge
        // failing for want of a fee. That left the funds in the receiving
        // balance, spendable only after a top-up, immediately after the wallet
        // said it had checked the account could afford this.
        if (shielded) await this.assertCanSpend(shielded, amount, totalFee);
        return this.stagePrivate(
          deposit,
          {
            kind: "shield",
            amount: formatAmount(amount),
            effects: [
              `Move ${formatAmount(amount)} ${cfg.symbol} from the public pocket into the private one`,
              "This deposit amount is PUBLIC on the ledger. Only later transfers hide amounts",
              "A second signature then makes it spendable",
              `Pay a network fee of ${formatAmount(totalFee)} XLM across BOTH transactions`,
            ],
          },
          { resolve: { kind: "credit", amount: amount.toString() }, follow: true },
          cfg.token,
          totalFee,
        );
      }

      case "merge": {
        const tx = await this.prepareForReview(await ops.buildMerge(ctx));
        // Read for its refusal, not its value. Merging with no local record of
        // the receiving side would produce a post-state nothing can verify, and
        // the resolution below is computed from storage when the merge lands.
        await this.requireOpenings(address, cfg.token);
        return this.stagePrivate(
          tx,
          {
            kind: "merge",
            effects: [
              "Fold everything you have received into your spendable balance",
              "Amounts stay hidden. This proves nothing and reveals nothing",
              `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
            ],
          },
          { resolve: { kind: "merge" } },
          cfg.token,
        );
      }

      case "transfer": {
        const amount = parseAmount(req.amount);
        // Already refused above if it is not a G-address or if it is ours.
        const to = parseAddress(req.to);
        const stored = await this.requireOpenings(address, cfg.token);
        if (amount > stored.spendable.value) {
          throw new PrivatePocketError(
            `That is more than your spendable balance of ${formatAmount(stored.spendable.value)} ${cfg.symbol}. ` +
              `Received funds must be made spendable first.`,
          );
        }
        const recipient = await this.readOwnAccount(to.value, cfg, "recipient");
        const mine = await this.readOwnAccount(address, cfg);
        this.setPhase("Building and proving. This is the slow part…");
        const { tx: raw, newSpendable } = await ops.buildTransfer(ctx, {
          recipient: to.value,
          recipientPvk: recipient.viewingPublicKey,
          recipientAuditorKey: await this.auditorKeyFor(recipient.auditorId, cfg),
          senderAuditorKey: await this.auditorKeyFor(mine.auditorId, cfg),
          amount,
          spendable: stored.spendable,
          onChainSpendable: mine.spendableCommitment,
        });
        const tx = await this.prepareForReview(raw);
        return this.stagePrivate(
          tx,
          {
            kind: "transfer",
            to: to.value,
            amount: formatAmount(amount),
            effects: [
              `Send ${formatAmount(amount)} ${cfg.symbol} privately to this address`,
              "The AMOUNT is hidden. Both addresses are PUBLIC on the ledger, permanently",
              // Under D8 each side's auditor is itself, so the honest statement
              // is who can read this, not two opaque integers. A7 found this
              // printing "Auditor #0 and auditor #0", which told the user
              // nothing and hid that both were the operator's key.
              recipient.auditorId === mine.auditorId
                ? `You and the recipient share auditor #${mine.auditorId}, which can read this amount`
                : "Your auditor key and the recipient's can each read this amount. Yours is your own",
              `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
            ],
          },
          { resolve: spendResolution(newSpendable) },
          cfg.token,
        );
      }

      case "unshield": {
        const amount = parseAmount(req.amount);
        const stored = await this.requireOpenings(address, cfg.token);
        if (amount > stored.spendable.value) {
          throw new PrivatePocketError(
            `That is more than your spendable balance of ${formatAmount(stored.spendable.value)} ${cfg.symbol}.`,
          );
        }
        const chain = await this.readOwnAccount(address, cfg);
        this.setPhase("Building and proving. This is the slow part…");
        const { tx: raw, newSpendable } = await ops.buildUnshield(ctx, {
          amount,
          spendable: stored.spendable,
          onChainSpendable: chain.spendableCommitment,
          auditorKey: await this.auditorKeyFor(chain.auditorId, cfg),
          destination: address,
        });
        const tx = await this.prepareForReview(raw);
        return this.stagePrivate(
          tx,
          {
            kind: "unshield",
            amount: formatAmount(amount),
            effects: [
              `Move ${formatAmount(amount)} ${cfg.symbol} from the private pocket back to the public one`,
              "This withdrawal amount becomes PUBLIC on the ledger",
              `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
            ],
          },
          { resolve: spendResolution(newSpendable) },
          cfg.token,
        );
      }
    }
  }

  /** Read a confidential account, refusing to guess when it is not there. */
  private async readOwnAccount(
    who: string,
    cfg: { token: string },
    role: "self" | "recipient" = "self",
  ): Promise<ConfidentialAccount> {
    const { address } = requireSession();
    const source = await this.server().getAccount(address);
    const account = await readConfidentialAccount(
      this.server(),
      cfg.token,
      who,
      source,
      NETWORKS[this.network].passphrase,
    );
    if (!account) {
      throw new PrivatePocketError(
        role === "recipient"
          ? "That address has no private pocket, so it cannot receive a private payment. " +
            "They need to set one up first, or you can pay them from the public pocket."
          : "This account has no private pocket yet.",
      );
    }
    return account;
  }

  /** An auditor's registered key. Absent means the transfer cannot be built. */
  private async auditorKeyFor(auditorId: number, cfg: { auditor: string }): Promise<Point> {
    const { address } = requireSession();
    const source = await this.server().getAccount(address);
    const key = await readAuditorKey(
      this.server(),
      auditorId,
      cfg.auditor,
      source,
      NETWORKS[this.network].passphrase,
    );
    if (!key) {
      throw new PrivatePocketError(
        `Auditor #${auditorId} has no registered key, so this operation cannot be proved.`,
      );
    }
    return key;
  }

  /** Openings, or a refusal. Spending without them would build a bad proof. */
  private async requireOpenings(address: string, token: string) {
    const stored = await this.readOpenings(address, token);
    if (!stored) {
      throw new PrivatePocketError(
        "This device has no record of your private balances, so it cannot spend them. " +
          `Your funds are safe on chain. ${rebuildAdvice(NETWORKS[this.network].archiveUrl)}`,
      );
    }
    return stored;
  }

  /**
   * Retain a built private operation and the state that follows it.
   *
   * The post-state is staged rather than written, because until the
   * transaction lands neither the old nor the new opening is known to be the
   * true one. Both are kept and resolved against the chain's own commitment at
   * confirm, which is the only authority on which happened.
   */
  private stagePrivate(
    tx: Transaction,
    summary: Omit<PrivateOpSummary, "fee">,
    after: StagedAfter,
    token: string,
    /**
     * Total fee across EVERY transaction this action will sign, when that is
     * more than the one being staged.
     *
     * A shield is a deposit AND a merge, and the confirm quoted the deposit
     * alone: measured on the shipped XLM wrapper, deposit 110,771 stroops and
     * merge 93,726, so the single number on the approval screen was 54% of the
     * real cost. Nothing in the codebase held the count, which is why the same
     * absent value surfaced as an understated fee, a guard that sized one leg
     * of two, and receipts that dropped a hash the worker had returned.
     */
    totalFeeStroops?: bigint,
  ): { handle: string; summary: PrivateOpSummary } {
    const handle = tx.hash().toString("hex");
    this.pending.set(handle, {
      xdr: tx.toXDR(),
      at: Date.now(),
      private: after,
      kind: summary.kind,
      // The op's OWN confidential token, so confirm (and the shield follow-merge,
      // and the staged record) act on this asset, not whatever is configured
      // first. Without it a USDC op would stage and merge against XLM.
      token,
    });
    this.prunePending();
    return {
      handle,
      summary: { ...summary, fee: formatAmount(totalFeeStroops ?? BigInt(tx.fee)) },
    };
  }

  /**
   * Sign and submit a private operation this controller built and proved.
   *
   * Openings are written only after the ledger has accepted it, and they are
   * verified against the commitment the contract now holds before being
   * trusted. A mismatch is reported rather than stored: a wrong opening is
   * indistinguishable from a lost one later, and both make funds unspendable.
   */
  async confirmPrivateOp(
    handle: string,
  ): Promise<{ hash: string; ledger: number; followed?: string }> {
    return this.exclusive(async () => {
      try {
        return await this.doConfirmPrivateOp(handle);
      } finally {
        this.setPhase(null);
      }
    });
  }

  private async doConfirmPrivateOp(
    handle: string,
  ): Promise<{ hash: string; ledger: number; followed?: string }> {
    this.prunePending();
    const entry = this.pending.get(handle);
    if (!entry?.private) {
      throw new PrivatePocketError(
        "That operation is no longer pending confirmation. Build it again and review it.",
      );
    }
    this.pending.delete(handle);

    const { TransactionBuilder, Transaction: Tx } = await import("@stellar/stellar-sdk/base");
    const decoded = TransactionBuilder.fromXDR(entry.xdr, NETWORKS[this.network].passphrase);
    if (!(decoded instanceof Tx)) throw new Error("refusing to sign a fee-bump envelope here");
    if (decoded.source !== requireSession().address) {
      throw new Error("refusing to sign a transaction from a different source account");
    }

    // The summary already names the operation, so the kind is taken from there
    // rather than duplicated onto the staged record where the two could drift.
    const outcome = await this.submitStaged(
      decoded,
      entry.private.resolve,
      entry.kind,
      entry.token,
    );
    if (outcome.kind !== "succeeded")
      throw new SubmitOutcomeError(describeOutcome(outcome), outcome);
    // A new confidential event exists now; the cached history is stale (it will
    // repopulate from the archive once that event is ingested).
    this.privHistoryMemo = undefined;

    if (!entry.private.follow) return { hash: outcome.hash, ledger: outcome.ledger };

    // A shield is two transactions, and the deposit has now landed. Its credit
    // is already written, which is what makes the failure below survivable: the
    // local record matches the ledger, so the receiving balance is real and one
    // more signature spends it. Writing only after BOTH succeeded left the
    // wallet diverged from the chain by exactly the deposit, unspendable, and
    // pointing the user at a button the diverged screen does not offer.
    const ops = await import("./confidential-ops");
    // The SAME asset as the deposit. Rebuilding via the default deployment here
    // would prove and merge against the first-configured wrapper, not the one
    // the user shielded into.
    const ctx = await this.opContext(entry.token);
    const mergeTx = await ops.buildMerge(ctx);
    // A shield is TWO transactions, each with its own confirmation poll. The
    // user learned about the second one afterwards, in the receipt. Name it
    // while it is happening instead.
    this.setPhase("Deposit confirmed. Making it spendable, one more transaction…");
    const second = await this.submitStaged(mergeTx, { kind: "merge" }, "merge", entry.token);
    if (second.kind !== "succeeded") {
      const deposited =
        entry.private.resolve.kind === "credit"
          ? formatAmount(BigInt(entry.private.resolve.amount))
          : null;
      // The asset that was actually shielded, never a hardcoded "XLM". A wrapper
      // binds ONE underlying, so the symbol belongs to the deployment this
      // operation ran against; with USDC configured, the literal named the wrong
      // asset in the one message a user reads after a half-completed shield.
      // Safe to look up: opContext above resolved the same token and would
      // already have thrown if it were not a configured deployment.
      const symbol = this.confidentialConfig(entry.token).symbol;
      // What to do next depends on whether the merge is DEAD or merely UNKNOWN,
      // and telling the user the wrong one is how this became a dead end before.
      //
      // A terminal failure clears the in-flight record, so "Make spendable"
      // builds normally and saying so is correct. A `pending` outcome leaves the
      // record in place, because the merge may still land; pressing again would
      // be refused, and if it were not it would take that merge's sequence
      // number. So that case is sent to reopen Pocket, which reconciles the
      // record: if the merge landed, its openings are written and nothing more
      // is needed; if it did not, the record clears and the button works.
      const unknown = second.kind === "pending";
      throw new PrivatePocketError(
        `The deposit succeeded (${outcome.hash}) but making it spendable did not. ` +
          (deposited
            ? `Your ${deposited} ${symbol} is in the receiving balance`
            : "Your funds are in the receiving balance") +
          `, and Pocket has recorded it. ` +
          (unknown
            ? "Pocket does not yet know whether that second transaction landed, so reopen it: " +
              "it will check, and offer to finish if it did not."
            : `Press "Make spendable" to finish.`),
      );
    }
    return { hash: outcome.hash, ledger: outcome.ledger, followed: second.hash };
  }

  /**
   * Submit, and write the consequence the moment the ledger confirms it.
   *
   * The resolution is staged to DISK before submission, not held in memory.
   * Between `sendTransaction` and the write sit a confirmation poll of some
   * seconds and a second chain read, and MV3 will evict the worker inside that
   * window without warning. Held only in memory, a transfer's new opening dies
   * there while the chain moves on, and no opening means a balance that is
   * visible on chain and permanently unspendable. On disk, the in-flight record
   * leads a later worker straight back to it.
   */
  private async submitStaged(
    tx: Transaction,
    resolve: StagedResolution | null,
    kind?: string,
    token?: string,
  ): Promise<SubmitOutcome> {
    const outcome = await this.signAndSubmit(tx, resolve, kind, token);
    if (outcome.kind === "succeeded") {
      // Consequence FIRST, record second, and the order is the whole point.
      // `applyStaged` throws on a chain read that fails and on a post-state the
      // chain disagrees with, and in both cases the in-flight record has to
      // survive: it is the only thing `reconcileInFlight` reads, and the staged
      // opening it leads back to is the only copy that exists. Cleared here
      // rather than inside `submitAndConfirm`, which used to do it the moment
      // the ledger answered, one line before this write could fail.
      await this.applyStaged(outcome.hash);
      await this.inFlightSink().clear(outcome.hash);
    } else if (outcome.kind !== "pending") await this.discardStaged(outcome.hash);
    return outcome;
  }

  /**
   * Simulate now, so the fee a review states is the fee that gets signed.
   *
   * A Soroban envelope leaves the builder carrying `BASE_FEE`, 100 stroops, and
   * `prepareTransaction` later rewrites it to base plus the simulated resource
   * fee. Every summary read the fee off the BUILDER, so the private pocket's
   * confirm said "Network fee 0.0000100 XLM" over an envelope that pays an
   * UltraHonk verification fee orders of magnitude larger. Nobody gains the
   * difference, but it is a signed fact stated wrongly, which is the one thing
   * the confirm step exists to prevent.
   *
   * Preparing here and again in `signAndSubmit` is safe: `assembleTransaction`
   * subtracts any resource fee already on the envelope before adding the
   * simulated one (stellar-sdk rpc/transaction.js), so it is idempotent by
   * design. Preparing at build also means the bytes the user reviewed are the
   * bytes that get signed.
   */
  private async prepareForReview(tx: Transaction): Promise<Transaction> {
    return this.simulate(tx);
  }

  /**
   * Simulate, and say what the contract said when it refuses.
   *
   * The one route from an envelope to the ledger, so it is the one place a
   * contract refusal can be named. stellar-sdk throws a BARE `Error` from
   * `prepareTransaction` (rpc/server.js:1098), whose name is on neither
   * allowlist in `dispatch.ts`, so every refusal on every write path rendered
   * as "check your connection" and the fifteen authored sentences in
   * `CONTRACT_ERRORS` were unreachable.
   */
  private async simulate(tx: Transaction): Promise<Transaction> {
    try {
      return await this.server().prepareTransaction(tx);
    } catch (e) {
      throw explainSimulationFailure(e);
    }
  }

  private async signAndSubmit(
    tx: Transaction,
    resolve: StagedResolution | null = null,
    kind?: string,
    token?: string,
  ): Promise<SubmitOutcome> {
    // A Soroban invocation needs its footprint and auth entries populated, and
    // simulation is the only thing that can do it. Signing before this would
    // produce an envelope the network rejects at once.
    this.setPhase("Simulating against the ledger…");
    const prepared = await this.simulate(tx);
    // The precondition `submitAndConfirm` states in words, enforced at the one
    // point every envelope passes through. Without a decidable expiry a stuck
    // transaction can never be safely rebuilt: `inFlight()` reports it live
    // forever, the unfinished-transaction screen sits in front of the whole
    // wallet on every mount, and the only way out is erase, which destroys every
    // opening. See `assertExpirable`.
    assertExpirable(prepared);
    this.setPhase("Signing…");
    prepared.sign(this.keypair());
    this.setPhase("Submitting, then waiting for the ledger to confirm…");

    // The in-flight backstop, asked BEFORE anything is written.
    //
    // It used to live only inside `submitAndConfirm`, which `writeStaged` runs
    // ahead of. So a submission the backstop was about to REFUSE had already
    // overwritten `pocket.staged`, and that slot holds exactly one record: the
    // post-state of the earlier operation, which is the only copy that exists
    // and the only thing `reconcileInFlight` can apply. The refusal then
    // propagated as an error and the caller saw a clean rejection, while the
    // record it was protecting had already been destroyed by the attempt.
    //
    // Asking here makes the refusal true: nothing is written and nothing is
    // sent. `submitAndConfirm` still asks again on its own way through, because
    // a submission can start between these two lines and that one is the check
    // that runs immediately before the envelope leaves.
    const preparedHash = prepared.hash().toString("hex");
    await this.assertNotHoldingAnother(preparedHash);

    if (resolve) {
      // Simulation rewrites the envelope, so the hash to stage against is the
      // prepared one, not the hash the approval screen was keyed by.
      const { address } = requireSession();
      await this.writeStaged({
        hash: preparedHash,
        // The op's own token, threaded from confirm. Falls back to the primary
        // only for a staged write with no token supplied, which today never
        // happens on the private path.
        token: token ?? this.confidentialConfig().token,
        address,
        resolve,
      });
    }

    // The KIND travels with the record so a stranded merge can be told from a
    // stranded payment. Without it the merge exemption would have to trust its
    // caller rather than check.
    return submitAndConfirm(this.server(), prepared, {
      inFlight: this.inFlightSink(kind),
      // A staged resolution is a consequence only this device can write, so
      // this submission is not settled when the ledger says so. `submitStaged`
      // clears the record after the write lands. See `Settles`.
      settles: resolve ? "caller" : "chain",
    });
  }

  /** Store openings only once the chain agrees they open what it holds. */
  private async persistVerified(
    address: string,
    cfg: { token: string },
    state: { spendable: Opening; receiving: Opening; syncedThrough: number },
    hadRecord = true,
  ): Promise<void> {
    const account = await this.readOwnAccount(address, cfg);
    const check = verifyAgainstChain(state, account);
    if (!check.ok) {
      // Two different situations, and telling them apart is the difference
      // between a user who should investigate and one who simply needs their
      // balances rebuilt. Blaming a divergence when this device never held a
      // record sends them looking for a problem that is not there.
      const advice = rebuildAdvice(NETWORKS[this.network].archiveUrl);
      throw new PrivatePocketError(
        hadRecord
          ? `The transaction landed, but the ${check.which} balance this device computed does not ` +
            `match what the contract now holds. Your funds are safe on chain. Pocket will not ` +
            `spend from a state it cannot verify. ${advice}`
          : `The transaction landed, but this device has no record of your private balances, so ` +
            `it cannot work out what you now hold. Your funds are safe on chain. ${advice}`,
      );
    }
    await this.writeOpenings(address, cfg.token, state);
  }

  /**
   * Check the confidential account's TTL and bump it if it is close to
   * archiving. Returns when to look again.
   *
   * Only possible while unlocked: the bump is a signed transaction, so a
   * locked wallet cannot make one. That limitation is stated on the screen
   * rather than papered over, because a user who closes their browser for a
   * month will archive regardless of what this schedules.
   */
  async runKeepAlive(): Promise<KeepAlivePlan> {
    return this.exclusive(() => this.doRunKeepAlive());
  }

  private async doRunKeepAlive(): Promise<KeepAlivePlan> {
    const session = getSession();
    const list = NETWORKS[this.network].confidential;
    if (!session || list.length === 0) return { due: false, nextCheckMs: jitteredDelayMs(7) };

    // An alarm fires whenever it likes, including on top of an unresolved user
    // submission. Two envelopes against one sequence number means one of them
    // fails; a keep-alive is never worth that.
    const unresolved = await this.inFlight();
    if (unresolved && !unresolved.expired) return { due: false, nextCheckMs: jitteredDelayMs(1) };

    // Each configured wrapper is its OWN confidential account with its OWN TTL.
    // Bumping only the first would let every other asset's account archive
    // silently. They run one at a time (each awaits its own confirmation), so
    // the account sequence a later bump reads already reflects the earlier one.
    //
    // The soonest any asset wants looking at again, and the notice belonging to
    // it. Returning a flat seven days discarded every per-asset plan the loop
    // had just computed, including the urgent ones: on the live deployment the
    // XLM wrapper had 22 days of headroom and the USDC wrapper 6.8, and the
    // caller was told to come back in a week either way.
    let soonest = jitteredDelayMs(7);
    let notice: string | undefined;

    for (const cfg of list) {
      const ttl = await readAccountTtl(this.server(), cfg.token, session.address, this.network);
      const plan = planKeepAlive(ttl, this.recentlyActive(cfg.token));
      if (plan.nextCheckMs < soonest) soonest = plan.nextCheckMs;
      notice ??= plan.notice;
      if (!plan.due) continue;

      // A merge is NOT a no-op, and this loop submitted it as one.
      //
      // `storage::merge` is unconditional: `spendable = spendable + receiving`
      // then `receiving = identity`, with no guard on receiving being empty
      // (storage.rs:539-547). keepalive.ts says "a merge on an empty receiving
      // balance is a no-op in state terms", which is true only for the empty
      // case, and nothing here restricted it to that case. So a background
      // alarm firing against a pocket holding a received-but-unmerged balance
      // moved the chain's accumulators while this device wrote nothing, and the
      // next read of that pocket returned `diverged`: every spend refused, by an
      // action the user never took and never saw. The offered exit is
      // `rebuildFromHistory`, which `rebuildAdvice` itself says is impossible
      // with no archive configured.
      //
      // Staged like every other private submission, so `applyStaged` folds the
      // same two accumulators locally that the contract folded on chain, and
      // `persistVerified` checks the result against the commitment the contract
      // now holds before it is written.
      const stored = await this.readOpenings(session.address, cfg.token);
      if (!stored) {
        // No local record to fold, so there is no post-state this device could
        // verify: submitting would produce exactly the divergence above, only
        // with nothing to reconcile against. Skipped rather than bumped, and
        // skipped rather than thrown, so one unreadable asset does not stop the
        // bump every other asset may be due.
        //
        // Letting the entry archive is the lesser harm on this deployment:
        // protocol 27 auto-restores an archived persistent entry into the
        // readWrite footprint rather than failing the transaction.
        continue;
      }
      // Fetched per bump: two bumps from one stale source object would collide
      // on the sequence number.
      const source = await this.server().getAccount(session.address);
      const tx = buildKeepAlive(
        source,
        cfg.token,
        session.address,
        NETWORKS[this.network].passphrase,
      );
      // `submitStaged`, not `signAndSubmit`: staging a consequence and never
      // applying it is worse than not staging one, because the record then
      // points at a post-state nothing writes. This is the wrapper that writes
      // the consequence FIRST and clears the in-flight record second, and it is
      // the path every other private submission already takes.
      const outcome = await this.submitStaged(tx, { kind: "merge" }, "merge", cfg.token);
      // PER TOKEN, and that is the whole fix. This was one shared timestamp
      // assigned inside this loop, and `recentlyActive` is tested at the top of
      // every later iteration, so the first asset to need a bump told every
      // asset after it that its entry had just been touched. It had not: these
      // are separate ledger entries with separate TTLs, and bumping one does
      // nothing for another. On the live deployment that is exactly backwards
      // from what is needed, because the wrapper that comes first has 22 days
      // of headroom and the one it silences has 6.8.
      if (outcome.kind === "succeeded") this.lastKeepAlive.set(cfg.token, Date.now());
    }
    return { due: false, nextCheckMs: soonest, ...(notice ? { notice } : {}) };
  }

  /** Verification keys already confirmed this session, per (deployment, circuit). */
  private vkChecked = new Set<string>();

  /**
   * The auditor id holding THIS account's own key, registering it if needed.
   *
   * D8's whole point. Before this, registration passed a hardcoded 0, which on
   * our deployment is the deployer's key, so every user permanently granted
   * the operator read access to every amount they ever sent or received.
   *
   * The id is allocated by the registry and RETURNED, never chosen, so it must
   * be persisted: a retry that re-registers would orphan the first key and
   * allocate a second. And the key is read back and compared before the id is
   * ever named in a confidential register, because that binding is immutable
   * for the life of the account and there is no second chance at it.
   */
  private async ownAuditorId(
    ctx: OpContext,
    cfg: { auditor: string; token: string },
  ): Promise<number> {
    const { address } = requireSession();
    // Keyed by the TOKEN as well as the shared registry. The auditor registry is
    // shared across wrappers, but the account's own auditor key is derived per
    // token (keys/auditor.ts binds the wrapper address), so XLM and USDC produce
    // different keys. Without the token here they would collide on one id slot,
    // and registering the second asset would reuse the first's id, whose
    // on-chain key does not match, so the bind check refuses it.
    const key = `${KEYS.auditorId}.${cfg.auditor}.${cfg.token}.${address}`;
    const ops = await import("./confidential-ops");
    const { publicKey } = await ops.deriveOwnAuditorKey(ctx);

    const recorded = await readLocal<number>(key);
    if (recorded !== undefined) {
      await this.assertRegisteredKeyMatches(recorded, cfg, publicKey);
      return recorded;
    }

    // Registration contends. The id comes from a monotonic counter in the
    // registry's INSTANCE storage, so two accounts registering at once touch
    // the same ledger entry and Soroban fails the loser rather than serialising
    // it. A failed register writes nothing, so retrying is safe and cannot
    // orphan a key: the id is persisted only after success.
    // Retry ONLY outcomes known to have consumed nothing. `pending` is not one
    // of them: it means "we do not know, it may still land", and
    // `describeOutcome` says so in those words. Resending it is the exact
    // double-spend the in-flight machinery exists to prevent, and it is not
    // exotic under MV3 -- an RPC that stops answering getTransaction inside the
    // 15-second poll produces it. Measured on testnet before this guard: four
    // registrations landed, four registry ids allocated, ZERO recorded (the id
    // is read from the invocation result and a pending outcome carries none),
    // 0.0192 XLM spent, and the user told "Nothing was bound". Each resend also
    // overwrote `pocket.inflight`, so three of the four hashes were off disk
    // permanently and nothing could ever reconcile them.
    const CONSUMED_NOTHING = new Set(["failed", "rejected", "notAccepted", "expired"]);
    let outcome = await this.signAndSubmit(await ops.buildRegisterAuditor(ctx));
    for (let attempt = 1; attempt < 4 && CONSUMED_NOTHING.has(outcome.kind); attempt++) {
      outcome = await this.signAndSubmit(await ops.buildRegisterAuditor(ctx));
    }
    if (outcome.kind !== "succeeded") {
      throw new PrivatePocketError(
        `Registering your auditor key did not succeed after several attempts, so Pocket will ` +
          `not set up the private pocket. Nothing was bound. ${describeOutcome(outcome)}`,
      );
    }
    const allocated = readAllocatedId(outcome);
    if (allocated === null) {
      throw new PrivatePocketError(
        "Your auditor key was registered but Pocket could not read back the id it was given, " +
          "so it will not bind one it cannot verify. Try again.",
      );
    }
    await writeLocal(key, allocated);
    await this.assertRegisteredKeyMatches(allocated, cfg, publicKey);
    return allocated;
  }

  /** The registry must hold OUR key under this id, or we refuse to bind it. */
  private async assertRegisteredKeyMatches(
    auditorId: number,
    cfg: { auditor: string },
    expected: Point,
  ): Promise<void> {
    const onChain = await this.auditorKeyFor(auditorId, cfg);
    const { equals } = await import("./crypto/grumpkin");
    if (!equals(onChain, expected)) {
      throw new PrivatePocketError(
        `Auditor #${auditorId} does not hold this wallet's own key, so Pocket will not bind it. ` +
          `Binding is permanent, and binding someone else's key would let them read every ` +
          `amount you send or receive.`,
      );
    }
  }

  /** Confirm once per session; the keys are immutable, so once is enough. */
  private async assertVk(
    cfg: { verifier: string; token: string },
    circuit: CircuitName,
  ): Promise<void> {
    // Per (token, verifier, circuit): the verifier is shared across wrappers,
    // but the check reads the binding out of THIS token's instance storage, so a
    // pass for one wrapper is not a pass for another.
    const key = `${cfg.verifier}:${cfg.token}:${circuit}`;
    if (this.vkChecked.has(key)) return;
    const { address } = requireSession();
    const source = await this.server().getAccount(address);
    // The token is what makes this check mean anything. Without it we proved
    // only that the verifier our own config names holds a hash our own build
    // pins: two values we chose, agreeing with each other, while the token
    // being invoked could route its proofs somewhere else entirely. Passing it
    // reads the binding out of the token's own instance storage.
    await assertVerificationKey(
      this.server(),
      cfg.verifier,
      circuit,
      source,
      NETWORKS[this.network].passphrase,
      cfg.token,
    );
    this.vkChecked.add(key);
  }

  /**
   * Credit any transfer addressed to this account that this device has not
   * seen, and persist the result.
   *
   * Returns the stored state unchanged when there is nothing to do or when the
   * credit cannot be verified, so an unreadable inbound leaves the pocket in
   * the state it was already in and the divergence check reports it honestly.
   */
  private async creditInboundTransfers(
    stored: { spendable: Opening; receiving: Opening; syncedThrough: number },
    account: ConfidentialAccount,
    cfg: { token: string },
  ): Promise<{ spendable: Opening; receiving: Opening; syncedThrough: number }> {
    const { address } = requireSession();
    // Already agrees with the chain, so nothing is outstanding.
    if (verifyAgainstChain(stored, account).ok) return stored;

    try {
      const ctx = await this.opContext(cfg.token);
      const { deriveConfidentialKeys } = await import("./confidential-ops");
      const { vk } = await deriveConfidentialKeys(ctx);
      const { findInbound, creditInbound, resumeFrom, cursorAfter } = await import("./inbound");
      // `findInbound` clamps to the RPC's reported floor itself, so passing a
      // best guess is safe: asking from before retention is what returns zero
      // events with no error, and the function that talks to the RPC is the
      // one that knows that.
      //
      // Resuming AT the cursor rather than after it re-read the ledger the last
      // scan had already applied, and the all-or-nothing check downstream turns
      // that into a permanent fault rather than a double credit: the pocket
      // stays diverged with the money on chain and no retry that can help. See
      // `resumeFrom`.
      const found = await findInbound(
        this.server(),
        cfg.token,
        address,
        vk,
        resumeFrom(stored.syncedThrough),
      );
      if (found.length === 0) {
        // Not an error, and it must not read as one. It means the search ran
        // and the window held nothing for us, which for a diverged pocket
        // points at history older than the RPC keeps.
        // Says "transfer or deposit" because the scan now looks for both, and
        // the sentence is the wallet's whole explanation of a diverged pocket.
        // While it only looked for transfers it named a cause that was often
        // not the cause: a third-party deposit needs no permission from the
        // recipient, was invisible to this search, and sent the user after
        // history older than a week that was not missing.
        this.lastInboundFailure =
          "Pocket searched the last week of ledger history and found no transfer or deposit " +
          "addressed to this account, so the difference is older than that.";
        return stored;
      }

      // The write goes through the SAME queue every spending write uses, and
      // re-reads inside it. Read-slow-thing-write-back is exactly what broke
      // `create`, and it is worse here: `{ ...stored, receiving }` carried the
      // SPENDABLE opening from a snapshot taken before a scan that paginates
      // the RPC's whole retained window. A merge landing during that scan was
      // overwritten by the stale spendable side, and a spendable opening that
      // no longer matches the chain is money that can never be proved against.
      //
      // `privatePocket()` is a read that happens to write, and the popup calls
      // it on every mount, so two tabs are all it takes.
      //
      // `return await`, not `return`. Without the await the promise is handed
      // back rather than settled here, so nothing thrown inside this block ever
      // reaches the catch below, and that catch is the only thing standing
      // between an RPC-authored or storage-authored message and the diverged
      // screen. `writeOpenings` and `creditInbound` both throw from in here.
      return await this.exclusive(async () => {
        const fresh = (await this.readOpenings(address, cfg.token)) ?? stored;
        // Someone else may have credited or merged while we scanned. Their
        // result is newer than ours; ours is now about a state that is gone.
        if (verifyAgainstChain(fresh, account).ok) return fresh;
        const receiving = creditInbound(fresh.receiving, found, account.receivingCommitment);
        // Anchored on the events actually credited, NOT on the chain tip, which
        // was read before a scan that pages the whole retained window and so
        // could point behind a transfer this very call had just credited. The
        // line above only returns when the sum reproduces the accumulator the
        // contract holds, which is what makes the anchor provable. Floored at
        // `fresh`, which is re-read here, so the cursor can only move forward.
        const next = {
          ...fresh,
          receiving,
          syncedThrough: cursorAfter(fresh.syncedThrough, found),
        };
        await this.writeOpenings(address, cfg.token, next);
        this.lastInboundFailure = null;
        return next;
      });
    } catch (e) {
      // ONLY our own authored text may be surfaced. Passing `e.message`
      // through put "Request failed with status code 429" on the diverged
      // screen, which is precisely the RPC-authored string the error allowlist
      // exists to keep off it. Anything else gets a line we wrote.
      const { InboundCreditError } = await import("./inbound");
      this.lastInboundFailure =
        e instanceof InboundCreditError
          ? e.message
          : "Pocket could not reach the ledger to look for transfers you have received.";
      return stored;
    }
  }

  /** Why the last inbound-credit attempt did not complete, if it did not. */
  private lastInboundFailure: string | null = null;

  /**
   * When each wrapper's entry was last bumped, BY TOKEN.
   *
   * Per token because the fact is per token: every configured wrapper is its
   * own confidential account with its own ledger entry and its own TTL, and a
   * bump extends exactly one of them.
   */
  private lastKeepAlive = new Map<string, number>();

  /** This token's own entry was bumped recently, so it needs nothing now. */
  private recentlyActive(token: string): boolean {
    return Date.now() - (this.lastKeepAlive.get(token) ?? 0) < 7 * 24 * 3600_000;
  }

  /** Envelopes this controller built, awaiting confirmation. Keyed by tx hash. */
  private pending = new Map<
    string,
    {
      xdr: string;
      at: number;
      private?: StagedAfter;
      kind?: string;
      token?: string;
      /**
       * The burn to build after a CCTP `approve` lands. Carried here because
       * CCTP outbound is two transactions (approve, then deposit_for_burn) and
       * only the approve is built up front, exactly like a shield's follow-merge.
       */
      cctpBurn?: {
        destinationDomain: number;
        mintRecipient: string; // 32-byte hex
        amount: string; // stroops (7dp)
        maxFee: string; // 6dp CCTP units
        minFinality: number;
        burnToken: string; // USDC SAC
      };
    }
  >();
  /**
   * How long a built envelope stays confirmable.
   *
   * DERIVED from the envelope's own expiry, not chosen. It was ten minutes, and
   * every envelope in this map expires 180 seconds after it was built:
   * `buildPayment` and the confidential builders use `DEFAULT_TIMEOUT_SECONDS`,
   * the trustline, swap and CCTP builders call `.setTimeout(180)`, and a foreign
   * envelope is rebound by `withOwnDeadline` to the same window. So for the
   * seven minutes between them the handle was alive and the bytes behind it were
   * already dead: confirming spent an unlock and a signature to get `txTooLate`
   * back from the network, and for a private operation it threw away a proof the
   * user had waited on to buy an error message that explains none of this.
   *
   * Nothing is lost by the shorter window, because there is nothing there to
   * lose: an expired envelope cannot be included by anyone, at any fee, so a
   * handle that outlives it is not an opportunity, only a worse way to fail.
   * Tied to the constant rather than spelled 180_000, so a builder that ever
   * picks a different deadline moves this with it.
   */
  private static readonly PENDING_TTL_MS = DEFAULT_TIMEOUT_SECONDS * 1000;

  private prunePending(): void {
    const cutoff = Date.now() - WalletController.PENDING_TTL_MS;
    for (const [k, v] of this.pending) if (v.at < cutoff) this.pending.delete(k);
  }

  /**
   * Sign and submit a transaction this controller built. Takes the handle
   * buildPayment returned, never raw XDR, so the bytes signed are exactly the
   * bytes summarised on the approval screen.
   */
  async confirmPayment(handle: string): Promise<{ hash: string; ledger: number }> {
    return this.exclusive(() => this.doConfirmPayment(handle));
  }

  private async doConfirmPayment(handle: string): Promise<{ hash: string; ledger: number }> {
    this.prunePending();
    const entry = this.pending.get(handle);
    // Checked BEFORE the handle is consumed. A private handle sent here is a
    // routing mistake, and refusing it after deleting the entry would destroy a
    // proved operation the user waited on and cannot recover except by proving
    // it again.
    if (!entry || entry.private) {
      // Named, because the generic "try again" here is the worst sentence in
      // the product: it invites the resend the in-flight machinery exists to
      // prevent, one moment after the payment may actually have succeeded.
      // The private path already throws a named error; these two disagreeing
      // was a slip, not a decision.
      throw new StaleHandleError(
        "That transaction is no longer pending confirmation. Build it again and review it.",
      );
    }
    this.pending.delete(handle);

    const { TransactionBuilder, Transaction } = await import("@stellar/stellar-sdk/base");
    const decoded = TransactionBuilder.fromXDR(entry.xdr, NETWORKS[this.network].passphrase);

    // Defence in depth: re-assert the envelope is ours and shaped as reviewed.
    if (!(decoded instanceof Transaction)) {
      throw new Error("refusing to sign a fee-bump envelope here");
    }
    const inner = decoded;
    if (inner.source !== requireSession().address) {
      throw new Error("refusing to sign a transaction from a different source account");
    }
    if (inner.operations.length !== 1 || inner.operations[0]?.type !== "payment") {
      throw new Error("refusing to sign: this is not the single payment that was reviewed");
    }
    inner.sign(this.keypair());
    // The KIND travels with the record. Without it nothing downstream can tell a
    // stranded merge from a stranded payment, and the merge exemption would have
    // to trust every caller instead of checking. Shares one sink with every other
    // submitter: this path used to clear the slot with no hash guard at all.
    const outcome = await submitAndConfirm(this.server(), inner, {
      inFlight: this.inFlightSink("payment"),
    });
    if (outcome.kind === "succeeded") {
      return { hash: outcome.hash, ledger: outcome.ledger };
    }
    throw new SubmitOutcomeError(describeOutcome(outcome), outcome);
  }
}

/**
 * Why this private operation will not be built, or null.
 *
 * Separated out and run BEFORE the verification-key check and the circuit load,
 * because neither of those can rescue a request that is refused on its face and
 * both make the user wait to be told so. Pure, so the refusals are checkable
 * without a chain, a session or a proving backend behind them.
 */
export function refusePrivateOp(req: PrivateOpRequest, self: string): string | null {
  // Positivity, for every operation that carries an amount.
  //
  // `transfer` and `unshield` were checked against the SPENDABLE balance, which
  // a negative passes trivially, and `shield` was not checked at all: it parsed
  // the string, built a deposit for it, and put "Move -5 XLM from the public
  // pocket into the private one" on the review as a signed fact. `parseAmount`
  // accepts a leading minus on purpose, because a history entry can be
  // negative; a thing the user is about to sign cannot.
  //
  // Zero too. A zero-amount operation costs a fee and a proof to change
  // nothing, and every builder below treats it as a real request.
  if ("amount" in req) {
    let amount: bigint;
    try {
      amount = parseAmount(req.amount);
    } catch {
      // Not a number at all. `parseAmount` throws its own authored sentence
      // from the builder, which is a better one than this could write.
      return null;
    }
    if (amount <= 0n) return "Enter an amount greater than zero.";
  }

  if (req.kind !== "transfer") return null;
  const to = parseAddress(req.to); // throws on a bad checksum, which is not this
  if (to.kind !== "account") {
    return "A private transfer needs an account address (G...). Contract addresses cannot hold one.";
  }
  // A private transfer to your OWN address is the one case where the SENDER's
  // receiving commitment moves, because sender and recipient are the same
  // account and the contract debits spendable and credits receiving on the one
  // entry. Every other transfer leaves the sender's receiving side alone, which
  // is the fact `spendResolution` is built on.
  //
  // Refused rather than special-cased, because there is nothing to
  // special-case FOR. The effect is to move your own money from spendable to
  // received: a merge run backwards, paid for with a fee and a proof, leaving
  // you strictly worse off. Allowed, it also produced a post-state the wallet
  // could not record, and by then the money was spent.
  if (to.value === self) {
    return (
      "That is this wallet's own address. Sending privately to yourself costs a fee and moves " +
      "the amount out of your spendable balance, so Pocket does not do it. To make received " +
      "funds spendable, use Make spendable."
    );
  }
  return null;
}

/**
 * The post-state of an operation that spends: the new spendable opening, and
 * nothing about the side the operation does not touch. See `StagedResolution`.
 */
function spendResolution(spendable: Opening): StagedResolution {
  return {
    kind: "spend",
    spendable: [spendable.value.toString(), spendable.randomness.toString()],
  };
}

/**
 * Asset symbols as a readable list: "XLM", "XLM and USDC", "XLM, USDC and EURC".
 *
 * Symbols only, and symbols come from `config.ts`, so nothing an archive or an
 * RPC authored can reach a user through this sentence.
 */
export function listOf(names: string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What a private-history read produced, including what it could not read.
 *
 * Two fields because a partial answer is a real outcome and had no way to be
 * expressed: the per-asset catch dropped a failed asset and returned the rest,
 * so an archive outage and an account with no private history were the same
 * value, and the screen renders that value as "No activity yet."
 */
interface PrivateHistoryRead {
  entries: HistoryEntry[];
  /** Absent when everything asked for was read. */
  unreadable?: string;
}

/**
 * How to recover a private balance this device cannot account for, phrased for
 * whether recovery is actually available.
 *
 * Five worker-authored sentences asserted "this build has none configured" as a
 * flat constant, none of them reading `archiveUrl`. That was written when no
 * build had one, and it is the same defect D-009 recorded and closed on the UI
 * side: the popup learned to branch on `canRebuild` and the worker's own
 * sentences did not. On a build WITH an archive the wallet therefore states
 * that rebuilding is impossible directly above a working Rebuild button, and
 * the user can only find out which is true by pressing it.
 *
 * One function so the two halves cannot drift apart again: the popup gates the
 * CONTROL on `archiveUrl` and this gates the SENTENCE on the same fact.
 */
export function rebuildAdvice(archiveUrl: string | undefined): string {
  return archiveUrl
    ? "Rebuilding the record replays your event history from this build's archive, which you " +
        "can start from Settings."
    : "Rebuilding the record needs a durable event archive, and this build has none configured.";
}

/**
 * Why a half of the history is missing, in words the wallet wrote.
 *
 * An allowlist by class, the same discipline `describeError` follows and for
 * the same reason: an archive's or Horizon's own message can carry a URL or a
 * stack fragment, and this string goes straight onto a screen. Anything not
 * named gets a sentence about the pocket that failed, which is still far more
 * than the silence this replaces.
 */
function describeHistoryFailure(e: unknown, pocket: "public" | "private"): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "ArchiveUnavailableError") {
    return "The durable archive did not answer, so your private history could not be replayed.";
  }
  if (name === "IncompleteHistoryError") {
    return (
      "The archive could not serve an unbroken run of events, so Pocket will not show a " +
      "private history it knows has a gap in it."
    );
  }
  if (name === "RecoveryUnavailableError" || name === "MalformedEventError") {
    return "Your private history could not be read from the archive.";
  }
  return pocket === "private"
    ? "Your private history could not be read just now."
    : "Your public history could not be read just now.";
}

/** An absolute post-state, in the string form the staged record holds. */
function openingsResolution(state: {
  spendable: Opening;
  receiving: Opening;
  syncedThrough: number;
}): StagedResolution {
  return {
    kind: "openings",
    spendable: [state.spendable.value.toString(), state.spendable.randomness.toString()],
    receiving: [state.receiving.value.toString(), state.receiving.randomness.toString()],
    syncedThrough: state.syncedThrough,
  };
}

/**
 * Apply a staged resolution to what is stored now.
 *
 * Every form is idempotent against the chain check that follows it: a merge
 * applied twice folds an already-empty receiving side and changes nothing, and
 * a credit applied twice produces a commitment the contract does not hold and
 * is refused rather than written.
 */
function resolveStaged(
  stored: { spendable: Opening; receiving: Opening; syncedThrough: number },
  resolve: StagedResolution,
): { spendable: Opening; receiving: Opening; syncedThrough: number } {
  if (resolve.kind === "openings") {
    return {
      spendable: { value: BigInt(resolve.spendable[0]), randomness: BigInt(resolve.spendable[1]) },
      receiving: { value: BigInt(resolve.receiving[0]), randomness: BigInt(resolve.receiving[1]) },
      syncedThrough: resolve.syncedThrough,
    };
  }
  if (resolve.kind === "spend") {
    // `stored` is read at PERSIST time, so a credit that landed while the proof
    // was being built is carried through here instead of being overwritten by a
    // snapshot that predates it. Idempotent: replaying sets the same spendable
    // opening, and the chain check that follows is what makes it safe.
    return {
      spendable: { value: BigInt(resolve.spendable[0]), randomness: BigInt(resolve.spendable[1]) },
      receiving: stored.receiving,
      syncedThrough: stored.syncedThrough,
    };
  }
  if (resolve.kind === "credit") {
    // A deposit is public and unblinded, so the credit is exactly the amount
    // with randomness zero.
    return {
      spendable: stored.spendable,
      receiving: credit(stored.receiving, { value: BigInt(resolve.amount), randomness: 0n }),
      syncedThrough: stored.syncedThrough,
    };
  }
  return { ...applyMerge(stored), syncedThrough: stored.syncedThrough };
}

export { WrongPasswordError, readTrustline };

/**
 * The u32 the auditor registry allocated, read out of the invocation result.
 *
 * Returns null rather than guessing. A wrong id here would bind the account to
 * somebody else's auditor key, permanently, so "could not read it" must be a
 * refusal and never a default.
 */
function readAllocatedId(outcome: SubmitOutcome): number | null {
  if (outcome.kind !== "succeeded" || !outcome.returnValue) return null;
  const v = outcome.returnValue;
  if (v.switch().name !== "scvU32") return null;
  return v.u32();
}

/** TTL reported as a plain date, never a ledger number. */
function ttlFields(t: TtlStatus): { expiresAt?: string; daysRemaining?: number } {
  if (t.kind === "healthy" || t.kind === "expiring") {
    return { expiresAt: t.expiresAt.toISOString(), daysRemaining: Math.round(t.daysRemaining) };
  }
  return {};
}
