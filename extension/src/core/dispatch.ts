// Request router. One place where a message becomes a controller call, so the
// error taxonomy and the locked check live in exactly one spot.
import type { WalletController } from "./controller";
import type { PrivateOpRequest, WalletRequest } from "./messages";
import { WrongPasswordError } from "./vault/vault";
import { InvalidAddressError } from "./chain/address";
import { RANGES, type RangeId } from "./chain/prices";
import { NETWORKS, type NetworkId } from "./config";

/**
 * Operations permitted while locked.
 *
 * `reset` is NOT here: it destroys a vault and its only authorisation is the
 * current password, so the lock is the thing standing in front of it.
 *
 * Everything that IS here carries its own authorisation, and that, not the
 * lock, is what makes each one safe:
 *
 *   `import` refuses outright when a vault already exists, so it can never
 *   replace a funded wallet's seed. Where there is no vault there is nothing
 *   for the lock to protect, and a fresh install has no vault to unlock, so
 *   gating it made "I have a recovery phrase" impossible rather than merely
 *   awkward. Verified: with it removed, e2e "an imported phrase reproduces the
 *   same address" fails at the fresh-profile restore.
 *
 *   `recoverFromMnemonic` requires the recovery phrase AND checks that phrase
 *   derives the account this device already holds, refusing outright when it
 *   cannot check. A stray message carries no phrase; a phrase for a different
 *   wallet is refused. Anyone who satisfies both already owns the funds.
 *
 * The rule to apply when adding to this list: the lock is not the guard. An
 * operation belongs here only when it would still be safe with the lock
 * removed entirely.
 */
const ALLOWED_WHILE_LOCKED = new Set([
  "status",
  "create",
  "import",
  "unlock",
  "lock",
  "recoverFromMnemonic",
]);

/**
 * A field the sender must actually have sent, as a string.
 *
 * The type union describes what the popup is supposed to send, and erases at
 * runtime. Nothing downstream re-checks: an absent password reaches the KDF, an
 * absent mnemonic reaches the validator, an object reaches `parseAddress`. The
 * sender is our own popup today, so this is defence in depth rather than a
 * boundary against an attacker, but it is the boundary where a shape error
 * should be named instead of surfacing three layers down.
 */
function str(v: unknown, field: string): string {
  if (typeof v !== "string") throw new Error(`malformed request: ${field} must be a string`);
  return v;
}

function optionalStr(v: unknown, field: string): string | undefined {
  return v === undefined || v === null ? undefined : str(v, field);
}

/**
 * A whole number the sender must actually have sent.
 *
 * Integer, not merely finite. Every field that reaches this is a count, a
 * duration, a domain id or a basis point, and each is used as a whole number
 * downstream. A fractional one used to pass: `slippageBps` of 100.5 cleared the
 * range check in `buildSwap` and then reached `BigInt(10_000 - 100.5)`, which
 * throws a RangeError. `RangeError` is not in SAFE_ERRORS, so a malformed
 * message surfaced as "Something went wrong. Try again." instead of being named
 * at the boundary, which is the whole point of these helpers.
 */
/**
 * A network this build actually knows.
 *
 * `setNetwork` was the one case here that passed a field straight through, and
 * it is the worst one to have missed: the value is ASSIGNED to
 * `controller.network` and then PERSISTED, so an unknown string leaves every
 * later `NETWORKS[this.network]` undefined and survives a restart. The wallet
 * does not fail at the boundary with a named error, it fails on the next read
 * of anything, forever, and there is no screen that can set it back.
 *
 * Checked against the table itself rather than a literal list, so a network
 * added to config is accepted here without a second edit that could be missed.
 */
function networkId(v: unknown, field: string): NetworkId {
  if (typeof v !== "string" || !Object.prototype.hasOwnProperty.call(NETWORKS, v)) {
    throw new Error(`malformed request: ${field} is not a network this build knows`);
  }
  return v as NetworkId;
}

function num(v: unknown, field: string): number {
  if (typeof v !== "number" || !Number.isInteger(v)) {
    throw new Error(`malformed request: ${field} must be a whole number`);
  }
  return v;
}

function optionalNum(v: unknown, field: string): number | undefined {
  return v === undefined || v === null ? undefined : num(v, field);
}

/**
 * A chart range, checked against the closed set rather than passed through.
 *
 * The range decides a `resolution` and a `limit` that go into a Horizon query
 * string. Horizon answers 400 for a resolution outside its six, so an unchecked
 * value here would turn a malformed message into a failed request instead of a
 * named error, and the chart would simply not appear with nothing saying why.
 */
function rangeId(v: unknown): RangeId {
  if (typeof v !== "string" || !(v in RANGES)) {
    throw new Error("malformed request: unknown chart range");
  }
  return v as RangeId;
}

const OP_KINDS = new Set(["register", "shield", "merge", "transfer", "unshield"]);

/** The private-op request, checked before it reaches key material. */
function opRequest(v: unknown): PrivateOpRequest {
  const op = v as Partial<PrivateOpRequest> | undefined;
  if (!op || typeof op !== "object" || typeof op.kind !== "string" || !OP_KINDS.has(op.kind)) {
    throw new Error("malformed request: unknown private operation");
  }
  if (op.kind === "shield" || op.kind === "unshield" || op.kind === "transfer") {
    str((op as { amount?: unknown }).amount, "amount");
  }
  if (op.kind === "transfer") str((op as { to?: unknown }).to, "to");
  return op as PrivateOpRequest;
}

export async function dispatch(c: WalletController, msg: WalletRequest): Promise<unknown> {
  switch (msg.type) {
    case "status":
      return c.status();
    case "create":
      return c.create(str(msg.password, "password"));
    case "import":
      return c.import(str(msg.password, "password"), str(msg.mnemonic, "mnemonic"));
    case "unlock":
      return c.unlock(str(msg.password, "password"));
    case "lock":
      await c.lock();
      return c.status();
    case "setNetwork":
      return c.setNetwork(networkId(msg.network, "network"));
    case "setAutoLock":
      return c.setAutoLock(num(msg.minutes, "minutes"));
    case "fundTestnet":
      return c.fundTestnet();
    case "balances":
      return c.balances();
    case "buildPayment":
      return c.buildPayment({
        to: str(msg.to, "to"),
        amount: str(msg.amount, "amount"),
        assetId: str(msg.assetId, "assetId"),
        memo: optionalStr(msg.memo, "memo"),
      });
    case "confirmPayment":
      return c.confirmPayment(str(msg.handle, "handle"));
    case "reset":
      return c.reset(str(msg.password, "password"));
    case "revealPhrase":
      return c.revealPhrase(str(msg.password, "password"));
    case "privatePocket":
      return c.privatePocket(optionalStr(msg.asset, "asset"));
    case "privatePockets":
      return c.privatePockets();
    case "rebuildFromHistory":
      return c.rebuildFromHistory(optionalStr(msg.asset, "asset"));
    case "archiveReadiness":
      return c.archiveReadiness();
    case "dappSessions":
      return c.dappSessions();
    case "connectDapp":
      return c.connectDapp(str(msg.origin, "origin"));
    case "currentPhase":
      return c.currentPhase();
    case "yieldPosition":
      return c.yieldPosition();
    case "buildYieldMove":
      return c.buildYieldMove(
        msg.kind === "withdraw" ? "withdraw" : "deposit",
        str(msg.amount, "amount"),
      );
    case "confirmYieldMove":
      return c.confirmYieldMove(str(msg.handle, "handle"));
    case "swapQuote":
      return c.swapQuote(
        str(msg.assetIn, "assetIn"),
        str(msg.assetOut, "assetOut"),
        str(msg.amount, "amount"),
      );
    case "buildSwap":
      return c.buildSwap(
        str(msg.assetIn, "assetIn"),
        str(msg.assetOut, "assetOut"),
        str(msg.amount, "amount"),
        optionalNum(msg.slippageBps, "slippageBps"),
      );
    case "confirmSwap":
      return c.confirmSwap(str(msg.handle, "handle"));
    case "buildAddTrustline":
      return c.buildAddTrustline(str(msg.assetCode, "assetCode"), str(msg.issuer, "issuer"));
    case "confirmAddTrustline":
      return c.confirmAddTrustline(str(msg.handle, "handle"));
    case "trustlines":
      return c.trustlines();
    case "assetSearch":
      return c.assetSearch(str(msg.query, "query"));
    case "buildRemoveTrustline":
      return c.buildRemoveTrustline(str(msg.assetCode, "assetCode"), str(msg.issuer, "issuer"));
    case "buildCctpSend":
      return c.buildCctpSend(
        num(msg.destinationDomain, "destinationDomain"),
        str(msg.recipient, "recipient"),
        str(msg.amount, "amount"),
        msg.fast === true,
      );
    case "confirmCctpSend":
      return c.confirmCctpSend(str(msg.handle, "handle"));
    case "cctpAttestation":
      return c.cctpAttestation(num(msg.sourceDomain, "sourceDomain"), str(msg.txHash, "txHash"));
    case "buildCctpClaim":
      return c.buildCctpClaim(num(msg.sourceDomain, "sourceDomain"), str(msg.txHash, "txHash"));
    case "confirmCctpClaim":
      return c.confirmCctpClaim(str(msg.handle, "handle"));
    case "pendingDappRequest":
      return c.pendingDappRequest();
    case "resolveDappRequest":
      return c.resolveDappRequest(str(msg.id, "id"), msg.approved === true);
    case "disconnectDapp":
      return c.disconnectDapp(str(msg.origin, "origin"));
    case "buildPrivateOp":
      return c.buildPrivateOp(opRequest(msg.op), optionalStr(msg.asset, "asset"));
    case "confirmPrivateOp":
      return c.confirmPrivateOp(str(msg.handle, "handle"));
    case "inFlight":
      return c.inFlight();
    case "reconcileInFlight":
      return c.reconcileInFlight();
    case "recoverFromMnemonic":
      return c.recoverFromMnemonic(str(msg.mnemonic, "mnemonic"), str(msg.password, "password"));
    case "valueSeries":
      return c.valueSeries(rangeId(msg.range));
    case "assetMarket":
      return c.assetMarket(
        str(msg.symbol, "symbol"),
        msg.issuer === undefined ? undefined : str(msg.issuer, "issuer"),
      );
    case "assetSeries":
      return c.assetSeries(str(msg.symbol, "symbol"), rangeId(msg.range));
    case "history":
      return c.history(
        optionalStr(msg.cursor, "cursor"),
        optionalNum(msg.limit, "limit"),
        msg.pocket === "public" || msg.pocket === "private" ? msg.pocket : undefined,
        optionalStr(msg.asset, "asset"),
      );
    default: {
      // Without this, a message whose type is outside the union falls off the
      // end, resolves to undefined, and the worker answers {ok: true}. Any
      // unrelated runtime broadcast would then look like a successful
      // operation and re-arm the idle lock.
      const unknown = msg as { type?: string };
      throw new Error(`unsupported operation: ${String(unknown.type)}`);
    }
  }
}

export function isAllowedWhileLocked(type: string): boolean {
  return ALLOWED_WHILE_LOCKED.has(type);
}

/** Types that represent real user activity, and so should postpone the idle lock. */
const ACTIVITY = new Set([
  "unlock",
  "balances",
  "buildPayment",
  "confirmPayment",
  "setNetwork",
  "setAutoLock",
  // Funding a fresh account from friendbot is a deliberate user action that
  // takes a few seconds; it must not race the idle lock mid-flight.
  "fundTestnet",
  "create",
  "import",
  // A private operation is user activity too: proving can take a moment and a
  // transfer must not be interrupted by the idle lock mid-flight.
  "buildPrivateOp",
  "confirmPrivateOp",
  "privatePocket",
  "privatePockets",
  "rebuildFromHistory",
  "recoverFromMnemonic",
  // Yield deposit/withdraw are real user activity, like a payment.
  "buildYieldMove",
  "confirmYieldMove",
  // A swap, and the quote a user is actively requesting before it.
  "swapQuote",
  "buildSwap",
  "confirmSwap",
  // Opening a trustline is a public-pocket action, like a payment.
  "buildAddTrustline",
  "confirmAddTrustline",
  "buildRemoveTrustline",
  "trustlines",
  "assetSearch",
  // CCTP bridges. `cctpAttestation` is deliberately absent: it is a poll the UI
  // repeats while waiting, not user activity, so it must not postpone the lock.
  "buildCctpSend",
  "confirmCctpSend",
  "buildCctpClaim",
  "confirmCctpClaim",
]);

export function isUserActivity(type: string): boolean {
  return ACTIVITY.has(type);
}

/**
 * Errors whose message is written for a user and is safe to surface verbatim.
 * Everything else is replaced, because an arbitrary Error.message can carry an
 * RPC URL, a stack fragment, or, once phase 4 lands, witness material. SDK.md
 * 13 forbids witness values reaching a log or a UI string absolutely, and an
 * allowlist is the only version of that rule which cannot be forgotten.
 */
const SAFE_ERRORS = new Set([
  // WrongPasswordError is deliberately NOT here. It is handled by the
  // instanceof branch below, which replaces the message outright rather than
  // surfacing it. One mechanism per error: instanceof plus field mapping for
  // errors carrying structured causes, the name allowlist for errors whose
  // whole message is authored prose.
  "CorruptVaultError",
  "SchemaVersionError",
  "AccountNotFoundError",
  "PrivatePocketError",
  "RecoveryError",
  "ArchiveUnavailableError",
  "IncompleteHistoryError",
  "UnspendableBlindingError",
  "CctpParameterError",
  "AquariusError",
  // A classic asset cannot arrive at an account with no trustline for it. The
  // SAC refuses with Error(Contract, #13), which the SDK raises as a bare
  // `Error`, so unshielding private USDC and claiming a bridged transfer both
  // told the user to check their connection about a deterministic refusal whose
  // remedy is one button away. Its message names only the asset code.
  "TrustlineRequiredError",
  // Every contract refusal on every WRITE path. prepareTransaction throws a
  // bare `Error`, so every authored CONTRACT_ERRORS sentence was unreachable
  // and the user got the generic message about a deterministic refusal. Its
  // message is always one of ours; the RPC's own
  // text, which runs to hundreds of characters and can carry an address decoded
  // from the reply, never crosses.
  "ContractRefusedError",
  // The prover's three failure points threw bare `Error`s, so `e.name` was
  // "Error" and all of them fell through to the generic message, on the
  // wallet's slowest and most fragile step. Its messages are authored in
  // `prover/protocol.ts` and never carry bb's own text.
  "ProverError",
  "IrisError",
  // The fourth service client, and it was the one omission on this list that no
  // comment argued for. Its absence was not cosmetic: every sentence the yield
  // path authors for a user reached the screen as the generic message.
  // Measured against the built extension, `buildYieldMove` answered with that
  // generic line while `confirmSwap`,
  // `confirmCctpSend`, `confirmCctpClaim` and `confirmPayment` all answered with
  // their own words. Among the sentences it swallowed: "Yield is not configured
  // for this network." (a permanent property of the build, so the retry the
  // generic line suggests can never work) and "You need a trustline for this
  // vault's asset." (the one actionable failure the client goes out of its way
  // to map from errorCode 13).
  //
  // Its message surface is the same shape as the two above it, which is why it
  // belongs in the same place: authored prose, plus a `${res.status}` integer,
  // plus the fetch-rejection classification all three share.
  "DefindexError",
  "TrustlineError",
  "StellarExpertError",
  "ConfidentialReadError",
  "InsufficientBalanceError",
  "VerificationKeyMismatchError",
  "UnresolvedTransactionError",
  // Authored by describeOutcome, which interpolates only XDR enum discriminant
  // names and a hash we computed ourselves. Never an RPC-authored string.
  "SubmitOutcomeError",
  // NOT LedgerEntryMismatchError. It was deliberately off this list and
  // balances.ts still documents why: two of its messages interpolate an
  // address decoded from the RPC's OWN response, so allowlisting it lets an
  // RPC-chosen value reach the screen. The user gets the generic message,
  // because "your RPC is lying about which account it answered for" is not
  // something they can act on. What matters is that no number is rendered.
  //
  // LedgerReadError is different and stays: its messages are wholly authored
  // here and interpolate nothing from the wire.
  "LedgerReadError",
  // Authored here, interpolating nothing from the wire. It tells a user the
  // wallet found transfers that do not add up to what the contract holds,
  // which is the one thing they can act on.
  "InboundCreditError",
  "WalletExistsError",
  "StaleHandleError",
  "MemoTooLongError",
  "InvalidAmountError",
  "InvalidAddressKindError",
  "RecoveryUnavailableError",
  "RecoveryMismatchError",
  "OriginRefusedError",
  // Testnet funding. Its messages are wholly authored here and interpolate
  // nothing from the wire; the address is our own session's, never a wire value.
  "FriendbotError",
]);

/**
 * Messages we author ourselves and vet, matched exactly.
 *
 * "wallet is locked" and "no wallet to unlock" are deliberately NOT here. They
 * are state assertions, not sentences: the popup already routes to the lock
 * screen off `status.locked`, and a lock screen says the same thing with a
 * password field under it.
 */
const SAFE_MESSAGES = new Set([
  // the network sheet offers Mainnet, and this build refuses it. without this
  // line the refusal fell through to the generic branch, which says nothing at
  // all about a refusal that is a permanent property of the build.
  "Pocket is testnet-only in this build.",
]);

export function describeError(e: unknown): string {
  if (e instanceof WrongPasswordError) return "Wrong password.";
  if (e instanceof InvalidAddressError) {
    return e.reason === "checksum"
      ? "That address has a bad checksum. It may have been mistyped or altered in transit."
      : "That does not look like a Stellar address.";
  }
  if (e instanceof Error) {
    if (SAFE_ERRORS.has(e.name)) return e.message;
    if (SAFE_MESSAGES.has(e.message)) return e.message;
    // No shape heuristic here, deliberately. A rule like "starts with a capital
    // and ends with a stop" is trivially satisfied by an RPC-authored or
    // attacker-influenced string, which is precisely what the allowlist exists
    // to keep out. An error that should reach a user gets a name on the list.
    return "Something went wrong. Try again.";
  }
  return "Something went wrong.";
}
