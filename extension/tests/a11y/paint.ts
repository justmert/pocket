// Contrast, measured through gradients as well as flat fills.
//
// WHY THIS EXISTS, AND WHERE IT BELONGS. `tests/support/a11y.ts` already has a
// contrast sweep, and it is the right place for this. It composites
// `backgroundColor` down the ancestor chain and nothing else, which was correct
// for the old UI and is not for this one: the rebuild paints every primary
// button with `background: linear-gradient(...)`, and the `background`
// shorthand resets `background-color` to `transparent`. So the sweep looks
// straight THROUGH a filled button to whatever is behind it.
//
// That is not a small inaccuracy. Measured on the private pocket's send sheet,
// it reported the "Review" button's near-black `#14151A` label as sitting on
// the sheet's near-black `#16141F` at 1:1, a total failure -- while the label is
// actually on a lilac fill at 6.8:1. Six of the twelve private-pocket sweeps
// failed on that alone. A checker that invents failures is worse than none: it
// gets switched off.
//
// `tests/support/**` is T1's, and this pass is not allowed to edit it, so the
// gradient-aware version lives here and the two directories that need it import
// it. It should be folded back into `support/a11y.ts` and deleted.
//
// The rule: a gradient is opaque wherever it is drawn, so it REPLACES whatever
// is beneath it, and a ratio is taken against every one of its colour stops.
// The lowest of those is what gets reported, because a label has to be readable
// over the whole sweep of the fill and not only over its friendliest end.
import type { Page } from "@playwright/test";
import { AA, type ContrastViolation } from "../support/a11y";

export async function contrastFailures(page: Page): Promise<ContrastViolation[]> {
  return page.evaluate(
    (thresholds: { text: number; largeText: number }): ContrastViolation[] => {
      type RGBA = { r: number; g: number; b: number; a: number };
      const parse = (c: string): RGBA => {
        const n = (c.match(/[\d.]+/g) ?? ["0", "0", "0", "0"]).map(Number);
        return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n[3] ?? 1 };
      };
      const over = (fg: RGBA, bg: RGBA): RGBA => ({
        r: fg.r * fg.a + bg.r * (1 - fg.a),
        g: fg.g * fg.a + bg.g * (1 - fg.a),
        b: fg.b * fg.a + bg.b * (1 - fg.a),
        a: 1,
      });
      const lum = (c: RGBA) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
      };
      const ratioOf = (a: RGBA, b: RGBA) => {
        const [l1, l2] = [lum(a), lum(b)];
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const round = (c: RGBA) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

      /** Every colour stop in a `background-image`, in source order. */
      const stopsOf = (image: string): RGBA[] => (image.match(/rgba?\([^)]*\)/g) ?? []).map(parse);

      const out: ContrastViolation[] = [];
      for (const el of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
        // Only elements that render text of their own. Without the direct-child
        // check every ancestor is measured too, and a container reports its
        // descendants' text against its own colour.
        const own = Array.from(el.childNodes)
          .filter((n) => n.nodeType === Node.TEXT_NODE)
          .map((n) => n.textContent ?? "")
          .join("")
          .trim();
        if (!own) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const style = getComputedStyle(el);
        if (style.visibility === "hidden" || style.display === "none" || style.opacity === "0") {
          continue;
        }
        // WCAG 1.4.3 exempts "inactive user interface components" outright, so
        // a disabled button's label is not a contrast failure however grey it
        // is. Counting it would drown the real violations in noise and make
        // the sweep easy to dismiss. The disabled style is held to the
        // project's own stricter bar in `ui-states/interaction-states.spec.ts`.
        if (el.closest("[disabled], [aria-disabled='true']")) continue;

        // Candidate backgrounds, root downwards. A flat colour composites onto
        // what is already there; a gradient replaces the candidate list with
        // its own stops, each composited over what was beneath in case the
        // stop is translucent (`transparent` in a fade is exactly that).
        let candidates: RGBA[] = [{ r: 255, g: 255, b: 255, a: 1 }];
        const chain: Element[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
        for (const node of chain.reverse()) {
          const s = getComputedStyle(node);
          const flat = parse(s.backgroundColor);
          if (flat.a > 0) candidates = candidates.map((c) => over(flat, c));
          const stops = stopsOf(s.backgroundImage);
          if (stops.length) {
            candidates = stops.flatMap((stop) => candidates.map((c) => over(stop, c)));
          }
        }

        const fg = parse(style.color);
        // The worst background the text is drawn over is the one that decides.
        let worst = candidates[0]!;
        let ratio = ratioOf(over(fg, worst), worst);
        for (const bg of candidates) {
          const r = ratioOf(over(fg, bg), bg);
          if (r < ratio) {
            ratio = r;
            worst = bg;
          }
        }

        const fontSizePx = parseFloat(style.fontSize);
        const fontWeight = Number(style.fontWeight) || 400;
        const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
        const required = large ? thresholds.largeText : thresholds.text;
        if (ratio + 0.005 < required) {
          out.push({
            text: own.slice(0, 60),
            ratio: Math.round(ratio * 100) / 100,
            required,
            color: round(over(fg, worst)),
            background: round(worst),
            fontSizePx,
            fontWeight,
          });
        }
      }
      return out;
    },
    { text: AA.text, largeText: AA.largeText },
  );
}
