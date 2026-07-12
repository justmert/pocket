// The token-logo lookup, kept pure (no JSX) so the anti-spoof rule is unit
// testable without a renderer. AssetIcon.tsx draws the result.
//
// Identity is the ISSUER, never the code. The map is keyed on the canonical
// asset id ("native" | "CODE:ISSUER") exactly as chain/balances.ts mints it, and
// holds only verified issuers from curated SEP-42 lists, so a "USDC" from any
// other issuer misses and the caller draws the on-device monogram rather than
// Circle's logo.
import { TOKEN_ICONS } from "./tokenIcons.generated";

export { TOKEN_ICONS };

/**
 * The packaged filename for an asset id, or null when we ship no logo for it.
 * A miss is the correct, safe answer for an unknown or unverified asset.
 */
export function tokenIconFile(id: string): string | null {
  return TOKEN_ICONS[id] ?? null;
}
