// The wallet controller. Owns the vault, the session and every chain call.
// Runs in the service worker; the popup never touches keys.
import { rpc } from "@stellar/stellar-sdk";
import { Account, Asset, Keypair, type Transaction } from "@stellar/stellar-sdk/base";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { NETWORKS, DEFAULT_NETWORK, type NetworkId } from "./config";
import { createVault, unlockVault, WrongPasswordError } from "./vault/vault";
import type { VaultHeader, Bytes } from "./vault/envelope";
import { setSession, clearSession, getSession, requireSession } from "./session";
import { KEYS, readLocal, writeLocal, removeLocal, openingKey, openingKeys } from "../lib/storage";
import {
  readNative,
  readTrustline,
  formatAmount,
  parseAmount,
  minimumBalance,
  AccountNotFoundError,
} from "./chain/balances";
import { buildPayment } from "./chain/payment";
import { submitAndConfirm, pollToTerminal, type SubmitOutcome } from "./chain/submit";
import { parseAddress } from "./chain/address";
import type { PublicBalance, WalletStatus, TransferSummary, PrivatePocket } from "./messages";
import { readConfidentialAccount, readAuditorKey } from "./chain/confidential";
import { assertVerificationKey, type CircuitName } from "./chain/verification-key";
import { readAccountTtl, jitteredDelayMs, type TtlStatus } from "./chain/ttl";
import { buildKeepAlive, planKeepAlive, type KeepAlivePlan } from "./chain/keepalive";
import { balancesOf, verifyAgainstChain, applyMerge, credit, ZERO_OPENING } from "./private";
import type { Opening, ConfidentialAccount } from "./witness/types";
import type { Point } from "./crypto/grumpkin";
import type { OpContext } from "./confidential-ops";
import type { PrivateOpRequest, PrivateOpSummary } from "./messages";
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
  | { kind: "openings"; spendable: [string, string]; receiving: [string, string]; syncedThrough: number }
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

interface PersistedSettings {
  network: NetworkId;
}

export class WalletController {
  private network: NetworkId = DEFAULT_NETWORK;
  private servers = new Map<NetworkId, rpc.Server>();

  private server(): rpc.Server {
    const id = this.network;
    let s = this.servers.get(id);
    if (!s) {
      s = new rpc.Server(NETWORKS[id].rpcUrl);
      this.servers.set(id, s);
    }
    return s;
  }

  async init(): Promise<void> {
    const settings = await readLocal<PersistedSettings>(KEYS.settings);
    if (settings?.network) this.network = settings.network;
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
      if (outcome.kind === "pending" && e.maxTime > 0 && Math.floor(Date.now() / 1000) > e.maxTime) {
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
    return {
      initialised: header !== undefined,
      locked: session === null,
      network: this.network,
      address: session?.address,
      privateEnabled: this.privateReady,
      privateAvailable: NETWORKS[this.network].confidential.length > 0,
    };
  }

  /** Cached across calls so `status` stays cheap; refreshed by privatePocket(). */
  private privateReady = false;

  /**
   * The private pocket's state for this account.
   *
   * Every branch that is not "ready" is a state the user must be told about
   * plainly. A diverged wallet in particular MUST NOT be spent from and MUST
   * NOT silently resync: a silent resync would mask exactly the archive
   * integrity failure the design relies on catching.
   */
  async privatePocket(): Promise<PrivatePocket> {
    const { address } = requireSession();
    const cfg = NETWORKS[this.network].confidential[0];
    if (!cfg) {
      return { state: "unavailable", message: "No private pocket is deployed on this network." };
    }

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
      this.privateReady = false;
      return {
        state: "unfunded",
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
      this.privateReady = false;
      const ttl = await readAccountTtl(this.server(), cfg.token, address, this.network);
      // An archived account reads as absent, so distinguish by whether we have
      // ever seen it registered.
      if (ttl.kind === "archived") {
        return {
          state: "archived",
          message:
            "Your private pocket is dormant. Reactivating it costs a small fee and restores access.",
        };
      }
      return {
        state: "unregistered",
        message:
          "Setting up a private pocket is a one-time, publicly visible transaction. " +
          "It permanently binds an auditor that can read your amounts.",
      };
    }

    this.privateReady = true;
    const ttl = await readAccountTtl(this.server(), cfg.token, address, this.network);

    // Openings live in the encrypted vault; without them the commitments on
    // chain are visible but unspendable, which is precisely why that store is
    // not an evictable cache.
    const stored = await this.readOpenings(address, cfg.token);
    if (!stored) {
      return {
        state: "needsRecovery",
        auditorId: account.auditorId,
        ...ttlFields(ttl),
        message:
          "This account has a private pocket but this device has no record of its balances. " +
          "Recovery replays them from the event history.",
      };
    }

    const check = verifyAgainstChain(stored, account);
    if (!check.ok) {
      return {
        state: "diverged",
        auditorId: account.auditorId,
        ...ttlFields(ttl),
        message:
          `Local records for the ${check.which} balance do not match the ledger. ` +
          "Pocket will not spend from this state. A full replay can rebuild it.",
      };
    }

    const b = balancesOf({
      kind: "ready",
      spendable: stored.spendable,
      receiving: stored.receiving,
      auditorId: account.auditorId,
      syncedThrough: stored.syncedThrough,
    })!;

    return {
      state: "ready",
      spendable: formatAmount(b.spendable),
      receiving: formatAmount(b.receiving),
      mergeAvailable: b.mergeAvailable,
      auditorId: account.auditorId,
      ...ttlFields(ttl),
    };
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

  /** Create a new wallet. Returns the mnemonic exactly once, for backup. */
  async create(password: string): Promise<{ mnemonic: string; address: string }> {
    if (await readLocal<VaultHeader>(KEYS.vaultHeader)) {
      throw new Error("a wallet already exists on this device");
    }
    const mnemonic = generateMnemonic(wordlist, 256);
    const address = await this.installSeed(password, mnemonic);
    return { mnemonic, address };
  }

  async import(password: string, mnemonic: string): Promise<{ address: string }> {
    // Same guard as create(). Without it, any path that sends {type:"import"}
    // replaces a funded wallet's seed, and the previous mnemonic is the only
    // recovery material. Deliberate replacement goes through reset(), which
    // requires the current password.
    if (await readLocal<VaultHeader>(KEYS.vaultHeader)) {
      throw new Error(
        "a wallet already exists on this device. Remove it first if you mean to replace it.",
      );
    }
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    if (!validateMnemonic(phrase, wordlist)) {
      throw new Error("that is not a valid recovery phrase");
    }
    return { address: await this.installSeed(password, phrase) };
  }

  private async installSeed(password: string, mnemonic: string): Promise<string> {
    const { header, dek } = await createVault(password);
    const seed = new Uint8Array(await mnemonicToSeed(mnemonic)) as Bytes;
    const kp = deriveEd25519(seed, 0);

    await writeLocal(KEYS.vaultHeader, header);
    await writeLocal(KEYS.state, await this.sealState(dek, { mnemonic }));

    await writeLocal(KEYS.publicAddress, kp.publicKey());
    setSession({ dek, seed, address: kp.publicKey(), unlockedAt: Date.now() });
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
    const sealed = await readLocal<Parameters<typeof this.openState>[1]>(KEYS.state);
    if (!sealed) throw new Error("vault header exists but wallet state is missing");
    const { mnemonic } = await this.openState(dek, sealed);
    const seed = new Uint8Array(await mnemonicToSeed(mnemonic)) as Bytes;
    const kp = deriveEd25519(seed, 0);
    setSession({ dek, seed, address: kp.publicKey(), unlockedAt: Date.now() });
    return this.status();
  }

  private async openState(dek: Bytes, sealed: { v: number; iv: string; ct: string }) {
    const { openPayload } = await import("./vault/vault");
    return openPayload<{ mnemonic: string }>(dek, sealed);
  }

  lock(): void {
    clearSession();
    // Cached from the last private-pocket read, and only true for the account
    // that read it. Left set, a locked wallet still reports privateEnabled and
    // the home screen offers to open a pocket it cannot reach.
    this.privateReady = false;
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
    this.privateReady = false;
    await removeLocal(KEYS.vaultHeader);
    await removeLocal(KEYS.state);
    await removeLocal(KEYS.inFlight);
    // Sealed under the DEK that is about to be discarded, so leaving it behind
    // leaves an undecryptable blob that the next wallet would trip over.
    await removeLocal(STAGED_KEY);
    await removeLocal(KEYS.publicAddress);
    for (const key of await openingKeys()) await removeLocal(key);
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
    const phrase = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
    if (!validateMnemonic(phrase, wordlist)) {
      throw new RecoveryError("That is not a valid recovery phrase. Check the words and the order.");
    }

    const existing = await readLocal<string>(KEYS.publicAddress);
    if (existing) {
      const seed = new Uint8Array(await mnemonicToSeed(phrase)) as Bytes;
      if (deriveEd25519(seed, 0).publicKey() !== existing) {
        throw new RecoveryError(
          "That phrase belongs to a different wallet. Pocket will not erase this one with it.",
        );
      }
    }

    await this.erase();
    const { address } = await this.import(password, phrase);
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
    this.privateReady = false;
    await writeLocal(KEYS.settings, { network });
    return this.status();
  }

  /** Public-pocket balances. An unfunded account reports zero, not an error. */
  async balances(): Promise<PublicBalance[]> {
    const { address } = requireSession();
    const out: PublicBalance[] = [];
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
      out.push({ id: "native", code: "XLM", amount: "0.0000000", authorized: true });
    }
    return out;
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
      throw new Error(
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

  /** The deployment this account's private pocket lives in. */
  private confidentialConfig() {
    const cfg = NETWORKS[this.network].confidential[0];
    if (!cfg) throw new PrivatePocketError("No private pocket is deployed on this network.");
    return cfg;
  }

  private async opContext(): Promise<OpContext> {
    const cfg = this.confidentialConfig();
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
  async buildPrivateOp(req: PrivateOpRequest): Promise<{ handle: string; summary: PrivateOpSummary }> {
    return this.exclusive(() => this.doBuildPrivateOp(req));
  }

  private async doBuildPrivateOp(
    req: PrivateOpRequest,
  ): Promise<{ handle: string; summary: PrivateOpSummary }> {
    const { address } = requireSession();
    await this.assertNothingUnresolved();
    const cfg = this.confidentialConfig();
    // Trap 14: refuse to prove against a deployment whose verification key is
    // not the one this build proves against. A mismatch otherwise surfaces as
    // an opaque contract error at submit time, after the user has waited
    // through proving and signed.
    const circuit = CIRCUIT_FOR[req.kind];
    if (circuit) await this.assertVk(cfg, circuit);
    const ctx = await this.opContext();
    const ops = await import("./confidential-ops");

    switch (req.kind) {
      case "register": {
        const { tx, openings } = await ops.buildRegister(ctx, req.auditorId);
        return this.stagePrivate(tx, {
          kind: "register",
          effects: [
            "Create a confidential account for this address",
            `Permanently bind auditor #${req.auditorId}, which can read your amounts`,
            "Publish that this address has a private pocket. This is not reversible",
            `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
          ],
        }, { resolve: openingsResolution({ ...openings, syncedThrough: 0 }) });
      }

      case "shield": {
        const amount = parseAmount(req.amount);
        // Two transactions: a deposit credits the RECEIVING side, so shielding
        // without the merge leaves a zero spendable balance and no explanation.
        // Only the deposit is retained here. The merge is rebuilt at confirm
        // time against the sequence the deposit actually consumed, which is why
        // the envelope built alongside it was never signed.
        const { deposit } = await ops.buildShield(ctx, amount);
        return this.stagePrivate(deposit, {
          kind: "shield",
          amount: formatAmount(amount),
          effects: [
            `Move ${formatAmount(amount)} XLM from the public pocket into the private one`,
            "This deposit amount is PUBLIC on the ledger. Only later transfers hide amounts",
            "A second signature then makes it spendable",
            `Pay a network fee of ${formatAmount(BigInt(deposit.fee))} XLM`,
          ],
        }, { resolve: { kind: "credit", amount: amount.toString() }, follow: true });
      }

      case "merge": {
        const tx = await ops.buildMerge(ctx);
        // Read for its refusal, not its value. Merging with no local record of
        // the receiving side would produce a post-state nothing can verify, and
        // the resolution below is computed from storage when the merge lands.
        await this.requireOpenings(address, cfg.token);
        return this.stagePrivate(tx, {
          kind: "merge",
          effects: [
            "Fold everything you have received into your spendable balance",
            "Amounts stay hidden. This proves nothing and reveals nothing",
            `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
          ],
        }, { resolve: { kind: "merge" } });
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
            `That is more than your spendable balance of ${formatAmount(stored.spendable.value)} XLM. ` +
              `Received funds must be made spendable first.`,
          );
        }
        const recipient = await this.readOwnAccount(to.value, cfg, "recipient");
        const mine = await this.readOwnAccount(address, cfg);
        const { tx, newSpendable } = await ops.buildTransfer(ctx, {
          recipient: to.value,
          recipientPvk: recipient.viewingPublicKey,
          recipientAuditorKey: await this.auditorKeyFor(recipient.auditorId, cfg),
          senderAuditorKey: await this.auditorKeyFor(mine.auditorId, cfg),
          amount,
          spendable: stored.spendable,
          onChainSpendable: mine.spendableCommitment,
        });
        return this.stagePrivate(tx, {
          kind: "transfer",
          to: to.value,
          amount: formatAmount(amount),
          effects: [
            `Send ${formatAmount(amount)} XLM privately to this address`,
            "The AMOUNT is hidden. Both addresses are PUBLIC on the ledger, permanently",
            `Auditor #${recipient.auditorId} and auditor #${mine.auditorId} can both read this amount`,
            `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
          ],
        }, {
          resolve: openingsResolution({
            spendable: newSpendable,
            receiving: stored.receiving,
            syncedThrough: stored.syncedThrough,
          }),
        });
      }

      case "unshield": {
        const amount = parseAmount(req.amount);
        const stored = await this.requireOpenings(address, cfg.token);
        if (amount > stored.spendable.value) {
          throw new PrivatePocketError(
            `That is more than your spendable balance of ${formatAmount(stored.spendable.value)} XLM.`,
          );
        }
        const chain = await this.readOwnAccount(address, cfg);
        const { tx, newSpendable } = await ops.buildUnshield(ctx, {
          amount,
          spendable: stored.spendable,
          onChainSpendable: chain.spendableCommitment,
          auditorKey: await this.auditorKeyFor(chain.auditorId, cfg),
          destination: address,
        });
        return this.stagePrivate(tx, {
          kind: "unshield",
          amount: formatAmount(amount),
          effects: [
            `Move ${formatAmount(amount)} XLM from the private pocket back to the public one`,
            "This withdrawal amount becomes PUBLIC on the ledger",
            `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
          ],
        }, {
          resolve: openingsResolution({
            spendable: newSpendable,
            receiving: stored.receiving,
            syncedThrough: stored.syncedThrough,
          }),
        });
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
          "Rebuild from history first.",
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
  ): { handle: string; summary: PrivateOpSummary } {
    const handle = tx.hash().toString("hex");
    this.pending.set(handle, { xdr: tx.toXDR(), at: Date.now(), private: after });
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
  async confirmPrivateOp(handle: string): Promise<{ hash: string; ledger: number; followed?: string }> {
    return this.exclusive(() => this.doConfirmPrivateOp(handle));
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

    const outcome = await this.submitStaged(decoded, entry.private.resolve);
    if (outcome.kind !== "succeeded") throw new Error(describeOutcome(outcome));

    if (!entry.private.follow) return { hash: outcome.hash, ledger: outcome.ledger };

    // A shield is two transactions, and the deposit has now landed. Its credit
    // is already written, which is what makes the failure below survivable: the
    // local record matches the ledger, so the receiving balance is real and one
    // more signature spends it. Writing only after BOTH succeeded left the
    // wallet diverged from the chain by exactly the deposit, unspendable, and
    // pointing the user at a button the diverged screen does not offer.
    const ops = await import("./confidential-ops");
    const ctx = await this.opContext();
    const mergeTx = await ops.buildMerge(ctx);
    const second = await this.submitStaged(mergeTx, { kind: "merge" });
    if (second.kind !== "succeeded") {
      const deposited =
        entry.private.resolve.kind === "credit" ? formatAmount(BigInt(entry.private.resolve.amount)) : null;
      throw new PrivatePocketError(
        `The deposit succeeded (${outcome.hash}) but making it spendable did not. ` +
          (deposited ? `Your ${deposited} XLM is in the receiving balance` : "Your funds are in the receiving balance") +
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
  ): Promise<SubmitOutcome> {
    const outcome = await this.signAndSubmit(tx, resolve);
    if (outcome.kind === "succeeded") await this.applyStaged(outcome.hash);
    else if (outcome.kind !== "pending") await this.discardStaged(outcome.hash);
    return outcome;
  }

  private async signAndSubmit(
    tx: Transaction,
    resolve: StagedResolution | null = null,
  ): Promise<SubmitOutcome> {
    // A Soroban invocation needs its footprint and auth entries populated, and
    // simulation is the only thing that can do it. Signing before this would
    // produce an envelope the network rejects at once.
    const prepared = await this.server().prepareTransaction(tx);
    prepared.sign(this.keypair());

    if (resolve) {
      // Simulation rewrites the envelope, so the hash to stage against is the
      // prepared one, not the hash the approval screen was keyed by.
      const { address } = requireSession();
      await this.writeStaged({
        hash: prepared.hash().toString("hex"),
        token: this.confidentialConfig().token,
        address,
        resolve,
      });
    }

    return submitAndConfirm(this.server(), prepared, {
      inFlight: {
        record: (e) => writeLocal(KEYS.inFlight, e),
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
            `match what the contract now holds. Your funds are safe on chain. Rebuild from ` +
            `history before spending again.`
          : `The transaction landed, but this device has no record of your private balances, so ` +
            `it cannot work out what you now hold. Your funds are safe on chain. They need to be ` +
            `rebuilt from history before you can spend them.`,
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
    const cfg = NETWORKS[this.network].confidential[0];
    if (!session || !cfg) return { due: false, nextCheckMs: jitteredDelayMs(7) };

    // An alarm fires whenever it likes, including on top of an unresolved user
    // submission. Two envelopes against one sequence number means one of them
    // fails; a keep-alive is never worth that.
    const unresolved = await this.inFlight();
    if (unresolved && !unresolved.expired) return { due: false, nextCheckMs: jitteredDelayMs(1) };

    const ttl = await readAccountTtl(this.server(), cfg.token, session.address, this.network);
    const plan = planKeepAlive(ttl, this.recentlyActive());
    if (!plan.due) return plan;

    const source = await this.server().getAccount(session.address);
    const tx = buildKeepAlive(source, cfg.token, session.address, NETWORKS[this.network].passphrase);
    // Goes through the same path as every other invocation, so it is simulated
    // for its footprint and auth entries before being signed. Building one
    // without that produces an envelope the network rejects outright.
    const outcome = await this.signAndSubmit(tx);
    if (outcome.kind === "succeeded") this.lastKeepAlive = Date.now();
    return { ...plan, due: false, nextCheckMs: jitteredDelayMs(7) };
  }

  /** Verification keys already confirmed this session, per (deployment, circuit). */
  private vkChecked = new Set<string>();

  /** Confirm once per session; the keys are immutable, so once is enough. */
  private async assertVk(cfg: { verifier: string }, circuit: CircuitName): Promise<void> {
    const key = `${cfg.verifier}:${circuit}`;
    if (this.vkChecked.has(key)) return;
    const { address } = requireSession();
    const source = await this.server().getAccount(address);
    await assertVerificationKey(
      this.server(),
      cfg.verifier,
      circuit,
      source,
      NETWORKS[this.network].passphrase,
    );
    this.vkChecked.add(key);
  }

  private lastKeepAlive = 0;

  /** Any operation we submitted recently already touched the entry. */
  private recentlyActive(): boolean {
    return Date.now() - this.lastKeepAlive < 7 * 24 * 3600_000;
  }

  /** Envelopes this controller built, awaiting confirmation. Keyed by tx hash. */
  private pending = new Map<string, { xdr: string; at: number; private?: StagedAfter }>();
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
      throw new Error(
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
        record: (e) => writeLocal(KEYS.inFlight, e),
        clear: () => removeLocal(KEYS.inFlight),
      },
    });
    if (outcome.kind === "succeeded") {
      return { hash: outcome.hash, ledger: outcome.ledger };
    }
    throw new Error(describeOutcome(outcome));
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

/** Every terminal outcome, said plainly, including what it cost. */
function describeOutcome(outcome: SubmitOutcome): string {
  return outcome.kind === "failed"
    ? `The transaction was included but failed on chain (${outcome.reason}). ` +
        `A fee was charged and the sequence number was used.`
    : outcome.kind === "rejected"
      ? `The network rejected it (${outcome.reason}). Nothing was charged.`
      : outcome.kind === "notAccepted"
        ? "The RPC did not accept it. Nothing was charged; you can try again now."
        : outcome.kind === "pending"
          ? `It has not confirmed yet. It may still land, so do not resend: ` +
            `check the hash ${outcome.hash} before trying again.`
          : "The transaction succeeded.";
}

export { WrongPasswordError, readTrustline };

/** TTL reported as a plain date, never a ledger number. */
function ttlFields(t: TtlStatus): { expiresAt?: string; daysRemaining?: number } {
  if (t.kind === "healthy" || t.kind === "expiring") {
    return { expiresAt: t.expiresAt.toISOString(), daysRemaining: Math.round(t.daysRemaining) };
  }
  return {};
}
