// The popup/background message contract.
//
// Keys live in the service worker; the popup is a thin UI. Every payload here
// must be structured-cloneable, so amounts cross as decimal strings and are
// parsed back to bigint stroops on arrival. Never floats.
import type { NetworkId } from "./config";
import type { SubmitOutcome } from "./chain/submit";
import type { TxSummary } from "./provider/describe-tx";
import type { RangeId } from "./chain/prices";

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
  /**
   * Which confidential asset this pocket is. Absent only on the "unavailable"
   * state, where there is no deployment to identify. `token` is the wrapper
   * contract, the stable id a request passes back as `asset`; `symbol` is for
   * display; `underlying` is the SAC it wraps. A wallet has one pocket per
   * configured confidential asset (XLM, USDC, ...), so these distinguish them.
   */
  symbol?: string;
  token?: string;
  underlying?: string;
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
  /**
   * The confidential assets configured on this network, one per wrapper
   * deployment. Empty when the private pocket is unavailable. Lets a screen
   * enumerate the private pockets (XLM, USDC, ...) and pass `token` as the
   * `asset` selector on the private requests below.
   */
  privateAssets: { symbol: string; token: string; underlying: string }[];
  /** The idle auto-lock window, in minutes, so the settings screen can show it. */
  autoLockMinutes: number;
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
  | { type: "revealPhrase"; password: string }
  // `asset` selects which confidential wrapper (multiple can be configured,
  // e.g. XLM and USDC). It accepts the wrapper `token` address (preferred, from
  // `status.privateAssets`), or the underlying SAC, or the display symbol.
  // Omitted means the primary (first configured) asset, so callers that predate
  // multi-asset keep working unchanged.
  | { type: "privatePocket"; asset?: string }
  | { type: "privatePockets" }
  | { type: "rebuildFromHistory"; asset?: string }
  | { type: "dappSessions" }
  | { type: "connectDapp"; origin: string }
  | { type: "disconnectDapp"; origin: string }
  | { type: "yieldPosition" }
  // Yield deposit/withdraw (public pocket). Build returns a handle + decoded
  // summary; confirm signs and submits, exactly like buildPayment/confirmPayment.
  | { type: "buildYieldMove"; kind: "deposit" | "withdraw"; amount: string }
  | { type: "confirmYieldMove"; handle: string }
  // In-app swap (public pocket, via Aquarius). `swapQuote` is a read (show a
  // quote first); build/confirm follow the buildPayment/confirmPayment pattern.
  // assetIn/assetOut are assetId strings ("native" or "CODE:ISSUER").
  | { type: "swapQuote"; assetIn: string; assetOut: string; amount: string }
  | { type: "buildSwap"; assetIn: string; assetOut: string; amount: string; slippageBps?: number }
  | { type: "confirmSwap"; handle: string }
  // CCTP cross-chain USDC (public pocket). Stellar legs only: Pocket signs the
  // outbound burn and the inbound mint; the other chain's leg is the user's
  // wallet there or a relayer. `destinationDomain`/`sourceDomain` are CCTP domain
  // ids; `recipient` is a 0x EVM address; `txHash` is the source-chain burn tx.
  | {
      type: "buildCctpSend";
      destinationDomain: number;
      recipient: string;
      amount: string;
      fast?: boolean;
    }
  | { type: "confirmCctpSend"; handle: string }
  | { type: "cctpAttestation"; sourceDomain: number; txHash: string }
  | { type: "buildCctpClaim"; sourceDomain: number; txHash: string }
  | { type: "confirmCctpClaim"; handle: string }
  | { type: "currentPhase" }
  | { type: "pendingDappRequest" }
  | { type: "resolveDappRequest"; id: string; approved: boolean }
  | { type: "buildPrivateOp"; op: PrivateOpRequest; asset?: string }
  | { type: "confirmPrivateOp"; handle: string }
  | { type: "inFlight" }
  | { type: "reconcileInFlight" }
  | { type: "recoverFromMnemonic"; mnemonic: string; password: string }
  | { type: "setNetwork"; network: NetworkId }
  | { type: "setAutoLock"; minutes: number }
  | { type: "valueSeries"; range: RangeId }
  | { type: "assetMarket"; symbol: string }
  | { type: "assetSeries"; symbol: string; range: RangeId }
  | {
      type: "history";
      cursor?: string;
      limit?: number;
      pocket?: "public" | "private";
      /** Restrict the private half to one confidential asset (see `asset` above). */
      asset?: string;
    };

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
  /** The recovery phrase, handed back once for re-display behind the password.
   *  A bare string, like `recoverFromMnemonic`: the worker returns it and the
   *  popup shows it; it is never stored, logged, or echoed anywhere else. */
  revealPhrase: string;
  privatePocket: PrivatePocket;
  /** One pocket per configured confidential asset, in config order. */
  privatePockets: PrivatePocket[];
  rebuildFromHistory: PrivatePocket;
  dappSessions: { origin: string; connectedAt: number; address: string }[];
  connectDapp: { origin: string; connectedAt: number };
  disconnectDapp: void;
  yieldPosition: YieldPosition;
  /** `handle` is opaque, exactly as buildPayment's is. */
  buildYieldMove: { handle: string; summary: YieldMoveSummary };
  confirmYieldMove: { hash: string; ledger: number };
  swapQuote: SwapQuoteView;
  buildSwap: { handle: string; summary: SwapSummary };
  confirmSwap: { hash: string; ledger: number };
  buildCctpSend: { handle: string; summary: CctpSummary };
  /** `hash` is the BURN tx (what the attestation service tracks). */
  confirmCctpSend: { approveHash: string; hash: string; ledger: number };
  cctpAttestation: { status: string; ready: boolean };
  buildCctpClaim: { handle: string; summary: CctpSummary };
  confirmCctpClaim: { hash: string; ledger: number };
  currentPhase: string | null;
  pendingDappRequest: { id: string; origin: string; summary: TxSummary } | null;
  resolveDappRequest: void;
  /** `handle` is opaque, exactly as buildPayment's is. */
  buildPrivateOp: { handle: string; summary: PrivateOpSummary };
  confirmPrivateOp: { hash: string; ledger: number; followed?: string };
  inFlight: { hash: string; maxTime: number; expired: boolean } | null;
  reconcileInFlight: SubmitOutcome | null;
  recoverFromMnemonic: string;
  setNetwork: WalletStatus;
  setAutoLock: WalletStatus;
  valueSeries: ValueChart;
  assetMarket: AssetMarketView;
  assetSeries: ValueChart;
  history: HistoryPage;
}

/**
 * A chart, or an honest account of why there is none.
 *
 * `points` empty means the wallet could not read enough to draw one, and the UI
 * shows no chart. It never shows a flat line at zero, because "we could not read
 * this" and "you had nothing" are different facts and only the second is about
 * the user. A stretch that predates the account IS drawn as zero, because that
 * one is true.
 */
export interface ValueChart {
  /** Oldest first. Value is in USD. */
  points: { at: number; value: number }[];
  /** Change across the range, as a percentage. Null when it starts from zero. */
  changePct: number | null;
}

/** Market facts about one asset. Every field independently nullable. */
export interface AssetMarketView {
  price: number | null;
  change24h: number | null;
  volume24h: number | null;
}

/**
 * One transaction in the account's history, from either pocket.
 *
 * Public entries come from Horizon and carry every field. Private entries come
 * from the confidential event archive: their addresses are public on chain (from
 * the event topics) but the amount is known only to this device, decrypted from
 * its openings, and is `null` when this device cannot verify it.
 */
export interface HistoryEntry {
  /** Stable and unique across both pockets. Public: `${txHash}:${opId}`; private: the event id. */
  id: string;
  pocket: "public" | "private";
  /**
   * What happened, in the wallet's own words:
   *   receive/send   an ordinary public payment in or out
   *   create         the account being funded into existence
   *   shield/unshield  moved between pockets (confidential deposit / withdraw)
   *   privateReceive/privateSend  a confidential transfer in or out
   *   makeSpendable  received private funds folded into the spendable balance (merge)
   *   setup          the confidential account being registered
   */
  kind:
    | "receive"
    | "send"
    | "create"
    | "shield"
    | "unshield"
    | "privateReceive"
    | "privateSend"
    | "makeSpendable"
    | "setup";
  /** Which way value moved, from this account's point of view. */
  direction: "in" | "out" | "self";
  /** Asset code, e.g. "XLM" or "USDC". */
  code: string;
  /**
   * Decimal amount string, or null when it cannot be determined on this device
   * (a private transfer whose opening this device cannot verify). Never a float:
   * public amounts are Horizon's own decimal strings, private amounts are
   * formatted from bigint stroops.
   */
  amount: string | null;
  /** The other party's address, when the operation has one. */
  counterparty?: string;
  /** Epoch milliseconds. */
  at: number;
  /** Stellar transaction hash. */
  hash: string;
  /** Ledger sequence, when known. */
  ledger?: number;
  /** Network fee in decimal XLM, when known. Public entries carry it from the
   *  transaction the payment belongs to. */
  fee?: string;
}

/** A page of history, newest first, with a cursor for the next (older) page. */
export interface HistoryPage {
  entries: HistoryEntry[];
  /** Opaque; pass back as `cursor` for the next page. Null when there are no more. */
  cursor: string | null;
}

/**
 * What an approval screen shows. Assembled from simulation or from decoding the
 * envelope, never from what a caller claims. Empty `effects` with
 * `decoded: false` means we could not determine what this does, and the UI must
 * default to refuse rather than render a raw blob next to an Approve button.
 */
/** What the approval screen renders before a yield deposit or withdrawal. */
export interface YieldMoveSummary {
  kind: "deposit" | "withdraw";
  /** Decimal amount of the underlying, e.g. "10.0000000". */
  amount: string;
  /** Network fee in decimal XLM. */
  fee: string;
  /** Every consequence in plain words, including that it is public. */
  effects: string[];
}

/** A swap quote to show before building: amounts and the route, no commitment. */
export interface SwapQuoteView {
  assetIn: string;
  assetOut: string;
  /** Decimal amount of the input. */
  amountIn: string;
  /** Estimated decimal amount out. */
  estOut: string;
  /** Tokens on the route, for display. */
  route: string[];
}

/** What the approval screen renders before a swap is signed. */
export interface SwapSummary {
  assetIn: string;
  assetOut: string;
  amountIn: string;
  estOut: string;
  /** The minimum out after slippage; the swap reverts below it. */
  minOut: string;
  /** Network fee in decimal XLM. */
  fee: string;
  route: string[];
  effects: string[];
}

/** What the approval screen renders before a CCTP bridge or claim. */
export interface CctpSummary {
  /** "out" = burning on Stellar to another chain; "in" = claiming a mint here. */
  direction: "out" | "in";
  /** The other chain's display name. */
  chain: string;
  /** Decimal amount, when known (out: what is bridged; in may be unknown). */
  amount?: string;
  /** Dust left behind by the 7dp->6dp scale on an outbound bridge. */
  dust?: string;
  /** Network fee in decimal XLM. */
  fee: string;
  effects: string[];
}

/** What the public pocket can say about yield, including that there is none. */
export interface YieldPosition {
  available: boolean;
  reason?: string;
  vault?: string;
  apy?: string;
  balance?: string;
  underlying?: string;
}

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
