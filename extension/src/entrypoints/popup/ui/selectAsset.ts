// Which private pocket the screens are talking about.
//
// The rule was `find(p => p.token === selected) ?? privAssets[0]`, and the
// fallback is the defect: when the selected asset is not in the loaded list it
// silently substitutes a DIFFERENT ONE. The screens then show that asset's
// balance, its state and its actions under the selection the user made, so a
// wallet with USDC chosen could be looking at XLM's numbers.
//
// It is reachable without anything going wrong on chain. `loadPrivate` falls
// back to the SINGULAR `privatePocket` read when the plural one fails, which
// returns the primary asset alone, so the list legitimately arrives holding one
// entry while the selection names another.
//
// The fallback was not pointless, though, which is why it cannot simply be
// deleted: that singular read carries NO `token` field, and matching on token
// would find nothing at all. So the rule keeps the fallback for exactly that
// shape and refuses it otherwise.
import type { PrivatePocket } from "../../../core/messages";

/**
 * The pocket for `selected`, or null when the answer is not known.
 *
 * Null rather than a substitute. Every caller already handles a null pocket,
 * because the list is null before it loads; none of them can detect that they
 * were handed the wrong asset.
 */
export function selectPrivateAsset(
  assets: PrivatePocket[] | null,
  selected: string | null,
): PrivatePocket | null {
  if (!assets || assets.length === 0) return null;

  const exact = assets.find((p) => p.token === selected);
  if (exact) return exact;

  // The legacy single-pocket shape: one entry, no token to match on. This is
  // the case the fallback was written for, and the only one it is right for.
  const only = assets.length === 1 ? assets[0] : undefined;
  if (only && only.token === undefined) return only;

  // Nothing selected yet: the first pocket is the wallet's own default, not a
  // substitution for something the user asked for.
  if (selected === null || selected === undefined) return assets[0] ?? null;

  // Selected, present in neither: say so.
  return null;
}
