// the dollar formatters.
//
// a fiat readout was copy-pasted per screen (Home, the asset detail sheet, the
// amount composers) and had already drifted in its sub-dollar precision, so the
// same figure printed differently in two places. this is the single source the
// screens import, the way copy.ts centralises shared sentences.
//
// three jobs, three functions, one rounding rule each so none can disagree:
//   usd(v)          a dollar VALUE (a holding's worth, an entered amount's worth)
//   usdOf(amt, px)  the same value from an amount and a price, or null with none
//   price(v)        a per-UNIT market price, which needs more places than a total
//   compactUsd(v)   a volume, large enough to abbreviate and drop the cents

/**
 * a dollar value, formatted the way money is read rather than the way a float
 * prints. sub-dollar amounts keep four places, because a testnet wallet holding
 * a few XLM rounds to "$0.00" at two, and a balance that reads as nothing when
 * it is not is the same class of lie as a fabricated curve.
 */
export function usd(v: number): string {
  const places = Math.abs(v) >= 1 || v === 0 ? 2 : 4;
  return `$${v.toFixed(places)}`;
}

/**
 * a dollar value from an amount and a price, or `null` when there is no price.
 *
 * `null` is a real answer, not zero: the wallet cannot source a dollar it has no
 * price for, so it stays in its own unit rather than fabricating "$0.00". the
 * amount is accepted as a string because that is how amounts cross the wire, as
 * decimal strings, never floats; it is parsed here only to be multiplied for a
 * display figure, and the string is what is actually transacted.
 */
export function usdOf(amount: string | number, price: number | null): string | null {
  if (price === null) return null;
  const n = typeof amount === "string" ? Number(amount) : amount;
  if (!Number.isFinite(n)) return null;
  return usd(n * price);
}

/**
 * a per-unit market price. a cheap asset's unit price needs more precision than
 * a holding's total, so this keeps six places below $1 where `usd` keeps four.
 */
export function price(v: number): string {
  const places = Math.abs(v) >= 1 || v === 0 ? 2 : 6;
  return `$${v.toFixed(places)}`;
}

/** a volume, which is large and does not need cents. */
export function compactUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}
