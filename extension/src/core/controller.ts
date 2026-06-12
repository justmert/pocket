// The wallet controller. Owns the vault, the session and every chain call.
// Runs in the service worker; the popup never touches keys.
import { rpc } from "@stellar/stellar-sdk";
import { Account, Asset, Keypair } from "@stellar/stellar-sdk/base";
import { generateMnemonic, mnemonicToSeed, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { NETWORKS, DEFAULT_NETWORK, type NetworkId } from "./config";
import { createVault, unlockVault, WrongPasswordError } from "./vault/vault";
import type { VaultHeader, Bytes } from "./vault/envelope";
import { setSession, clearSession, getSession, requireSession } from "./session";
import { KEYS, readLocal, writeLocal, removeLocal } from "../lib/storage";
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
import { readConfidentialAccount } from "./chain/confidential";
import { readAccountTtl, type TtlStatus } from "./chain/ttl";
import { balancesOf, verifyAgainstChain } from "./private";
import type { Opening } from "./witness/types";
import { deriveEd25519 } from "./keys/sep5";

/** 0.5 XLM. A network parameter, currently identical on testnet and mainnet. */
const BASE_RESERVE_STROOPS = 5_000_000n;

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
    clearSession();
    await removeLocal(KEYS.vaultHeader);
    await removeLocal(KEYS.state);
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

  /** Envelopes this controller built, awaiting confirmation. Keyed by tx hash. */
  private pending = new Map<string, { xdr: string; at: number }>();
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
    throw new Error(
      outcome.kind === "failed"
        ? `The transaction was included but failed on chain (${outcome.reason}). ` +
          `A fee was charged and the sequence number was used.`
        : outcome.kind === "rejected"
          ? `The network rejected it (${outcome.reason}). Nothing was charged.`
          : outcome.kind === "notAccepted"
            ? "The RPC did not accept it. Nothing was charged; you can try again now."
            : `It has not confirmed yet. It may still land, so do not resend: ` +
              `check the hash ${outcome.hash} before trying again.`,
    );
  }
}

export { WrongPasswordError, readTrustline };

/** TTL reported as a plain date, never a ledger number. */
function ttlFields(t: TtlStatus): { expiresAt?: string; daysRemaining?: number } {
  if (t.kind === "healthy" || t.kind === "expiring") {
    return { expiresAt: t.expiresAt.toISOString(), daysRemaining: Math.round(t.daysRemaining) };
  }
  return {};
}
