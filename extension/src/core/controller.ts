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
import { KEYS, readLocal, writeLocal, removeLocal, openingKeys } from "../lib/storage";
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

/** A recovery attempt the user can correct: a bad phrase, or the wrong wallet. */
export class RecoveryError extends Error {
  override readonly name = "RecoveryError";
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
  openings?: { spendable: Opening; receiving: Opening; syncedThrough: number };
  /** A shield's second transaction: the merge that makes a deposit spendable. */
  follow?: Transaction;
  /** The deposit amount a shield credits to the receiving side. */
  credit?: bigint;
}

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
   * A transaction that was submitted but whose outcome we never saw, because
   * the worker died or the popup closed. Never resend it: poll by hash, and
   * only rebuild once its timeBounds have passed.
   */
  async inFlight(): Promise<{ hash: string; maxTime: number; expired: boolean } | null> {
    const e = await readLocal<{ hash: string; maxTime: number }>(KEYS.inFlight);
    if (!e) return null;
    return { ...e, expired: e.maxTime > 0 && Math.floor(Date.now() / 1000) > e.maxTime };
  }

  /** Resolve an in-flight transaction by polling its hash. */
  async reconcileInFlight(): Promise<SubmitOutcome | null> {
    const e = await readLocal<{ hash: string; maxTime: number }>(KEYS.inFlight);
    if (!e) return null;
    const outcome = await pollToTerminal(this.server(), e.hash, { attempts: 3 });
    if (outcome.kind !== "pending") await removeLocal(KEYS.inFlight);
    return outcome;
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
    let source;
    try {
      source = await this.server().getAccount(address);
    } catch {
      this.privateReady = false;
      return {
        state: "unfunded",
        message:
          "This account does not exist on the network yet. Receive some XLM first, " +
          "then you can set up a private pocket.",
      };
    }

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
      `${KEYS.openings}.${token}.${address}`,
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
      `${KEYS.openings}.${token}.${address}`,
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
    await removeLocal(KEYS.vaultHeader);
    await removeLocal(KEYS.state);
    await removeLocal(KEYS.inFlight);
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
    const { address } = requireSession();
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
    const { address } = requireSession();
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
        }, { openings: { ...openings, syncedThrough: 0 } });
      }

      case "shield": {
        const amount = parseAmount(req.amount);
        // Two transactions: a deposit credits the RECEIVING side, so shielding
        // without the merge leaves a zero spendable balance and no explanation.
        const { deposit, merge } = await ops.buildShield(ctx, amount);
        return this.stagePrivate(deposit, {
          kind: "shield",
          amount: formatAmount(amount),
          effects: [
            `Move ${formatAmount(amount)} XLM from the public pocket into the private one`,
            "This deposit amount is PUBLIC on the ledger. Only later transfers hide amounts",
            "A second signature then makes it spendable",
            `Pay a network fee of ${formatAmount(BigInt(deposit.fee))} XLM`,
          ],
        }, { follow: merge, credit: amount });
      }

      case "merge": {
        const tx = await ops.buildMerge(ctx);
        const stored = await this.requireOpenings(address, cfg.token);
        const after = applyMerge(stored);
        return this.stagePrivate(tx, {
          kind: "merge",
          effects: [
            "Fold everything you have received into your spendable balance",
            "Amounts stay hidden. This proves nothing and reveals nothing",
            `Pay a network fee of ${formatAmount(BigInt(tx.fee))} XLM`,
          ],
        }, { openings: { ...after, syncedThrough: stored.syncedThrough } });
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
          openings: {
            spendable: newSpendable,
            receiving: stored.receiving,
            syncedThrough: stored.syncedThrough,
          },
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
          openings: {
            spendable: newSpendable,
            receiving: stored.receiving,
            syncedThrough: stored.syncedThrough,
          },
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

    const cfg = this.confidentialConfig();
    const { address } = requireSession();
    const outcome = await this.signAndSubmit(decoded);
    if (outcome.kind !== "succeeded") throw new Error(describeOutcome(outcome));

    // A shield is two transactions. The deposit has landed and the funds are
    // in the receiving balance; the merge that makes them spendable is a
    // separate signature, and saying so is better than leaving a user with a
    // zero spendable balance and no explanation.
    let followed: string | undefined;
    if (entry.private.follow) {
      const ops = await import("./confidential-ops");
      const ctx = await this.opContext();
      const mergeTx = await ops.buildMerge(ctx);
      const second = await this.signAndSubmit(mergeTx);
      if (second.kind !== "succeeded") {
        throw new PrivatePocketError(
          `The deposit succeeded (${outcome.hash}) but making it spendable did not. ` +
            `Your funds are in the receiving balance. Press "Make spendable" to finish.`,
        );
      }
      followed = second.hash;
      const stored = (await this.readOpenings(address, cfg.token)) ?? {
        spendable: ZERO_OPENING,
        receiving: ZERO_OPENING,
        syncedThrough: 0,
      };
      // A deposit credits the receiving side with randomness zero, and the
      // merge then folds it into spendable.
      const credited = credit(stored.receiving, {
        value: entry.private.credit ?? 0n,
        randomness: 0n,
      });
      const after = applyMerge({ spendable: stored.spendable, receiving: credited });
      await this.persistVerified(address, cfg, { ...after, syncedThrough: stored.syncedThrough });
      return { hash: outcome.hash, ledger: outcome.ledger, followed };
    }

    if (entry.private.openings) {
      await this.persistVerified(address, cfg, entry.private.openings);
    }
    return { hash: outcome.hash, ledger: outcome.ledger, followed };
  }

  private async signAndSubmit(tx: Transaction): Promise<SubmitOutcome> {
    // A Soroban invocation needs its footprint and auth entries populated, and
    // simulation is the only thing that can do it. Signing before this would
    // produce an envelope the network rejects at once.
    const prepared = await this.server().prepareTransaction(tx);
    prepared.sign(this.keypair());
    return submitAndConfirm(this.server(), prepared, {
      inFlight: {
        record: (e) => writeLocal(KEYS.inFlight, e),
        clear: () => removeLocal(KEYS.inFlight),
      },
    });
  }

  /** Store openings only once the chain agrees they open what it holds. */
  private async persistVerified(
    address: string,
    cfg: { token: string },
    state: { spendable: Opening; receiving: Opening; syncedThrough: number },
  ): Promise<void> {
    const account = await this.readOwnAccount(address, cfg);
    const check = verifyAgainstChain(state, account);
    if (!check.ok) {
      throw new PrivatePocketError(
        `The transaction landed, but the ${check.which} balance this device computed does not ` +
          `match what the contract now holds. Your funds are safe on chain. Rebuild from ` +
          `history before spending again.`,
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
    const session = getSession();
    const cfg = NETWORKS[this.network].confidential[0];
    if (!session || !cfg) return { due: false, nextCheckMs: jitteredDelayMs(7) };

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
    this.prunePending();
    const entry = this.pending.get(handle);
    if (!entry) {
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
