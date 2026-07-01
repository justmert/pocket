// Measurements taken from the RENDERED page.
//
// Written this way because of the trap the orchestrator named: a visual
// snapshot is the easiest kind of test to make unfalsifiable. Playwright writes
// the baseline on first run and compares against it forever, so the expected
// value is produced by the same system that produces the actual value — the
// exact shape of the vacuous assertion that survived T1's whole mutation pass.
//
// So the primary evidence here is NUMBERS, derived from `getComputedStyle` and
// from geometry, checked against thresholds that come from WCAG or from the
// project's own design tokens. A snapshot can supplement that. It cannot
// replace it.
import type { Locator, Page } from "@playwright/test";

export interface Measured {
  /** Foreground, composited over its effective background. `rgb(r, g, b)`. */
  color: string;
  /** Effective background after compositing every translucent ancestor. */
  background: string;
  /** WCAG 2.x contrast ratio, 1..21. */
  ratio: number;
  fontSizePx: number;
  fontWeight: number;
  /** WCAG "large text": >=18.66px bold, or >=24px at any weight. */
  isLargeText: boolean;
  width: number;
  height: number;
}

/**
 * Everything needed to judge a piece of text, measured rather than assumed.
 *
 * The compositing matters: this theme uses `rgba(255,255,255,0.05)` for field
 * backgrounds and 10-14% tints behind every Notice, so reading
 * `backgroundColor` off the element alone yields a transparent colour and a
 * meaningless ratio. Ancestors are composited from the root down, which is what
 * the compositor itself does.
 */
export async function measure(target: Locator): Promise<Measured> {
  return target.evaluate((el: Element): Measured => {
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

    const chain: Element[] = [];
    for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
    // Root downwards, so each translucent layer lands on what is already there.
    let bg: RGBA = { r: 255, g: 255, b: 255, a: 1 };
    for (const node of chain.reverse()) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c.a > 0) bg = over(c, bg);
    }

    const style = getComputedStyle(el);
    const fg = over(parse(style.color), bg);
    const lum = (c: RGBA) => {
      const f = (v: number) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
    };
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

    const fontSizePx = parseFloat(style.fontSize);
    const fontWeight = Number(style.fontWeight) || 400;
    const rect = (el as HTMLElement).getBoundingClientRect();
    const round = (c: RGBA) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
    return {
      color: round(fg),
      background: round(bg),
      ratio,
      fontSizePx,
      fontWeight,
      isLargeText: fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700),
      width: rect.width,
      height: rect.height,
    };
  });
}

/** Named computed style properties, as strings, straight off the element. */
export async function computed(target: Locator, props: string[]): Promise<Record<string, string>> {
  return target.evaluate((el: Element, names: string[]) => {
    const s = getComputedStyle(el);
    const out: Record<string, string> = {};
    for (const n of names) out[n] = s.getPropertyValue(n);
    return out;
  }, props);
}

/**
 * A computed length as a number.
 *
 * Throws on a missing property rather than coercing it to NaN. `parseFloat(
 * undefined)` is NaN, and every comparison against NaN is false, so a typo in a
 * property name would turn an assertion into one that cannot fail. Same family
 * as the vacuous assertions in `_test/T1.md` and `_test/T6-T7.md`.
 */
export function px(styles: Record<string, string>, name: string): number {
  const value = styles[name];
  if (value === undefined) throw new Error(`no computed value for "${name}"`);
  return parseFloat(value);
}

/** Computed style of a pseudo-element, for focus rings and the like. */
export async function computedPseudo(
  target: Locator,
  pseudo: string,
  props: string[],
): Promise<Record<string, string>> {
  return target.evaluate(
    (el: Element, arg: { pseudo: string; names: string[] }) => {
      const s = getComputedStyle(el, arg.pseudo);
      const out: Record<string, string> = {};
      for (const n of arg.names) out[n] = s.getPropertyValue(n);
      return out;
    },
    { pseudo, names: props },
  );
}

/** What the browser thinks is focused: tag, accessible-ish name, and box. */
export async function focused(page: Page): Promise<{
  tag: string;
  text: string;
  type: string;
  width: number;
  height: number;
}> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) {
      return { tag: "BODY", text: "", type: "", width: 0, height: 0 };
    }
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      text: (el.getAttribute("aria-label") ?? el.innerText ?? "").trim().slice(0, 60),
      type: el.getAttribute("type") ?? "",
      width: rect.width,
      height: rect.height,
    };
  });
}

/**
 * Tab until the focused element's text matches, then stop. Returns false if it
 * was never reached, which is itself the finding: a control a keyboard user
 * cannot get to does not exist for them.
 *
 * Deliberately does NOT click. A flow driven with `.click()` proves the handler
 * works; only a flow driven with Tab and Enter proves the flow is completable
 * without a pointer.
 */
export async function tabTo(page: Page, text: string | RegExp, max = 20): Promise<boolean> {
  const matches = (s: string) => (typeof text === "string" ? s === text : text.test(s));
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    if (matches((await focused(page)).text)) return true;
  }
  return false;
}

/** Tab through the page and record what receives focus, in order. */
export async function tabOrder(page: Page, steps: number): Promise<string[]> {
  const seen: string[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press("Tab");
    const f = await focused(page);
    seen.push(f.tag === "BODY" ? "(none)" : `${f.tag}:${f.text || f.type}`);
  }
  return seen;
}

/**
 * Does the document scroll sideways?
 *
 * The frame is a fixed 384x600 with `overflow: hidden`, so horizontal overflow
 * does not produce a scrollbar -- it CLIPS, silently. Comparing scrollWidth
 * against clientWidth on the scrolling column is what catches it.
 */
export async function overflowsHorizontally(page: Page): Promise<boolean> {
  return (await horizontalOverflow(page)).length > 0;
}

/** The same question, answered with the offending elements so it is actionable. */
export async function horizontalOverflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const nodes = [document.documentElement, document.body, ...document.querySelectorAll("div")];
    return nodes
      .filter((n) => n.scrollWidth > n.clientWidth + 1)
      .map(
        (n) =>
          `<${n.tagName.toLowerCase()}> needs ${n.scrollWidth}px in ${n.clientWidth}px` +
          ` — "${((n as HTMLElement).innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 40)}"`,
      );
  });
}

/** Elements whose rendered box extends below a given height, i.e. off the fold. */
export async function belowTheFold(page: Page, limit: number, selector: string): Promise<string[]> {
  return page.evaluate(
    (arg: { limit: number; selector: string }) =>
      [...document.querySelectorAll(arg.selector)]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          // Only things that are actually rendered and actually out of reach.
          return r.height > 0 && r.bottom > arg.limit;
        })
        .map((el) => (el as HTMLElement).innerText.trim().slice(0, 40) || el.tagName),
    { limit, selector },
  );
}

export interface ContrastViolation {
  text: string;
  ratio: number;
  required: number;
  color: string;
  background: string;
  fontSizePx: number;
  fontWeight: number;
}

/**
 * Every visible text node on the page, measured, with the failures returned.
 *
 * A sweep rather than a list of hand-picked selectors, because the ones a
 * person thinks to check are the ones a designer already looked at. This walks
 * whatever is actually rendered, so a screen added later is covered without
 * anybody remembering to add it.
 */
export async function contrastViolations(page: Page): Promise<ContrastViolation[]> {
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
      const round = (c: RGBA) => `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;

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
        // the sweep easy to dismiss. The measured ratios are still reported as
        // an observation in `_test/T6-T7.md`, because the project's own stated
        // intent for the disabled style is stricter than WCAG's.
        if ((el as HTMLElement).closest("[disabled], [aria-disabled='true']")) continue;

        let bg: RGBA = { r: 255, g: 255, b: 255, a: 1 };
        const chain: Element[] = [];
        for (let n: Element | null = el; n; n = n.parentElement) chain.push(n);
        for (const node of chain.reverse()) {
          const c = parse(getComputedStyle(node).backgroundColor);
          if (c.a > 0) bg = over(c, bg);
        }
        const fg = over(parse(style.color), bg);
        const l1 = lum(fg);
        const l2 = lum(bg);
        const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);

        const fontSizePx = parseFloat(style.fontSize);
        const fontWeight = Number(style.fontWeight) || 400;
        const large = fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
        const required = large ? thresholds.largeText : thresholds.text;
        if (ratio + 0.005 < required) {
          out.push({
            text: own.slice(0, 60),
            ratio: Math.round(ratio * 100) / 100,
            required,
            color: round(fg),
            background: round(bg),
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

/** WCAG 2.x AA thresholds, named so a spec reads as a requirement. */
export const AA = {
  /** Body text. */
  text: 4.5,
  /** Text >=24px, or >=18.66px bold. */
  largeText: 3,
  /** Borders, icons, focus rings: WCAG 2.1 SC 1.4.11. */
  nonText: 3,
} as const;

/** WCAG 2.2 SC 2.5.8 minimum target size. */
export const MIN_TARGET_PX = 24;
