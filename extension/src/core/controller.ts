// The wallet controller. Owns the vault, the session and every chain call.
// Runs in the service worker; the popup never touches keys.
import { rpc } from "@stellar/stellar-sdk";
import { Account, Asset, Keypair, type Transaction } from "@stellar/stellar-sdk/base";
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
import { KEYS, readLocal, writeLocal, removeLocal, openingKey, openingKeys } from "../lib/storage";
import {
  readNative,
  readTrustline,
  formatAmount,
  parseAmount,
  minimumBalance,
  AccountNotFoundError,
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
  describeOutcome,
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
} from "./messages";
import { readConfidentialAccount, readAuditorKey } from "./chain/confidential";
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
      syncedThrough: number;
    }
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
 * The contract ids a transaction's invocations target.
 *
 * Used to verify an envelope built by an external service (the yield vault, a
 * swap router) actually invokes the contract we expect, before Pocket signs it.
 * Only `invokeHostFunction` ops that call a contract contribute; anything else
 * is ignored, so an envelope with no recognised target simply matches nothing
 * and is refused by the caller.
 */
async function invokedContractIds(tx: Transaction): Promise<string[]> {
  const { Address } = await import("@stellar/stellar-sdk/base");
  const out: string[] = [];
  for (const op of tx.operations) {
    if (op.type !== "invokeHostFunction") continue;
    try {
      const fn = (
        op as unknown as {
          func: { switch(): { name: string }; invokeContract(): { contractAddress(): unknown } };
        }
      ).func;
      if (fn.switch().name === "hostFunctionTypeInvokeContract") {
        out.push(Address.fromScAddress(fn.invokeContract().contractAddress() as never).toString());
      }
    } catch {
      // Not a contract-invoke host function (e.g. upload/create), so it names no
      // target to check. Skipped rather than failing the whole verification.
    }
  }
  return out;
}

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
   * only rebuild once its timeBounds have passed.
   */
  async inFlight(): Promise<{ hash: string; maxTime: number; expired: boolean } | null> {
    const e = await readLocal<{ hash: string; maxTime: number }>(KEYS.inFlight);
    if (!e) return null;
    return { ...e, expired: e.maxTime > 0 && Math.floor(Date.now() / 1000) > e.maxTime };
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
      let outcome = await pollToTerminal(this.server(), e.hash, { attempts: 3 });

      // Still not included, and it can never be included now. Left as "pending"
      // the record is unclearable, and the screen that renders it sits in front
      // of the whole wallet on every popup mount, forever.
      if (
        outcome.kind === "pending" &&
        e.maxTime > 0 &&
        Math.floor(Date.now() / 1000) > e.maxTime
      ) {
        outcome = { kind: "expired", hash: e.hash };
      }
      if (outcome.kind === "pending") return outcome;

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
          "Setting up a private pocket is a one-time, publicly visible transaction. " +
          "It permanently binds an auditor that can read your amounts.",
      };
    }

    this.readyAssets.add(cfg.token);
    const ttl = await readAccountTtl(this.server(), cfg.token, address, this.network);

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
          "Your funds are safe on chain. Rebuilding the record means replaying your event " +
          "history from a durable archive, and this build has none configured, so they cannot " +
          "be rebuilt yet.",
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
          "Pocket will not spend from this state. Your funds are safe on chain. Rebuilding the " +
          "record needs a durable event archive, and this build has none configured.",
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
    return {
      available: true,
      vault: cfg.vault,
      apy: describeApy(vault.apy, 7),
      // The API reports SHARES, not underlying. Calling it a balance would
      // invite a user to read it as XLM, which it is not.
      balance: position.shares,
      underlying: vault.assets?.[0]?.symbol ?? "XLM",
    };
  }

  /**
   * Build a yield deposit or withdrawal, returning what the approval screen
   * renders. Nothing is signed here.
   *
   * DeFindex builds the envelope server-side, so the bytes are decoded and
   * VERIFIED before they are ever offered for signing: same rule as signing for
   * a dApp. The source must be this account and the invocation must target the
   * configured vault, or Pocket refuses it rather than sign an envelope it
   * cannot vouch for.
   */
  async buildYieldMove(
    kind: "deposit" | "withdraw",
    amountStr: string,
  ): Promise<{ handle: string; summary: YieldMoveSummary }> {
    return this.exclusive(async () => {
      const { address } = requireSession();
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
      const built =
        kind === "deposit"
          ? await client.buildDeposit(cfg.vault, { caller: address, amounts: [amount] })
          : await client.buildWithdraw(cfg.vault, { caller: address, amounts: [amount] });

      const decoded = await this.decodeOwnEnvelope(built.xdr, address);
      const targets = await invokedContractIds(decoded);
      if (!targets.includes(cfg.vault)) {
        throw new DefindexError(
          "The yield transaction does not target the configured vault, so Pocket will not sign it.",
        );
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
      const net = NETWORKS[this.network];
      const cfg = net.aquarius;
      const { AquariusClient, AquariusError } = await import("./integrations/aquarius");
      if (!cfg) throw new AquariusError("Swaps are not available on this network.");
      const amount = parseAmount(amountStr);
      if (amount <= 0n) throw new AquariusError("Enter an amount greater than zero.");
      if (slippageBps < 0 || slippageBps > 10_000) {
        throw new AquariusError("Slippage must be between 0 and 100%.");
      }
      const inA = this.assetSac(assetIn);
      const outA = this.assetSac(assetOut);

      // Receiving a classic asset needs a trustline, or the swap reverts at
      // submit with an opaque error. Check first and refuse clearly.
      if (!outA.asset.isNative()) {
        const tl = await readTrustline(this.server(), address, outA.asset);
        if (!tl) {
          throw new AquariusError(
            `You need a ${outA.code} trustline before you can receive it. Add ${outA.code} first, then swap.`,
          );
        }
      }

      const path = await new AquariusClient({ apiUrl: cfg.apiUrl }).findPath(
        inA.sac,
        outA.sac,
        amount,
      );
      // out_min = estimate * (1 - slippage), integer math on stroops.
      const outMin = (path.amount * BigInt(10_000 - slippageBps)) / 10_000n;

      const { TransactionBuilder, Contract, Address, nativeToScVal, xdr, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      const source = await this.server().getAccount(address);
      const tx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(
          new Contract(cfg.router).call(
            "swap_chained",
            nativeToScVal(Address.fromString(address)),
            // The route, verbatim from find-path: decoded to an ScVal, never
            // re-encoded, so a wrong route cannot be constructed here.
            xdr.ScVal.fromXDR(path.swapChainXdr, "base64"),
            nativeToScVal(Address.fromString(inA.sac)),
            // u128, per the deployed contract's signature (NOT i128).
            nativeToScVal(amount, { type: "u128" }),
            nativeToScVal(outMin, { type: "u128" }),
          ),
        )
        .setTimeout(180)
        .build();

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
      const net = NETWORKS[this.network];
      const cctp = await import("./integrations/cctp");
      const chain = cctp.CCTP[this.network];
      if (destinationDomain === cctp.STELLAR_DOMAIN) {
        throw new cctp.CctpParameterError(
          "That is Stellar's own domain; choose a different chain.",
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
      const maxFee = 0n; // standard transfer; no fast-transfer fee
      const minFinality = fast ? cctp.FINALITY.fast : cctp.FINALITY.standard;
      const usdcSac = this.cctpUsdcSac(chain.usdc);

      const { TransactionBuilder, Contract, Address, nativeToScVal, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      const source = await this.server().getAccount(address);
      const latest = await this.server().getLatestLedger();
      const expiration = latest.sequence + 6 * 3600; // generous window; burn follows now
      const approveTx = new TransactionBuilder(source, {
        fee: BASE_FEE,
        networkPassphrase: net.passphrase,
      })
        .addOperation(
          new Contract(usdcSac).call(
            "approve",
            nativeToScVal(Address.fromString(address)),
            nativeToScVal(Address.fromString(chain.tokenMessengerMinter)),
            nativeToScVal(amount, { type: "i128" }),
            nativeToScVal(expiration, { type: "u32" }),
          ),
        )
        .setTimeout(180)
        .build();

      const handle = approveTx.hash().toString("hex");
      this.pending.set(handle, {
        xdr: approveTx.toXDR(),
        at: Date.now(),
        kind: "cctpSend",
        cctpBurn: {
          destinationDomain,
          mintRecipient: Buffer.from(mintRecipient).toString("hex"),
          amount: amount.toString(),
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
          amount: formatAmount(amount),
          dust: dust > 0n ? formatAmount(dust) : undefined,
          fee: formatAmount(BigInt(approveTx.fee)),
          effects: [
            `Bridge ${formatAmount(amount)} USDC from Stellar to ${chainName}`,
            "This burns the USDC on Stellar; the amount and both addresses are PUBLIC",
            ...(dust > 0n
              ? [`${formatAmount(dust)} USDC of dust stays on Stellar (CCTP uses 6 decimals)`]
              : []),
            `It is minted on ${chainName} by a separate transaction THERE, which this wallet ` +
              "cannot make: you need gas on that chain, or a relayer, to finish it",
            "Two Stellar signatures: approve, then burn",
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
      const burnOut = await this.signAndSubmit(burnTx, null, "cctpBurn");
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
      const net = NETWORKS[this.network];
      const { IrisClient, IrisError } = await import("./integrations/iris");
      const cctp = await import("./integrations/cctp");
      const chain = cctp.CCTP[this.network];
      const att = await new IrisClient({ baseUrl: chain.iris }).attestation(sourceDomain, txHash);
      if (!att.ready || !att.message || !att.attestation) {
        throw new IrisError(
          "This transfer is not ready to claim yet: Circle has not published its attestation. " +
            "Try again shortly.",
        );
      }

      const { TransactionBuilder, Contract, xdr, BASE_FEE } = await import(
        "@stellar/stellar-sdk/base"
      );
      const source = await this.server().getAccount(address);
      const claimTx = new TransactionBuilder(source, {
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
          effects: [
            `Claim the USDC you bridged from ${chainName} into this account`,
            "This completes the mint on Stellar; the amount is set by your source burn",
            "The USDC arrives in your PUBLIC pocket",
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

  /** dApp approvals waiting on the user, keyed by an id the popup returns. */
  private dappPending = new Map<
    string,
    { origin: string; summary: DappTxSummary; resolve: (approved: boolean) => void }
  >();

  /**
   * Park a signing request until the user answers it in the popup.
   *
   * The worker never decides this. It holds the request, opens the popup and
   * waits. A timeout resolves to REFUSED, never approved: a user who walked
   * away has not consented.
   */
  private awaitDappApproval(origin: string, summary: DappTxSummary): Promise<boolean> {
    const id = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    return new Promise((resolve) => {
      const done = (approved: boolean) => {
        this.dappPending.delete(id);
        resolve(approved);
      };
      this.dappPending.set(id, { origin, summary, resolve: done });
      void chrome.action?.openPopup?.().catch(() => undefined);
      setTimeout(() => {
        if (this.dappPending.has(id)) done(false);
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
  resolveDappRequest(id: string, approved: boolean): void {
    requireSession();
    this.dappPending.get(id)?.resolve(approved);
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
    const { ERROR, err, CONFIDENTIAL_METHODS } = await import("./provider/sep43");
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
        // The private pocket is unreachable from a site by design.
        void CONFIDENTIAL_METHODS;

        // Parked until the user answers in the popup. A timeout resolves to
        // REFUSED: someone who walked away has not consented.
        if (!(await this.awaitDappApproval(origin, summary))) {
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

  async lock(): Promise<void> {
    // Everything in memory goes first and synchronously, so nothing can read a
    // locked wallet's state during the part of the cleanup that suspends.
    clearSession();
    // Cached from the last private-pocket read, and only true for the account
    // that read it. Left set, a locked wallet still reports privateEnabled and
    // the home screen offers to open a pocket it cannot reach. It is cleared
    // HERE rather than at the end because everything below awaits: a status
    // read landing in that window would otherwise see the stale flag.
    this.readyAssets.clear();
    // Decrypted history entries must not outlive the session either.
    this.privHistoryMemo = undefined;
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
   */
  private async erase(): Promise<void> {
    clearSession();
    this.readyAssets.clear();
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

    await this.erase();
    // doImport, not import: we already hold the queue.
    const { address } = await this.doImport(password, phrase);
    return address;
  }

  async setNetwork(network: NetworkId): Promise<WalletStatus> {
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
      // opaque tx_insufficient_balance at submit time.
      const reserve = minimumBalance(native, BASE_RESERVE_STROOPS);
      const spendable = native.raw > reserve ? native.raw - reserve : 0n;
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

    // Known credit assets (e.g. USDC), read only once the account exists. A
    // trustline the account does not hold reads as null and is OMITTED, never
    // shown as zero: "you do not trust this asset" and "you hold zero of it" are
    // different facts. A read error propagates like the native one rather than
    // fabricating a balance. This is the same reserve-and-authorized shape the
    // native entry uses, so the UI renders each asset identically.
    if (exists) {
      for (const known of NETWORKS[this.network].knownAssets ?? []) {
        const tl = await readTrustline(this.server(), address, new Asset(known.code, known.issuer));
        if (!tl) continue;
        out.push({
          id: tl.id,
          code: tl.code,
          issuer: tl.issuer,
          amount: formatAmount(tl.raw),
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
          if (prices.length === 0) return [];
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

  /** Market facts about one asset, for the detail sheet. */
  async assetMarket(symbol: string): Promise<AssetMarketView> {
    requireSession();
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
  private privHistoryMemo?: { key: string; at: number; entries: HistoryEntry[] };

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

    // The private list is computed whole (a stateful replay cannot be paged) and
    // memoised, so scrolling does not re-fetch and re-replay the archive per page.
    // A failed private read is not fatal: the public half still shows.
    const priv = wantPrivate ? await this.privateHistoryAll(address, asset).catch(() => []) : [];
    const privBelow = priv.filter((e) => beforeCursor(e.at, e.id, before));

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
        }).catch(() => ({ entries: [] as HistoryEntry[], more: false }))
      : { entries: [] as HistoryEntry[], more: false };

    const merged = [...privBelow, ...pub.entries].sort(byRecency);
    const entries = merged.slice(0, lim);
    // There is more when the merge overflowed the page, or Horizon stopped at its
    // page cap with entries still below the cursor.
    const more = merged.length > lim || pub.more;
    const last = entries[entries.length - 1];
    const nextCursor = last && more ? encodeCursor({ at: last.at, id: last.id }) : null;
    return { entries, cursor: nextCursor };
  }

  private async privateHistoryAll(address: string, asset?: string): Promise<HistoryEntry[]> {
    // Asset in the key: a filtered view and the merged view are different lists
    // and must not share a memo slot.
    const key = `${this.network}:${address}:${asset ?? "all"}`;
    const memo = this.privHistoryMemo;
    if (memo && memo.key === key && Date.now() - memo.at < 20_000) return memo.entries;
    const entries = await this.computePrivateHistory(address, asset).catch(() => []);
    this.privHistoryMemo = { key, at: Date.now(), entries };
    return entries;
  }

  /**
   * Private history across every configured confidential asset (or one, when
   * `asset` is given), merged. Each wrapper has its own event stream, its own
   * viewing key and its own symbol, so each is replayed separately; one asset
   * failing (an archive gap, say) drops only that asset, not the others.
   */
  private async computePrivateHistory(address: string, asset?: string): Promise<HistoryEntry[]> {
    const net = NETWORKS[this.network];
    // No archive to replay from: there is simply no private history to show,
    // which is not an error.
    if (!net.archiveUrl) return [];
    const assets = asset
      ? net.confidential.filter(
          (c) => c.token === asset || c.underlying === asset || c.symbol === asset,
        )
      : net.confidential;
    if (assets.length === 0) return [];

    const { deriveConfidentialKeys } = await import("./confidential-ops");
    const { ArchiveClient } = await import("./chain/archive");
    const { privateHistory } = await import("./private-history");
    const client = new ArchiveClient(net.archiveUrl);

    const all: HistoryEntry[] = [];
    for (const cfg of assets) {
      try {
        const ctx = await this.opContext(cfg.token);
        const { vk } = await deriveConfidentialKeys(ctx);
        const stored: import("./chain/archive-types").StoredEvent[] = [];
        let pageCursor: string | undefined;
        for (;;) {
          // `events` throws IncompleteHistoryError on a gap; caught per asset
          // below so one asset's gap does not blank the whole private history.
          const page = await client.events(cfg.token, address, { cursor: pageCursor, limit: 200 });
          stored.push(...page.events);
          if (!page.cursor || page.cursor === pageCursor) break;
          pageCursor = page.cursor;
        }
        all.push(...privateHistory(stored, { vk, address }, cfg.symbol));
      } catch {
        // This asset's history is unavailable right now; the others still show.
      }
    }
    return all;
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
    if (asset.isNative()) {
      const native = await readNative(this.server(), address);
      const reserve = minimumBalance(native, BASE_RESERVE_STROOPS);
      const spendable = native.raw > reserve ? native.raw - reserve : 0n;
      if (amount > spendable) {
        throw new InsufficientBalanceError(
          `That is more than you can send. Your balance is ${formatAmount(native.raw)} XLM, ` +
            `of which ${formatAmount(reserve)} XLM is locked by the network as a reserve, ` +
            `leaving ${formatAmount(spendable)} XLM.`,
        );
      }
    }

    const seq = await this.server().getAccount(address);
    const tx = buildPayment(
      new Account(address, seq.sequenceNumber()),
      { from: address, to: to.value, asset, amount, memo: req.memo },
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
          `Send ${formatAmount(amount)} ${asset.isNative() ? "XLM" : asset.getCode()} to this address`,
          // The memo is signed, so it is an effect. Stating its absence too:
          // a missing memo is the usual way an exchange deposit is lost.
          req.memo ? `Attach the memo "${req.memo}"` : "Send with NO memo",
          `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
        ],
      },
    };
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
  /** True when the transaction we are waiting on is itself a merge. */
  private async unresolvedIsMerge(): Promise<boolean> {
    const e = await readLocal<{ kind?: string }>(KEYS.inFlight);
    return e?.kind === "merge";
  }

  private async assertNothingUnresolved(): Promise<void> {
    const e = await this.inFlight();
    if (!e || e.expired) return;
    throw new UnresolvedTransactionError(
      "A transaction submitted earlier has not resolved yet, and it may still land. " +
        "Reopen Pocket and check it before sending anything else.",
    );
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
    // When a shield's deposit lands and its merge does not, the wallet tells
    // the user their funds are in the receiving balance and to press "Make
    // spendable". The failed merge leaves an unresolved in-flight record, and
    // this guard then refused that exact operation for up to three minutes.
    // Both sentences were individually true and together they were a dead end,
    // on a screen that said nothing about the money sitting in receiving.
    //
    // So a merge is exempt, but ONLY when the thing left unresolved is itself
    // a merge, which is the shield-recovery case above and nothing else.
    //
    // The first version of this exempted EVERY merge, on the argument that a
    // merge is idempotent in effect: it folds the whole receiving balance into
    // spendable, so a repeat folds nothing. That argument is true and it
    // answers the wrong risk. This guard exists because a second submission
    // consumes the sequence number the first was built against, and a merge
    // consumes one like anything else, so a merge built while a PAYMENT is
    // unresolved takes the sequence that payment already claimed. Idempotency
    // of the operation says nothing about the sequence number.
    //
    // Recorded because the reasoning that produced the bug is more persuasive
    // than the reasoning that fixed it, and a future reader will meet it first.
    if (req.kind !== "merge" || !(await this.unresolvedIsMerge())) {
      await this.assertNothingUnresolved();
    }
    const cfg = this.confidentialConfig(asset);
    // Trap 14: refuse to prove against a deployment whose verification key is
    // not the one this build proves against. A mismatch otherwise surfaces as
    // an opaque contract error at submit time, after the user has waited
    // through proving and signed.
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
        const { tx, openings } = await ops.buildRegister(ctx, auditorId);
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
        const { deposit } = await ops.buildShield(ctx, amount);
        return this.stagePrivate(
          deposit,
          {
            kind: "shield",
            amount: formatAmount(amount),
            effects: [
              `Move ${formatAmount(amount)} ${cfg.symbol} from the public pocket into the private one`,
              "This deposit amount is PUBLIC on the ledger. Only later transfers hide amounts",
              "A second signature then makes it spendable",
              `Pay a network fee of ${formatAmount(BigInt(deposit.fee))} XLM`,
            ],
          },
          { resolve: { kind: "credit", amount: amount.toString() }, follow: true },
          cfg.token,
        );
      }

      case "merge": {
        const tx = await ops.buildMerge(ctx);
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
        const to = parseAddress(req.to);
        if (to.kind !== "account") {
          throw new PrivatePocketError(
            "A private transfer needs an account address (G...). Contract addresses cannot hold one.",
          );
        }
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
        const { tx, newSpendable } = await ops.buildTransfer(ctx, {
          recipient: to.value,
          recipientPvk: recipient.viewingPublicKey,
          recipientAuditorKey: await this.auditorKeyFor(recipient.auditorId, cfg),
          senderAuditorKey: await this.auditorKeyFor(mine.auditorId, cfg),
          amount,
          spendable: stored.spendable,
          onChainSpendable: mine.spendableCommitment,
        });
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
          {
            resolve: openingsResolution({
              spendable: newSpendable,
              receiving: stored.receiving,
              syncedThrough: stored.syncedThrough,
            }),
          },
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
        const { tx, newSpendable } = await ops.buildUnshield(ctx, {
          amount,
          spendable: stored.spendable,
          onChainSpendable: chain.spendableCommitment,
          auditorKey: await this.auditorKeyFor(chain.auditorId, cfg),
          destination: address,
        });
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
          {
            resolve: openingsResolution({
              spendable: newSpendable,
              receiving: stored.receiving,
              syncedThrough: stored.syncedThrough,
            }),
          },
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
          "Your funds are safe on chain. Rebuilding the record needs a durable event archive, " +
          "and this build has none configured.",
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
    return { handle, summary: { ...summary, fee: formatAmount(BigInt(tx.fee)) } };
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
      throw new PrivatePocketError(
        `The deposit succeeded (${outcome.hash}) but making it spendable did not. ` +
          (deposited
            ? `Your ${deposited} XLM is in the receiving balance`
            : "Your funds are in the receiving balance") +
          `, and Pocket has recorded it. Press "Make spendable" to finish.`,
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
    if (outcome.kind === "succeeded") await this.applyStaged(outcome.hash);
    else if (outcome.kind !== "pending") await this.discardStaged(outcome.hash);
    return outcome;
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
    const prepared = await this.server().prepareTransaction(tx);
    this.setPhase("Signing…");
    prepared.sign(this.keypair());
    this.setPhase("Submitting, then waiting for the ledger to confirm…");

    if (resolve) {
      // Simulation rewrites the envelope, so the hash to stage against is the
      // prepared one, not the hash the approval screen was keyed by.
      const { address } = requireSession();
      await this.writeStaged({
        hash: prepared.hash().toString("hex"),
        // The op's own token, threaded from confirm. Falls back to the primary
        // only for a staged write with no token supplied, which today never
        // happens on the private path.
        token: token ?? this.confidentialConfig().token,
        address,
        resolve,
      });
    }

    return submitAndConfirm(this.server(), prepared, {
      inFlight: {
        // The KIND travels with the record so a stranded merge can be told
        // from a stranded payment. Without it the merge exemption would have
        // to trust its caller rather than check.
        record: (e) => writeLocal(KEYS.inFlight, kind ? { ...e, kind } : e),
        // Only ever clear our own. Without the check, a keep-alive resolving
        // beside a payment erases the payment's record, and the unfinished
        // transaction screen never appears for the one that matters.
        clear: async (hash) => {
          const e = await readLocal<{ hash: string }>(KEYS.inFlight);
          if (e?.hash === hash) await removeLocal(KEYS.inFlight);
        },
      },
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
      throw new PrivatePocketError(
        hadRecord
          ? `The transaction landed, but the ${check.which} balance this device computed does not ` +
            `match what the contract now holds. Your funds are safe on chain. Pocket will not ` +
            `spend from a state it cannot verify, and rebuilding the record needs a durable ` +
            `event archive, which this build does not have configured.`
          : `The transaction landed, but this device has no record of your private balances, so ` +
            `it cannot work out what you now hold. Your funds are safe on chain. Rebuilding the ` +
            `record needs a durable event archive, and this build has none configured.`,
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
    for (const cfg of list) {
      const ttl = await readAccountTtl(this.server(), cfg.token, session.address, this.network);
      const plan = planKeepAlive(ttl, this.recentlyActive());
      if (!plan.due) continue;
      // Fetched per bump: two bumps from one stale source object would collide
      // on the sequence number.
      const source = await this.server().getAccount(session.address);
      const tx = buildKeepAlive(
        source,
        cfg.token,
        session.address,
        NETWORKS[this.network].passphrase,
      );
      // Same path as every other invocation, so it is simulated for its footprint
      // and auth entries before signing.
      const outcome = await this.signAndSubmit(tx);
      if (outcome.kind === "succeeded") this.lastKeepAlive = Date.now();
    }
    return { due: false, nextCheckMs: jitteredDelayMs(7) };
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
      const { findInbound, creditInbound } = await import("./inbound");
      // `findInbound` clamps to the RPC's reported floor itself, so passing a
      // best guess is safe: asking from before retention is what returns zero
      // events with no error, and the function that talks to the RPC is the
      // one that knows that.
      const health = await this.server().getHealth();
      const from = stored.syncedThrough > 0 ? stored.syncedThrough : 1;
      const found = await findInbound(this.server(), cfg.token, address, vk, from);
      if (found.length === 0) {
        // Not an error, and it must not read as one. It means the search ran
        // and the window held nothing for us, which for a diverged pocket
        // points at history older than the RPC keeps.
        this.lastInboundFailure =
          "Pocket searched the last week of ledger history and found no transfer addressed " +
          "to this account, so the difference is older than that.";
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
      return this.exclusive(async () => {
        const fresh = (await this.readOpenings(address, cfg.token)) ?? stored;
        // Someone else may have credited or merged while we scanned. Their
        // result is newer than ours; ours is now about a state that is gone.
        if (verifyAgainstChain(fresh, account).ok) return fresh;
        const receiving = creditInbound(fresh.receiving, found, account.receivingCommitment);
        const next = { ...fresh, receiving, syncedThrough: health.latestLedger };
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

  private lastKeepAlive = 0;

  /** Any operation we submitted recently already touched the entry. */
  private recentlyActive(): boolean {
    return Date.now() - this.lastKeepAlive < 7 * 24 * 3600_000;
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
  private static readonly PENDING_TTL_MS = 10 * 60_000;

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
    const outcome = await submitAndConfirm(this.server(), inner, {
      inFlight: {
        // The KIND travels with the record. Without it nothing downstream can
        // tell a stranded merge from a stranded payment, and the merge
        // exemption would have to trust every caller instead of checking.
        record: (e) => writeLocal(KEYS.inFlight, { ...e, kind: "payment" }),
        clear: () => removeLocal(KEYS.inFlight),
      },
    });
    if (outcome.kind === "succeeded") {
      return { hash: outcome.hash, ledger: outcome.ledger };
    }
    throw new SubmitOutcomeError(describeOutcome(outcome), outcome);
  }
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
