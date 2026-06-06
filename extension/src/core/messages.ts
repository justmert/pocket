// The popup/background message contract.
//
// Keys live in the service worker; the popup is a thin UI. Every payload here
// must be structured-cloneable, so amounts cross as decimal strings and are
// parsed back to bigint stroops on arrival. Never floats.
import type { NetworkId } from "./config";

export interface PublicBalance {
  id: string;
  code: string;
  issuer?: string;
  /** SPENDABLE amount, decimal string. For native XLM this excludes the reserve. */
  amount: string;
  /** Full balance including anything locked. Present for native only. */
  total?: string;
  /** Protocol-locked reserve. Present for native only. */
  reserved?: string;
  authorized: boolean;
}

export interface WalletStatus {
  /** No vault yet: onboarding. */
  initialised: boolean;
  /** Vault exists but is locked: no keys in memory. */
  locked: boolean;
  network: NetworkId;
  address?: string;
  /** True once a confidential account is registered for this address. */
  privateEnabled: boolean;
}

export type WalletRequest =
  | { type: "status" }
  | { type: "create"; password: string }
  | { type: "import"; password: string; mnemonic: string }
  | { type: "unlock"; password: string }
  | { type: "lock" }
  | { type: "balances" }
  | { type: "buildPayment"; to: string; amount: string; assetId: string; memo?: string }
  | { type: "confirmPayment"; handle: string }
  | { type: "reset"; password: string }
  | { type: "setNetwork"; network: NetworkId };

export type WalletResponse<T> = { ok: true; data: T } | { ok: false; error: string };

/** Narrow a request type to its response payload. */
export interface ResponseMap {
  status: WalletStatus;
  create: { mnemonic: string; address: string };
  import: { address: string };
  unlock: WalletStatus;
  lock: WalletStatus;
  balances: PublicBalance[];
  /** `xdr` is an opaque handle to the envelope the worker built and retained. */
  buildPayment: { xdr: string; summary: TransferSummary };
  confirmPayment: { hash: string; ledger: number };
  reset: void;
  setNetwork: WalletStatus;
}

/**
 * What an approval screen shows. Assembled from simulation or from decoding the
 * envelope, never from what a caller claims. Empty `effects` with
 * `decoded: false` means we could not determine what this does, and the UI must
 * default to refuse rather than render a raw blob next to an Approve button.
 */
export interface TransferSummary {
  decoded: boolean;
  /** Full recipient address. Never truncated at a confirm step. */
  to: string;
  amount: string;
  assetCode: string;
  /** Total fee in stroops, as a decimal string. */
  fee: string;
  memo?: string;
  /** Human-readable effects, one per balance movement or authorisation. */
  effects: string[];
  /** Set when decoding or simulation failed. */
  warning?: string;
}
