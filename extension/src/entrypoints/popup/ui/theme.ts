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
export type Pocket = "public" | "private";
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
  positive: string;
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
    faint: dark ? "#75736E" : "#8E8B85",
    line: dark ? "#2A2D36" : "#E8E6E1",
    field: dark ? "rgba(255,255,255,0.05)" : "#F4F3F0",
    sealed: dark ? "rgba(184,173,232,0.14)" : "rgba(94,80,158,0.10)",
    sealedText: dark ? "#CFC7F0" : "#4A3F7A",
    exposed: dark ? "#E8A33D" : "#A05E00",
    exposedBg: dark ? "rgba(232,163,61,0.14)" : "rgba(160,94,0,0.10)",
    danger: dark ? "#E8756B" : "#B3261E",
    positive: dark ? "#6FCF97" : "#1B7F3B",
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
export const FRAME = { width: 384, height: 600, radius: 20 } as const;

export const mono = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace";
export const sans = "'Inter', system-ui, -apple-system, sans-serif";
