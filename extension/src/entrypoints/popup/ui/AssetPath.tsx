// a swap route as a breadcrumb of asset chips, not raw CODE:ISSUER text.
//
// identity is the ISSUER, never the code, so a verified hop wears its real logo and an
// unknown one falls to a monogram (the same "we ship no logo for this issuer" signal
// the asset list draws), and the full, UNTRUNCATED CODE:ISSUER of every hop is one tap
// away in the tip, so a careful user can check the route did not slip through a
// look-alike asset. reusable: a chain-to-chain path could render through this too.
import { Fragment } from "react";
import { AssetLogo } from "./AssetIcon";
import { tokenIconFile } from "./tokenIcons";
import { InfoTip } from "./Tooltip";
import { fonts, radius, space, text, type Theme } from "./theme";

/** a canonical id ("native" | "CODE:ISSUER") to what a chip needs. "native" is XLM,
 *  never the raw word; a file is present ONLY for a verified issuer (tokenIconFile
 *  holds curated issuers), so `file == null` IS the "unknown issuer" signal. */
function resolve(id: string): { code: string; issuer?: string; file: string | null } {
  if (id === "native") return { code: "XLM", file: tokenIconFile("native") };
  const i = id.indexOf(":");
  const code = i > 0 ? id.slice(0, i) : id;
  const issuer = i > 0 ? id.slice(i + 1) : undefined;
  return { code, issuer, file: tokenIconFile(id) };
}

export function AssetPath({ t, route }: { t: Theme; route: string[] }) {
  const hops = route.map(resolve);
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexWrap: "wrap",
        gap: 6,
        marginTop: space.sm,
      }}
    >
      {hops.map((h, i) => (
        <Fragment key={i}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 5,
              background: t.field,
              borderRadius: radius.pill,
              padding: "3px 9px 3px 4px",
              minWidth: 0,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 18,
                height: 18,
                borderRadius: "50%",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                flex: "0 0 auto",
                background: h.file ? undefined : t.accentSoft,
                color: t.accentOnSoft,
              }}
            >
              {h.file ? (
                <AssetLogo file={h.file} size="fill" />
              ) : (
                <span style={{ ...text.caption, fontSize: 10, fontWeight: 700 }}>
                  {h.code.slice(0, 1)}
                </span>
              )}
            </span>
            <span style={{ ...text.caption, fontWeight: 600, color: t.text }}>{h.code}</span>
          </span>
          {i < hops.length - 1 && (
            <span aria-hidden style={{ ...text.caption, color: t.faint, lineHeight: 1 }}>
              →
            </span>
          )}
        </Fragment>
      ))}
      <InfoTip t={t} label="Swap route" size={16}>
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          {hops.map((h, i) => (
            <div key={i}>
              <span style={{ fontWeight: 700 }}>{h.code}</span>
              {h.issuer && (
                <div
                  style={{
                    ...text.caption,
                    fontFamily: fonts.mono,
                    fontSize: 11,
                    marginTop: 2,
                    overflowWrap: "anywhere",
                  }}
                >
                  {h.issuer}
                </div>
              )}
            </div>
          ))}
        </div>
      </InfoTip>
    </div>
  );
}
