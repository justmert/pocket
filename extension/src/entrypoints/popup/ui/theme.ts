// design tokens.
//
// one accent per pocket. yellow is the public pocket, lilac is the private one,
// and choosing a pocket flips the whole surface with it: light for public, dark
// for private. the colour is therefore never decoration, it always says which
// pocket you are looking at.

export type Pocket = "public" | "private";

export const accent = {
  public: "#FED924",
  private: "#B8ADE8",
} as const;

/** type scale. every size in the ui comes from here. */
export const fontSizes = {
  micro: 10,
  caption: 12,
  small: 14,
  body: 16,
  heading: 18,
  large: 20,
  title: 24,
  display: 34,
  hero: 42,
} as const;

/**
 * text roles. each carries size and weight together so the same kind of text
 * matches everywhere without anyone picking a weight by hand.
 */
// every prose role can break inside a word. chrome zooms to 500%, which leaves
// the popup 160px wide, and a title that refuses to break is a title that is
// simply cut off with nothing to scroll to.
const BREAKS = { overflowWrap: "anywhere" } as const;

export const text = {
  hero: { fontSize: fontSizes.hero, fontWeight: 800, letterSpacing: "-0.035em" },
  display: { fontSize: fontSizes.display, fontWeight: 800, letterSpacing: "-0.03em" },
  screenTitle: { fontSize: fontSizes.title, fontWeight: 800, letterSpacing: "-0.02em", ...BREAKS },
  heading: { fontSize: fontSizes.heading, fontWeight: 800, letterSpacing: "-0.01em", ...BREAKS },
  overline: { fontSize: fontSizes.caption, fontWeight: 800, letterSpacing: "0.08em", ...BREAKS },
  rowTitle: { fontSize: fontSizes.body, fontWeight: 700, ...BREAKS },
  rowSub: { fontSize: fontSizes.small, fontWeight: 600, ...BREAKS },
  button: { fontSize: fontSizes.body, fontWeight: 800, ...BREAKS },
  value: { fontSize: fontSizes.body, fontWeight: 700, fontVariantNumeric: "tabular-nums", ...BREAKS },
  chip: { fontSize: fontSizes.small, fontWeight: 700, ...BREAKS },
  label: { fontSize: fontSizes.small, fontWeight: 700, ...BREAKS },
  input: { fontSize: fontSizes.body, fontWeight: 600 },
  body: { fontSize: fontSizes.small, fontWeight: 600, ...BREAKS },
  caption: { fontSize: fontSizes.caption, fontWeight: 600, ...BREAKS },
} as const;

export const space = {
  xs: 6,
  sm: 10,
  md: 14,
  gutter: 18,
  lg: 22,
  xl: 30,
} as const;

export const radius = {
  sm: 10,
  md: 14,
  lg: 18,
  xl: 24,
  sheet: 28,
  pill: 999,
} as const;

/**
 * motion, tokenized like colour.
 *
 * two easings and no more: one for anything arriving or settling, one for
 * anything leaving. every duration below has a stated job, and nothing in the
 * product animates on a value that is not here. the stylesheet reads these
 * through custom properties rather than repeating them, because a duration
 * declared in two places is a duration that will disagree with itself.
 */
export const motion = {
  /** anything arriving or settling. */
  enter: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  /** anything leaving. */
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  /** the pocket wash, and nothing else. the one expressive moment. */
  wash: "cubic-bezier(0.33, 0, 0.2, 1)",
  /** a number that eases like a panel reads as a panel. */
  odometer: "cubic-bezier(0.2, 0.85, 0.25, 1)",

  /** did my input register. */
  instant: "140ms",
  /** a layer arrived or left. */
  quick: "200ms",
  /** a screen settles into place. */
  page: "260ms",
  /** a screen leaves. */
  pageOut: "200ms",
  /** a sheet comes up. */
  sheet: "280ms",
  /** a sheet goes away. */
  sheetOut: "240ms",
  /** a list arrives, plus `ROW_STAGGER_MS` per row. */
  settle: "320ms",
  /** a number moves rather than jumps. */
  roll: "560ms",
  /** crossing between the two pockets. */
  pocket: "620ms",
  /** still working. */
  ambient: "1300ms",
  /** one turn of a spinner. */
  spin: "700ms",
  /** the same spinner for someone who asked for less motion. */
  spinCalm: "1600ms",
  /** one pass of a skeleton's shimmer, calmed to match. */
  shimmerCalm: "2400ms",
  /** this is not a number yet. */
  ambientSlow: "1500ms",
} as const;

/** the stagger between one row and the next. */
export const ROW_STAGGER_MS = 45;

export const fonts = {
  sans: "'Plus Jakarta Sans Variable', system-ui, sans-serif",
  mono: "'Spline Sans Mono Variable', ui-monospace, monospace",
} as const;

/**
 * the popup is a fixed frame. height is what chrome allows a toolbar popup at
 * 100% zoom; the frame never asks for a size in viewport units because a popup
 * is measured from its own content, so `vh` would resolve against a viewport a
 * few pixels tall on the first layout and crush it.
 */
export const FRAME = { width: 384, height: 600 } as const;

export interface Theme {
  pocket: Pocket;
  dark: boolean;
  accent: string;
  /** ink drawn on top of the accent. both accents are light, so it is near-black. */
  onAccent: string;
  /** accent at low opacity, for icon circles, active tiles and soft cards. */
  accentSoft: string;
  accentLine: string;
  /** the fill under a primary button. */
  accentFill: string;
  bg: string;
  /** the page backdrop, including the glow the dark pocket carries. */
  canvas: string;
  surface: string;
  text: string;
  sub: string;
  faint: string;
  line: string;
  field: string;
  /** floating bar and sheet fills, sitting over blurred content. */
  bar: string;
  sheet: string;
  danger: string;
  onDanger: string;
  dangerSoft: string;
  positive: string;
  positiveSoft: string;
  /** an amount that is public or is about to become public. never decorative. */
  exposed: string;
  exposedSoft: string;
  /**
   * the focus indicator.
   *
   * NOT the accent. yellow on a near-white surface cannot reach the 3:1 a focus
   * indicator needs, and every control here is built with `all: unset`, so the
   * ring is the only focus signal there is.
   */
  ring: string;
}

export function theme(pocket: Pocket): Theme {
  return pocket === "private" ? PRIVATE : PUBLIC;
}

// contrast was measured against the surface each colour is actually drawn on,
// not chosen by eye. body text and anything carrying meaning clears 4.5:1.
const PUBLIC: Theme = {
  pocket: "public",
  dark: false,
  accent: accent.public,
  onAccent: "#14151A",
  accentSoft: "rgba(214,175,0,0.13)",
  accentLine: "rgba(214,175,0,0.26)",
  accentFill: "linear-gradient(180deg,#FFE45C,#F5C400)",
  bg: "#FAFAF7",
  canvas: "linear-gradient(180deg,#FFFDF2 0%,#FAFAF7 34%)",
  surface: "#FFFFFF",
  text: "#14151A",
  sub: "#57534E",
  faint: "#6F6C66",
  line: "#E8E6E1",
  field: "#F4F3F0",
  bar: "rgba(255,255,255,0.86)",
  sheet: "#FFFFFF",
  danger: "#B3261E",
  onDanger: "#FFFFFF",
  dangerSoft: "rgba(179,38,30,0.10)",
  positive: "#17693F",
  positiveSoft: "rgba(23,105,63,0.10)",
  exposed: "#8A5000",
  exposedSoft: "rgba(160,94,0,0.11)",
  ring: "#14151A",
};

const PRIVATE: Theme = {
  pocket: "private",
  dark: true,
  accent: accent.private,
  onAccent: "#14151A",
  accentSoft: "rgba(184,173,232,0.14)",
  accentLine: "rgba(184,173,232,0.24)",
  accentFill: "linear-gradient(180deg,#C9BFF0,#A493DD)",
  bg: "#0B0A14",
  canvas: "radial-gradient(130% 52% at 50% 0%, #1B1733, #0B0A14 66%)",
  surface: "#16141F",
  text: "#F2F1EE",
  sub: "#A9A7A1",
  faint: "#8A8781",
  line: "#2A2733",
  field: "rgba(255,255,255,0.05)",
  bar: "rgba(28,25,42,0.82)",
  sheet: "#16141F",
  danger: "#E8756B",
  onDanger: "#14151A",
  dangerSoft: "rgba(232,117,107,0.14)",
  positive: "#5FD39A",
  positiveSoft: "rgba(95,211,154,0.13)",
  exposed: "#F0B45C",
  exposedSoft: "rgba(240,180,92,0.14)",
  ring: "#B8ADE8",
};
