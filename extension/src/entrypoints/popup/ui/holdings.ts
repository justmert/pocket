// Whether this account holds an asset, as a question with FOUR answers.
//
// Named `holdings` rather than `held` because `Held.tsx` beside it is a
// component about value you own that is not spendable yet, and on a
// case-insensitive filesystem the two filenames are the same file.
//
// Every screen that needs one asset out of the balance list wrote the same
// line, `const x = (w.balances ?? []).find(...)`, and then asserted a negative
// from the miss: "You do not hold any public USDC to bridge", plus a
// permanently disabled Continue. `?? []` collapses three different facts into
// the same empty array: the balances have not loaded yet, the read failed, and
// the account genuinely holds none of it. Only the last is about the user, and
// it is the only one the screen said out loud.
//
// `WalletProvider.tsx` states the rule this breaks, four lines above where it
// sets `balanceError`: a zero would be a lie. The same argument applies to a
// negative, and more strongly, because a negative comes with instructions
// ("Receive or swap into USDC first") that are wasted work if it is wrong.
import type { PublicBalance } from "../../../core/messages";

export type Holding =
  /** Not read yet. Show a placeholder, assert nothing. */
  | { kind: "loading" }
  /** The read failed. Say so, in the worker's own words. */
  | { kind: "unreadable"; message: string }
  /** Read, and the account really does not hold it. */
  | { kind: "absent" }
  | { kind: "held"; balance: PublicBalance };

export function findHeld(
  balances: PublicBalance[] | null,
  balanceError: string | null,
  match: (b: PublicBalance) => boolean,
): Holding {
  // The error first. A stale list beside a failed refresh is still a list we
  // cannot vouch for, and the screens using this are about to spend from it.
  if (balanceError && !balances) return { kind: "unreadable", message: balanceError };
  if (!balances) return { kind: "loading" };
  const balance = balances.find(match);
  return balance ? { kind: "held", balance } : { kind: "absent" };
}

/** The spendable figure, or null whenever there is no figure to be sure of. */
export function holdingAmount(h: Holding): string | null {
  return h.kind === "held" ? h.balance.amount : null;
}
