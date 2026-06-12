// Request router. One place where a message becomes a controller call, so the
// error taxonomy and the locked check live in exactly one spot.
import type { WalletController } from "./controller";
import type { WalletRequest } from "./messages";
import { WrongPasswordError } from "./vault/vault";
import { InvalidAddressError } from "./chain/address";

/**
 * Operations permitted while locked.
 *
 * `import` is NOT here: it writes the vault, and allowing it without the
 * current password means any stray message can replace a funded wallet's seed.
 * `reset` is not here either, for the same reason.
 */
const ALLOWED_WHILE_LOCKED = new Set(["status", "create", "unlock", "lock"]);

export async function dispatch(c: WalletController, msg: WalletRequest): Promise<unknown> {
  switch (msg.type) {
    case "status":
      return c.status();
    case "create":
      return c.create(msg.password);
    case "import":
      return c.import(msg.password, msg.mnemonic);
    case "unlock":
      return c.unlock(msg.password);
    case "lock":
      c.lock();
      return c.status();
    case "setNetwork":
      return c.setNetwork(msg.network);
    case "balances":
      return c.balances();
    case "buildPayment":
      return c.buildPayment(msg);
    case "confirmPayment":
      return c.confirmPayment(msg.handle);
    case "reset":
      return c.reset(msg.password);
    case "privatePocket":
      return c.privatePocket();
    case "buildPrivateOp":
      return c.buildPrivateOp(msg.op);
    case "confirmPrivateOp":
      return c.confirmPrivateOp(msg.handle);
    case "inFlight":
      return c.inFlight();
    case "reconcileInFlight":
      return c.reconcileInFlight();
    case "recoverFromMnemonic":
      return c.recoverFromMnemonic(msg.mnemonic, msg.password);
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
  "WrongPasswordError",
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
  "VerificationKeyMismatchError",
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
