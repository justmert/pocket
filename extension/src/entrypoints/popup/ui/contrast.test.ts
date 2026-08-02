// Text on the primary button has to be readable.
//
// WCAG AA is 4.5:1 for body text and 3:1 for text at 18.66px bold or larger.
// The primary button's label is 16px semibold, so it is body text and 4.5:1 is
// the bar. Measured over the shipped theme objects rather than over a
// screenshot: these are the exact values the components paint with.
//
// This exists because the pair was measured at 2.30:1 public and 3.46:1
// private, on the one control every flow ends with.
import { describe, it, expect } from "vitest";
import { theme } from "./theme";

/** sRGB relative luminance, per WCAG 2.x. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const parts = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const [r, g, b] = parts.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG contrast ratio, higher is better. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

const AA_BODY = 4.5;

describe("the primary button", () => {
  for (const pocket of ["public", "private"] as const) {
    it(`is legible in the ${pocket} pocket`, () => {
      const t = theme(pocket);
      const ratio = contrast(t.onAccent, t.accentFill);
      expect(
        ratio,
        `${t.onAccent} on ${t.accentFill} is ${ratio.toFixed(2)}:1, below AA's ${AA_BODY}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    });

    it(`has a legible soft variant in the ${pocket} pocket`, () => {
      // The quiet/soft button and every accent chip use this pair.
      const t = theme(pocket);
      const ratio = contrast(t.accentOnSoft, t.accentSoft);
      expect(
        ratio,
        `${t.accentOnSoft} on ${t.accentSoft} is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(AA_BODY);
    });

    it(`keeps body text legible on the surface in the ${pocket} pocket`, () => {
      const t = theme(pocket);
      expect(contrast(t.text, t.bg)).toBeGreaterThanOrEqual(AA_BODY);
      expect(contrast(t.sub, t.bg)).toBeGreaterThanOrEqual(AA_BODY);
    });
  }

  it("computes a ratio the same way WCAG does", () => {
    // The control: black on white is exactly 21, white on white is 1. Without
    // it a broken formula would report everything as passing.
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  });
});
