// The popup/background message contract.
//
// Keys live in the service worker; the popup is a thin UI. Every payload here
// must be structured-cloneable, so amounts cross as decimal strings and are
// parsed back to bigint stroops on arrival. Never floats.
import type { NetworkId } from "./config";
import type { SubmitOutcome } from "./chain/submit";

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

/**
 * Every state the private pocket can report, as one closed set.
 *
 * A union rather than `string`, because this vocabulary is written down in
 * three places: here, the controller branch that produces it, and the popup
 * map that titles it. As a bare `string` those three drifted, and a state the
 * popup has no title for renders as its own raw identifier. Closing the set
 * makes the compiler hold them together.
 */
export type PrivatePocketState =
  | "unavailable"
  | "unfunded"
  | "unregistered"
  | "archived"
  | "needsRecovery"
  | "diverged"
  | "ready";

export interface PrivatePocket {
  state: PrivatePocketState;
  /** Sendable now. Decimal string. */
  spendable?: string;
  /** Received but not yet merged. One signature away from spendable. */
  receiving?: string;
  /** True when a merge would make more funds sendable. */
  mergeAvailable?: boolean;
  auditorId?: number;
  /** Plain date, never a ledger number. */
  expiresAt?: string;
  daysRemaining?: number;
  /** Set when the state is one the user must act on. */
  message?: string;
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
  /** Present when this deployment has a confidential wrapper configured. */
  privateAvailable: boolean;
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
  | { type: "privatePocket" }
  | { type: "rebuildFromHistory" }
  | { type: "dappSessions" }
  | { type: "connectDapp"; origin: string }
  | { type: "disconnectDapp"; origin: string }
  | { type: "buildPrivateOp"; op: PrivateOpRequest }
  | { type: "confirmPrivateOp"; handle: string }
  | { type: "inFlight" }
  | { type: "reconcileInFlight" }
  | { type: "recoverFromMnemonic"; mnemonic: string; password: string }
  | { type: "setNetwork"; network: NetworkId };

/** The five private-pocket operations, as the popup asks for them. */
export type PrivateOpRequest =
  // No auditorId. Under D8 the wallet registers the account's OWN auditor key
  // and uses the id the registry allocates. Letting a caller name one is how a
  // hardcoded 0 bound every user to the operator's key.
  | { kind: "register" }
  | { kind: "shield"; amount: string }
  | { kind: "merge" }
  | { kind: "transfer"; to: string; amount: string }
  | { kind: "unshield"; amount: string };

/**
 * What the approval screen renders before a private operation is signed.
 *
 * `effects` is the whole point: every consequence stated in plain words,
 * including which facts become public and which are permanent. §14.7 forbids
 * blind signing, and an operation whose effects are not enumerable here should
 * not be offered at all.
 */
export interface PrivateOpSummary {
  kind: PrivateOpRequest["kind"];
  to?: string;
  amount?: string;
  fee: string;
  effects: string[];
}

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
  privatePocket: PrivatePocket;
  rebuildFromHistory: PrivatePocket;
  dappSessions: { origin: string; connectedAt: number; address: string }[];
  connectDapp: { origin: string; connectedAt: number };
  disconnectDapp: void;
  /** `handle` is opaque, exactly as buildPayment's is. */
  buildPrivateOp: { handle: string; summary: PrivateOpSummary };
  confirmPrivateOp: { hash: string; ledger: number; followed?: string };
  inFlight: { hash: string; maxTime: number; expired: boolean } | null;
  reconcileInFlight: SubmitOutcome | null;
  recoverFromMnemonic: string;
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
