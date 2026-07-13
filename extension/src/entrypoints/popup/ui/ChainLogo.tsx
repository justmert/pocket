// Chain logos for the CCTP flows (send to / receive from a chain).
//
// A layered resolver keyed by CCTP domain, mirroring AssetIcon's file-or-monogram
// pattern:
//
//   1. A PACKAGED svg at public/chains/<slug>.svg. MV3's CSP forbids remote assets
//      (and a fetched logo on a wallet screen would leak usage), so every logo ships
//      inside the extension. Drop an official brand svg in for any chain and it wins
//      automatically, with no code change: that file is the extension point.
//
//   2. A brand-tinted monogram disc for a chain that has no packaged file yet, so an
//      unlisted or not-yet-drawn chain still gets a clean, intentional mark rather
//      than the one generic globe every chain used to share.
import { fonts } from "./theme";
import { cctpDomainName } from "../../../core/integrations/cctp";

/** CCTP domain -> packaged svg slug (public/chains/<slug>.svg). */
const CHAIN_LOGO_SLUG: Record<number, string> = {
  0: "ethereum",
  1: "avalanche",
  2: "optimism",
  5: "solana",
  6: "base",
  7: "polygon",
  17: "bnb",
};

/** CCTP domain -> brand colour, for the monogram fallback disc. */
const CHAIN_BRAND: Record<number, string> = {
  0: "#627EEA",
  1: "#E84142",
  2: "#FF0420",
  3: "#2D6CDF",
  5: "#14F195",
  6: "#0052FF",
  7: "#8247E5",
  10: "#FF007A",
  11: "#121826",
  16: "#9E1F19",
  17: "#F3BA2F",
  27: "#111827",
};

export function ChainLogo({ domain, size = 34 }: { domain: number; size?: number }) {
  const slug = CHAIN_LOGO_SLUG[domain];
  if (slug) {
    return (
      <img
        src={chrome.runtime.getURL(`chains/${slug}.svg`)}
        alt=""
        aria-hidden
        style={{ display: "block", width: size, height: size, borderRadius: "50%" }}
      />
    );
  }
  // the packaged-file tier had nothing for this domain: a brand-tinted disc with the
  // chain's initial, the AssetMark equivalent for a chain.
  const color = CHAIN_BRAND[domain] ?? "#64748b";
  const letter = cctpDomainName(domain).slice(0, 1).toUpperCase();
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        color: "#fff",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: fonts.display,
        fontWeight: 700,
        fontSize: Math.round(size * 0.42),
        lineHeight: 1,
      }}
    >
      {letter}
    </span>
  );
}
