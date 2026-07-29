// The same chip drew two different measurements identically.
//
// On Home it is the PORTFOLIO's value over the selected range, which counts
// money arriving and leaving. On the asset sheet it is that asset's own 24h
// market price change. Measured live on the same account: Home's chip read
// "▲ 105.05%" on a day the market moved +3.14%, and stayed green through a week
// the market fell 2.52%. Both figures are correct; neither said which one it
// was, and an arrow with a percentage beside a balance reads as the market to
// anyone who has seen a price chart.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ChangeChip } from "./Chart";
import { theme } from "./theme";

const t = theme("public");

describe("the change chip", () => {
  it("says what moved", () => {
    const html = renderToStaticMarkup(<ChangeChip t={t} pct={105.05} label="Value" />);
    expect(html).toContain("Value");
    expect(html).toContain("105.05%");
  });

  it("spells the measurement out for a screen reader", () => {
    // The visible label is two characters; the whole sentence belongs where a
    // screen reader and a hover can reach it.
    const html = renderToStaticMarkup(
      <ChangeChip t={t} pct={-2.52} label="Value" describedAs="Value change over 1W" />,
    );
    expect(html).toMatch(/aria-label="Value change over 1W: down 2\.52 percent"/);
  });

  it("still shows nothing when there is no figure", () => {
    // Null is not zero: a range that starts before the wallet was funded has no
    // percentage, and "0.00%" would claim it held steady at nothing.
    expect(renderToStaticMarkup(<ChangeChip t={t} pct={null} label="Value" />)).toBe("");
  });

  it("is labelled at both call sites, which is the whole point", () => {
    // An unlabelled chip is the defect, so a new call site without a label is
    // the regression. A source read: rendering Home needs the whole provider.
    for (const rel of ["./screens/Home.tsx", "./sheets/AssetDetailSheet.tsx"]) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      for (const m of src.matchAll(/<ChangeChip[\s\S]{0,400}?\/>/g)) {
        expect(m[0], `an unlabelled ChangeChip in ${rel}`).toMatch(/label=/);
        expect(m[0], `a ChangeChip with no description in ${rel}`).toMatch(/describedAs=/);
      }
    }
  });
});
