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
export const text = {
  hero: { fontSize: fontSizes.hero, fontWeight: 800, letterSpacing: "-0.035em" },
  display: { fontSize: fontSizes.display, fontWeight: 800, letterSpacing: "-0.03em" },
  screenTitle: { fontSize: fontSizes.title, fontWeight: 800, letterSpacing: "-0.02em" },
  heading: { fontSize: fontSizes.heading, fontWeight: 800, letterSpacing: "-0.01em" },
  overline: { fontSize: fontSizes.caption, fontWeight: 800, letterSpacing: "0.08em" },
  rowTitle: { fontSize: fontSizes.body, fontWeight: 700 },
  rowSub: { fontSize: fontSizes.small, fontWeight: 600 },
  button: { fontSize: fontSizes.body, fontWeight: 800 },
  value: { fontSize: fontSizes.body, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  chip: { fontSize: fontSizes.small, fontWeight: 700 },
  label: { fontSize: fontSizes.small, fontWeight: 700 },
  input: { fontSize: fontSizes.body, fontWeight: 600 },
  body: { fontSize: fontSizes.small, fontWeight: 600 },
  caption: { fontSize: fontSizes.caption, fontWeight: 600 },
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
 * one easing for anything entering, one for anything leaving. durations are
 * short enough that a fast user never waits on them.
 */
export const motion = {
  enter: "cubic-bezier(0.2, 0.8, 0.2, 1)",
  exit: "cubic-bezier(0.4, 0, 1, 1)",
  press: "140ms",
  quick: "200ms",
  sheet: "280ms",
  page: "260ms",
  /** the pocket switch is the one deliberately slower moment in the product. */
  pocket: "450ms",
} as const;

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
};
