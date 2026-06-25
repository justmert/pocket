// Request router. One place where a message becomes a controller call, so the
// error taxonomy and the locked check live in exactly one spot.
import type { WalletController } from "./controller";
import type { PrivateOpRequest, WalletRequest } from "./messages";
import { WrongPasswordError } from "./vault/vault";
import { InvalidAddressError } from "./chain/address";

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
      c.lock();
      return c.status();
    case "setNetwork":
      return c.setNetwork(msg.network);
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
    case "privatePocket":
      return c.privatePocket();
    case "rebuildFromHistory":
      return c.rebuildFromHistory();
    case "dappSessions":
      return c.dappSessions();
    case "connectDapp":
      return c.connectDapp(str(msg.origin, "origin"));
    case "currentPhase":
      return c.currentPhase();
    case "yieldPosition":
      return c.yieldPosition();
    case "pendingDappRequest":
      return c.pendingDappRequest();
    case "resolveDappRequest":
      return c.resolveDappRequest(str(msg.id, "id"), msg.approved === true);
    case "disconnectDapp":
      return c.disconnectDapp(str(msg.origin, "origin"));
    case "buildPrivateOp":
      return c.buildPrivateOp(opRequest(msg.op));
    case "confirmPrivateOp":
      return c.confirmPrivateOp(str(msg.handle, "handle"));
    case "inFlight":
      return c.inFlight();
    case "reconcileInFlight":
      return c.reconcileInFlight();
    case "recoverFromMnemonic":
      return c.recoverFromMnemonic(str(msg.mnemonic, "mnemonic"), str(msg.password, "password"));
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
  "create",
  "import",
  // A private operation is user activity too: proving can take a moment and a
  // transfer must not be interrupted by the idle lock mid-flight.
  "buildPrivateOp",
  "confirmPrivateOp",
  "privatePocket",
  "rebuildFromHistory",
  "recoverFromMnemonic",
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
  "RecoveryUnavailableError",
  "RecoveryMismatchError",
  "OriginRefusedError",
]);

/** Messages we author ourselves and vet, matched exactly. */
const SAFE_MESSAGES = new Set([
  "wallet is locked",
  "no wallet to unlock",
  "a wallet already exists on this device",
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
    return "Something went wrong. Try again, and check your connection.";
  }
  return "Something went wrong.";
}
