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
]);

export function isUserActivity(type: string): boolean {
  return ACTIVITY.has(type);
}

/**
 * Map an error to a message a user can act on. Never leaks witness material:
 * amounts, openings and blinding factors must not reach a log or a UI string.
 */
export function describeError(e: unknown): string {
  if (e instanceof WrongPasswordError) return "Wrong password.";
  if (e instanceof InvalidAddressError) {
    return e.reason === "checksum"
      ? "That address has a bad checksum. It may have been mistyped or altered in transit."
      : "That does not look like a Stellar address.";
  }
  if (e instanceof Error) return e.message;
  return "Something went wrong.";
}
