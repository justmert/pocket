// Request router. One place where a message becomes a controller call, so the
// error taxonomy and the locked check live in exactly one spot.
import type { WalletController } from "./controller";
import type { WalletRequest } from "./messages";
import { WrongPasswordError } from "./vault/vault";
import { InvalidAddressError } from "./chain/address";

/** Operations permitted while locked. Everything else requires an unlocked vault. */
const ALLOWED_WHILE_LOCKED = new Set(["status", "create", "import", "unlock", "lock"]);

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
      return c.confirmPayment(msg.xdr);
  }
}

export function isAllowedWhileLocked(type: string): boolean {
  return ALLOWED_WHILE_LOCKED.has(type);
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
