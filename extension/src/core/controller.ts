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
import { KEYS, readLocal, writeLocal } from "../lib/storage";
import { readNative, readTrustline, formatAmount, parseAmount } from "./chain/balances";
import { buildPayment } from "./chain/payment";
import { submitAndConfirm } from "./chain/submit";
import { parseAddress } from "./chain/address";
import type { PublicBalance, WalletStatus, TransferSummary } from "./messages";
import { deriveEd25519 } from "./keys/sep5";

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

  async status(): Promise<WalletStatus> {
    const header = await readLocal<VaultHeader>(KEYS.vaultHeader);
    const session = getSession();
    return {
      initialised: header !== undefined,
      locked: session === null,
      network: this.network,
      address: session?.address,
      // Set once a confidential account exists for this address. Phase 6.
      privateEnabled: false,
    };
  }

  /** Create a new wallet. Returns the mnemonic exactly once, for backup. */
  async create(password: string): Promise<{ mnemonic: string; address: string }> {
    if (await readLocal<VaultHeader>(KEYS.vaultHeader)) {
      throw new Error("a wallet already exists; importing would overwrite it");
    }
    const mnemonic = generateMnemonic(wordlist, 256);
    const address = await this.installSeed(password, mnemonic);
    return { mnemonic, address };
  }

  async import(password: string, mnemonic: string): Promise<{ address: string }> {
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

  async setNetwork(network: NetworkId): Promise<WalletStatus> {
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
      out.push({
        id: "native",
        code: "XLM",
        amount: formatAmount(native.raw),
        authorized: true,
      });
    } catch {
      // Account not created yet. Report zero rather than an error so the UI can
      // show a fund-me state instead of a failure.
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
    const amount = parseAmount(req.amount);
    const asset = req.assetId === "native" ? Asset.native() : this.assetFromId(req.assetId);

    const seq = await this.server().getAccount(address);
    const tx = buildPayment(
      new Account(address, seq.sequenceNumber()),
      { from: address, to: to.value, asset, amount, memo: req.memo },
      NETWORKS[this.network].passphrase,
    );

    return {
      xdr: tx.toXDR(),
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

  /** Sign and submit a previously built transaction. */
  async confirmPayment(xdr: string): Promise<{ hash: string; ledger: number }> {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk/base");
    const tx = TransactionBuilder.fromXDR(xdr, NETWORKS[this.network].passphrase);
    if ("operations" in tx) tx.sign(this.keypair());
    const outcome = await submitAndConfirm(this.server(), tx);
    if (outcome.kind === "succeeded") {
      return { hash: outcome.hash, ledger: outcome.ledger };
    }
    throw new Error(
      outcome.kind === "failed"
        ? `transaction failed on chain: ${outcome.reason}`
        : outcome.kind === "rejected"
          ? `rejected: ${outcome.reason}`
          : "transaction did not confirm in time; it may still land",
    );
  }
}

export { WrongPasswordError, readTrustline };
