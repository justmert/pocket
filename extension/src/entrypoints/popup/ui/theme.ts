// Pocket's design tokens.
//
// Two accents, chosen by Mert: fed924 (yellow) for the light scheme, b8ade8
// (lilac) for the dark one.
//
// Light and dark are a user PREFERENCE, not a privacy signal. The reference
// wallet tied dark to "private mode", which renders the shield and unshield
// screens in the private skin at exactly the two moments the amount becomes
// public. Privacy is carried by the amount treatment instead:
//
//   plain   an ordinary public balance
//   sealed  a confidential amount, on chain only as a commitment
//   exposed an amount that is or is becoming public: shield, unshield, fees
//
// `exposed` only works as a signal if it appears nowhere else. It is not a
// decorative colour.
export type Scheme = "light" | "dark";
export type MoneyTreatment = "plain" | "sealed" | "exposed";

export const accent = {
  light: "#FED924",
  dark: "#B8ADE8",
} as const;

export interface Theme {
  scheme: Scheme;
  accent: string;
  /** Text on top of the accent. Yellow needs dark ink; lilac needs it too. */
  onAccent: string;
  bg: string;
  surface: string;
  text: string;
  sub: string;
  faint: string;
  line: string;
  field: string;
  /** Tint behind a confidential amount. */
  sealed: string;
  sealedText: string;
  /** Reserved. Amounts that are or are becoming public. Never decorative. */
  exposed: string;
  exposedBg: string;
  danger: string;
  /** Text drawn ON `danger`. White fails it; see the theme for the numbers. */
  onDanger: string;
  /** Tint behind a refusal or a destructive warning. */
  dangerBg: string;
  positive: string;
  /** Tint behind a confirmed outcome. */
  positiveBg: string;
}

export function theme(scheme: Scheme): Theme {
  const dark = scheme === "dark";
  return {
    scheme,
    accent: dark ? accent.dark : accent.light,
    onAccent: "#14151A",
    bg: dark ? "#14151A" : "#FBFAF8",
    surface: dark ? "#1D1F26" : "#FFFFFF",
    text: dark ? "#F2F1EE" : "#14151A",
    sub: dark ? "#A9A7A1" : "#5B5852",
    // Measured, not chosen by eye. The previous pair sat at 3.26:1 (light)
    // and 3.85:1 (dark) against their own backgrounds, under the 4.5:1 that
    // WCAG 1.4.3 requires for body text. `faint` carries section labels, the
    // reserve line, and the ORDINALS on the recovery phrase, and those numbers
    // carry the word order, so they are not decoration.
    faint: dark ? "#8A8781" : "#6F6C66",
    line: dark ? "#2A2D36" : "#E8E6E1",
    field: dark ? "rgba(255,255,255,0.05)" : "#F4F3F0",
    sealed: dark ? "rgba(184,173,232,0.14)" : "rgba(94,80,158,0.10)",
    sealedText: dark ? "#CFC7F0" : "#4A3F7A",
    // 4.31:1 on its own wash before, which is the warning tone failing the
    // check on the surface it is always drawn against.
    exposed: dark ? "#F0B45C" : "#8A5000",
    exposedBg: dark ? "rgba(232,163,61,0.14)" : "rgba(160,94,0,0.10)",
    danger: dark ? "#E8756B" : "#B3261E",
    // White on the dark danger colour is 2.92:1, and it is the label on the
    // button that ERASES THE WALLET. Near-black on the same fill is 6.24:1.
    // The light theme's deeper red carries white at 7.4:1 and keeps it.
    onDanger: dark ? "#14151A" : "#FFFFFF",
    dangerBg: dark ? "rgba(232,117,107,0.14)" : "rgba(179,38,30,0.10)",
    positive: dark ? "#6FCF97" : "#1B7F3B",
    positiveBg: dark ? "rgba(111,207,151,0.14)" : "rgba(27,127,59,0.10)",
  };
}

/** Type scale. Every size comes from here; no ad-hoc pixel values. */
export const fontSizes = {
  caption: 12,
  small: 14,
  body: 16,
  heading: 18,
  title: 24,
  display: 40,
} as const;

/**
 * Spacing ladder. Roughly x1.3 per step, which is why 18 and not 16: the popup
 * is 384px wide and an 18px gutter is what the screens were laid out on.
 * Nothing outside this ladder; a one-off 13 or 26 is how a layout drifts.
 */
export const space = {
  xs: 6,
  sm: 8,
  md: 10,
  lg: 14,
  gutter: 18,
  xl: 26,
} as const;

/** Corner radii. Nested corners pick the next step down, never the same one. */
export const radius = {
  sm: 6,
  md: 10,
  lg: 12,
  pill: 999,
} as const;

/** Line heights. Long-form copy gets `relaxed`, single lines get `tight`. */
export const leading = {
  tight: 1.3,
  normal: 1.5,
  relaxed: 1.7,
} as const;

/**
 * Amount sizes, by what the amount IS rather than by which screen shows it.
 * A pocket's balance is a `hero` wherever it appears, so the public and the
 * private pocket cannot drift to different sizes.
 */
export const moneySizes = {
  hero: 32,
  section: 24,
  row: 20,
  inline: 16,
} as const;

/**
 * Text roles bake in size and weight together, so same-role text always
 * matches. Three weights, not two: a wallet whose warnings are as heavy as its
 * balance has no hierarchy left for the warning.
 */
export const text = {
  hero: { fontSize: fontSizes.display, fontWeight: 700, fontVariantNumeric: "tabular-nums" },
  title: { fontSize: fontSizes.title, fontWeight: 700 },
  heading: { fontSize: fontSizes.heading, fontWeight: 600 },
  rowTitle: { fontSize: fontSizes.body, fontWeight: 600 },
  value: { fontSize: fontSizes.body, fontWeight: 600, fontVariantNumeric: "tabular-nums" },
  button: { fontSize: fontSizes.body, fontWeight: 600 },
  body: { fontSize: fontSizes.small, fontWeight: 500 },
  label: { fontSize: fontSizes.small, fontWeight: 500 },
  caption: { fontSize: fontSizes.caption, fontWeight: 500 },
} as const;

/** Chrome caps a toolbar popup near 600px. */
export const FRAME = { width: 384, height: 600 } as const;

/**
 * Motion. One easing and two durations, because this popup only moves for two
 * reasons: to answer a press, and to show that it is still working. Anything
 * that needs a third is decoration, and the press duration used to live inline
 * in one component, so the buttons built any other way had none at all.
 */
export const motion = {
  press: "90ms",
  ease: "cubic-bezier(0.2, 0, 0, 1)",
  /** The spinner is honest progress, not decoration, so it survives
   *  prefers-reduced-motion. Slow enough not to strobe. */
  spin: "0.7s",
} as const;

export const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
export const sans = "'Inter', system-ui, -apple-system, sans-serif";
