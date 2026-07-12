// a token's brand logo, where we ship one.
//
// logos are VENDORED at build time (scripts/vendor-token-icons.mjs), never
// fetched. an <img> pulled per held asset from an issuer-controlled host would
// be a per-holding tracking pixel, which is exactly what img-src 'self' is
// pinned to prevent and what the "one network host / nothing loaded at runtime"
// claims forbid. so the src here is always a packaged file over
// chrome-extension://, and the CSP allows nothing else.
//
// identity is the ISSUER, never the code. the lookup (tokenIconFile, kept pure
// in ./tokenIcons so the anti-spoof rule is unit testable) is keyed on the
// canonical asset id ("native" | "CODE:ISSUER") exactly as chain/balances.ts
// mints it, so a "USDC" from any issuer but the verified one misses the map and
// its caller draws the on-device monogram rather than Circle's logo. icons and
// symbols are trivially spoofable; the issuer is the only real identity.
export { tokenIconFile } from "./tokenIcons";

/**
 * The vendored logo itself, contained within `size` and drawn on nothing: the
 * caller owns the container (Row's tile, or the sheet's plate), so this only
 * ever paints the artwork. `alt=""` and aria-hidden because the row's title
 * already names the asset; a second spoken "USD Coin logo" is noise.
 */
export function AssetLogo({ file, size }: { file: string; size: number | "fill" }) {
  const dim = size === "fill" ? "100%" : size;
  return (
    <img
      src={chrome.runtime.getURL(`tokens/${file}`)}
      alt=""
      aria-hidden
      style={{ display: "block", objectFit: "contain", width: dim, height: dim }}
    />
  );
}
