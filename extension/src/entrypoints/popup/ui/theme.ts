// design tokens.
//
// one accent per pocket. sky-blue is the public pocket, teal is the private one,
// and choosing a pocket flips the whole surface with it: light for public, dark
// for private. the colour is therefore never decoration, it always says which
// pocket you are looking at.

export type Pocket = "public" | "private";

/**
 * the palette: the single source of every colour value in the product.
 *
 * these ramps are measured, not chosen by eye. each stop targets a CIELAB L* and
 * its WCAG contrast against the surface it is drawn on; where a stop exists for a
 * contrast reason the number is written beside it here.
 *
 * `resources/colors.md` is NOT the provenance and must not be cited as it: that
 * file documents a ROSE accent, a green semantic ramp and a pure white, none of
 * which the product ships, and grepping any current stop in it returns nothing.
 * It was cited here twice, which made a stale document read as the authority for
 * values it has never contained.
 *
 * change a stop here and every pocket that references it follows, because nothing
 * below this block names a raw colour. the two anchor pairs are
 * sky-400 on warm-bg (the public pocket) and teal-400 on cool-bg (the private
 * one); everything else derives from them.
 */
// the public pocket's accent: a clear sky-blue. 400 is the value the FAB, the
// buttons and the active controls wear; the lighter stops tint the soft fills,
// the hairlines and the wash at the top of the page, and a deep 700 carries the
// "this is public" info role. anchored on #00b4ff, lighter stops mixed toward the
// warm-white surface. there is no rose anywhere in the product.
const sky = {
  50: "#def5ff",
  100: "#b8eaff",
  200: "#73d6ff",
  400: "#00b4ff",
  // a deep, readable blue for the "this is public" info role (exposed): clears
  // ~6:1 on the sky[50] tint it is drawn on, so it reads as info, not an error.
  700: "#005c8a",
  // 800 is the "exposed" stop: deeper than 700 so an info note is distinguishable
  // from a positive one, which 700 carries. 10.33:1 on sky[50].
  800: "#003c5c",
} as const;
// the private pocket's accent: a deep teal. it shares the public sky's HUE (198) so
// the two pockets read as one hue family, light-blue (public) vs deep-teal (private),
// rather than two hues that look almost-but-not-quite the same. it used to sit at 192,
// which read a touch green next to the public blue; each stop keeps its own saturation
// and lightness and only the hue is pinned to 198.
const teal = {
  // 100 is a light readable stop for the private "exposed" info tone, set apart from
  // positive (300) so the two stop reading as the same colour.
  100: "#bcdeed",
  200: "#83c6e2",
  300: "#53b4de",
  400: "#1c92c4",
  600: "#0c6c95",
  800: "#023c55",
  // 850 is the deeper glow the private page wash fades from: darker than the accent
  // soft (800) so the pocket badge does not disappear into the top-of-page glow.
  850: "#0b212a",
  // 950 is the soft fill behind positive/exposed notices. it was near-black and read
  // as the same tone as the card surface it sits on; a more saturated dark teal keeps
  // it a "soft" band while separating it from the surface underneath.
  950: "#06303e",
} as const;
// the public pocket's neutrals: a clean, faintly-cool gray ramp (NOT rose). the
// old ramp was warm/rose-tinted to sit under a rose accent; under the blue accent
// that tint read as pink on every surface, field and border, so it is neutralised
// to a cool gray that pairs with the blue. same lightness per stop, hue removed.
const warm = {
  bg: "#fcfdfe",
  // no pure #ffffff anywhere: the lightest surface is the same soft off-white as the
  // page, so a card lifts by its border or shadow rather than by being whiter than
  // white. 100 is a faint step down for the "i" tooltip, so it reads off the page.
  0: "#fcfdfe",
  100: "#eef1f5",
  200: "#dce2e8",
  900: "#1b1f24",
} as const;
const cool = {
  bg: "#020b0e",
  950: "#000102",
  850: "#0a1921",
  800: "#11242d",
  // 750 is the private card surface (and sheet): a small lift off the near-black floor,
  // borderless, so a soft shadow carries the elevation rather than a grey slab of fill.
  750: "#0b1a22",
  700: "#1a2f39",
  // 650 is the private floating nav's own stop, well DARKER than the cards (750) and
  // sitting close to the page floor: the bar recedes into the dark and its teal glow
  // (BottomNav) does the lifting, so it is never the lightest thing on the screen.
  650: "#06121a",
  // 625 is the private hairline/border stop, just below the shared 600.
  625: "#264554",
  // the mid stops of the measured ramp (HSL 200): the private
  // pocket surfaces sit one step LIGHTER than the near-black floor so pages, popups
  // and the cards inside them read as distinct raised planes rather than one dark
  // mass. 600 was darkened off the measured stop: it fills the active nav tile and
  // the input field in the private pocket, and the old value read too light there.
  600: "#21323e",
  // 550 and 450 are the public pocket's TYPE ramp, added for the same reason
  // paper[150] was added to the private one: `text` and `sub` were cool[700] and
  // cool[600], which are 1.05:1 apart on the page (13.66 against 12.96), so the
  // two levels were the same colour and nothing separated a placeholder from a
  // typed value. these give 13.66 / 7.83 / 5.02, whose step ratios (1.74, 1.56)
  // are the private ramp's own (1.79, 1.58). measured against warm.bg #fcfdfe.
  550: "#3a5464",
  500: "#456271",
  450: "#547283",
  400: "#7493a2",
  100: "#eef1f2",
} as const;
// neutral inks for TYPE only, deliberately off the tinted surface neutrals: the
// type reads as grey-black rather than carrying the accent. surfaces, borders and
// fills keep their warm/cool cast; only text points at these.
const ink = { 900: "#1d1d1f", 700: "#5c5c5e", 600: "#737377", 400: "#c9c9ce" } as const; // light pocket
// dark-pocket type greys, one role per stop: text (100), sub (150), faint (200),
// hairline (600). sub and faint were darkened off the near-white end to WIDEN the
// private text hierarchy: text/sub/faint used to sit inside a ~15 L* spread and read
// as one weight, so 150 and 200 drop to open the spread to ~36 and give the three
// levels a clear order.
const paper = {
  100: "#eeeef0",
  150: "#b3b3bd",
  200: "#8d8d9a",
  300: "#a4a4a7",
  600: "#3a3a3f",
} as const;
// danger sits at HSL 4, chosen by scan for dichromatic separation, with a light
// and dark cut plus the tint it is drawn on. there is deliberately no success
// GREEN: "positive" (received, a gain, a completed op) wears the pocket's own
// readable accent tone instead (see `positive` below), so the palette stays two
// hues per pocket, the accent and red, and green never appears as a third.
const dangerRamp = {
  light: "#c3382e",
  lightTint: "#fceae9",
  dark: "#fb6e64",
  darkTint: "#4a1512",
} as const;

// the loading shimmer is a translucent sheen that sweeps across whatever surface
// it covers, so it is a sheer white/black overlay rather than a ramp stop. the
// dark private canvas (cool.bg #020b0e) needs a LIGHT sheen or a mid-grey barely
// travels and the state looks broken; the light public surface needs a DARK one.
// two stops each: a dim base at the sweep's edges and a brighter peak at its
// centre, matching the 0.09/0.2 rhythm the single hardcoded gradient used to run.
const shimmerLight = {
  base: "rgba(255, 255, 255, 0.06)",
  hi: "rgba(255, 255, 255, 0.16)",
} as const;
const shimmerDark = { base: "rgba(20, 21, 26, 0.05)", hi: "rgba(20, 21, 26, 0.13)" } as const;

/**
 * fixed, non-themeable colours. the qr pair is deliberately not themed: a tinted
 * qr loses scan reliability on low-quality sensors. the scrim is derived from
 * cool-950 and is one value for both pockets.
 */
export const fixed = {
  qrFg: "#000000",
  qrBg: "#ffffff",
  scrim: "rgba(0,1,2,0.62)",
} as const;

/** the two accents as a named pair, for the marks that place them together (see
 *  Cover). the pocket surfaces read them from the theme objects below. */
export const accent = {
  public: sky[400],
  private: teal[400],
} as const;

/** type scale. every size in the ui comes from here. */
export const fontSizes = {
  micro: 10,
  caption: 12,
  small: 14,
  body: 16,
  heading: 18,
  title: 24,
  display: 34,
  hero: 42,
} as const;

/**
 * the type families, and the single place any of them is named. change a face
 * here and the whole product follows, because nothing below ever names a family
 * by hand.
 *
 * display and body are one face (figtree); they stay separate slots so the two
 * voices can diverge again without touching a call site. hierarchy between them
 * is carried by weight and size, never by family. mono is the verbatim-data face
 * (dm mono): addresses, the recovery phrase, hashes, recipient and origin, read
 * one character at a time where a slip between two glyphs loses money.
 *
 * figtree ships as a variable file (400 to 700, three points used); dm mono ships
 * one static cut at 500, its heaviest, which reads as a regular text weight rather
 * than emphasis. see popup/main.tsx for the imports.
 */
export const fonts = {
  display: '"Figtree Variable", system-ui, sans-serif',
  body: '"Figtree Variable", system-ui, sans-serif',
  mono: '"DM Mono", ui-monospace, monospace',
} as const;

/**
 * text roles. each carries size, weight and family together so the same kind of
 * text matches everywhere without anyone picking a face or a weight by hand.
 *
 * four weights: 700 for headings and the balance, 600 for buttons, labels and row
 * titles, 500 for prose and for verbatim data, and 400 at a few non-prose sites.
 * this said "three weights and no more ... 400 for prose", and every prose role
 * here is 500, so the sentence described neither the roles below it nor the tree.
 * verbatim data (addresses, the phrase) is set in `fonts.mono` at 500 at the few
 * call sites that render it, over whichever role applies.
 */
// every prose role can break inside a word. chrome zooms to 500%, which leaves
// the popup 160px wide, and a title that refuses to break is a title that is
// simply cut off with nothing to scroll to.
const BREAKS = { overflowWrap: "anywhere" } as const;

/**
 * line height, per role, because no role carried one.
 *
 * `text.body` rendered at four different densities across ~20 call sites (unset,
 * 1.45, 1.5, 1.55) and `text.caption` split the same way: each site that needed
 * comfortable prose added its own. The role owns it now, so the same kind of text
 * is set the same way without anyone choosing.
 *
 * Figures and headings stay TIGHT: a balance is one line by construction and a
 * loose leading on a 42px number just pushes the screen down.
 */
const PROSE_LEADING = 1.5;
const TIGHT_LEADING = 1.2;

export const text = {
  // hero and display carry BREAKS too. they were the only two roles without it,
  // against the rule stated at `BREAKS` itself: at 500% zoom the popup is 160px
  // and a figure or a state word that refuses to break is simply cut off with
  // nothing to scroll to. call sites had started patching the roles by hand,
  // inconsistently, which is the drift a role exists to prevent.
  hero: {
    fontFamily: fonts.display,
    fontSize: fontSizes.hero,
    fontWeight: 700,
    letterSpacing: "-0.035em",
    lineHeight: TIGHT_LEADING,
    ...BREAKS,
  },
  display: {
    fontFamily: fonts.display,
    fontSize: fontSizes.display,
    fontWeight: 700,
    letterSpacing: "-0.03em",
    lineHeight: TIGHT_LEADING,
    ...BREAKS,
  },
  screenTitle: {
    fontFamily: fonts.display,
    fontSize: fontSizes.title,
    fontWeight: 700,
    letterSpacing: "-0.02em",
    ...BREAKS,
  },
  heading: {
    fontFamily: fonts.display,
    fontSize: fontSizes.heading,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    ...BREAKS,
  },
  // the pocket tabs on Home and History. body size so both labels and the compact
  // figure share one row, but heading weight and tracking so the active pocket
  // reads as a title rather than a control. one role so the two screens cannot
  // pick different sizes; the call site owns colour and whiteSpace.
  pocketTab: {
    fontFamily: fonts.display,
    fontSize: fontSizes.body,
    fontWeight: 700,
    letterSpacing: "-0.01em",
    ...BREAKS,
  },
  rowTitle: { fontFamily: fonts.display, fontSize: fontSizes.body, fontWeight: 600, ...BREAKS },
  rowSub: {
    fontFamily: fonts.body,
    fontSize: fontSizes.small,
    fontWeight: 500,
    lineHeight: PROSE_LEADING,
    ...BREAKS,
  },
  button: { fontFamily: fonts.display, fontSize: fontSizes.body, fontWeight: 600, ...BREAKS },
  value: {
    fontFamily: fonts.display,
    fontSize: fontSizes.body,
    fontWeight: 600,
    fontVariantNumeric: "tabular-nums lining-nums",
    ...BREAKS,
  },
  chip: { fontFamily: fonts.body, fontSize: fontSizes.small, fontWeight: 600, ...BREAKS },
  label: { fontFamily: fonts.body, fontSize: fontSizes.small, fontWeight: 600, ...BREAKS },
  input: { fontFamily: fonts.body, fontSize: fontSizes.body, fontWeight: 500 },
  body: {
    fontFamily: fonts.body,
    fontSize: fontSizes.small,
    fontWeight: 500,
    lineHeight: PROSE_LEADING,
    ...BREAKS,
  },
  caption: {
    fontFamily: fonts.body,
    fontSize: fontSizes.caption,
    fontWeight: 500,
    lineHeight: PROSE_LEADING,
    ...BREAKS,
  },
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

  /** did my input register. */
  instant: "140ms",
  /** a layer arrived or left. */
  quick: "200ms",
  /** a screen settles into place. */
  page: "260ms",
  /** a sheet comes up. */
  sheet: "280ms",
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

/**
 * how long a "Copied" acknowledgement stays up.
 *
 * ONE window. there were four (1200, 1400, 1500, 2500), none within 100ms of
 * another and none a token, across six copy controls, while two comments claimed
 * a uniformity the numbers did not have.
 */
export const COPY_HOLD_MS = 1500;

/** the stagger between one row and the next. */
export const ROW_STAGGER_MS = 45;

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
  /**
   * ink drawn on top of the accent.
   *
   * NEAR-BLACK, which is what "both accents are light" was always an argument
   * for and not what the value was. It was `warm[0]` #fcfdfe in both pockets:
   * 2.30:1 on sky[400] and 3.46:1 on teal[400], so no accent-filled control in
   * the product cleared 4.5:1 and the public one missed even the 3:1 floor for a
   * graphical object. `text.button` is 16/600 and `text.pocketTab` 16/700, and
   * neither is WCAG "large". Darkening the FILL instead is not available: white
   * needs a luminance at or below 0.179 and sky[400] is 0.399.
   *
   * This is the most visible single change in the palette, and it is the one the
   * file's own claim at the top of `PUBLIC` ("contrast was verified against the
   * surface each colour is actually drawn on") required all along.
   */
  onAccent: string;
  /** accent at low opacity, for icon circles, active tiles and soft cards. */
  accentSoft: string;
  /** readable text/glyph colour drawn ON accentSoft: the raw accent misses 4.5:1
   *  on the dark pocket's soft fill, so its own stop keeps the accent tone legible. */
  accentOnSoft: string;
  accentLine: string;
  /** the fill under a primary button. */
  accentFill: string;
  bg: string;
  /**
   * the glow the top of each page carries, as a background IMAGE with a
   * transparent outer stop.
   *
   * it used to end on the flat page colour, which made it opaque, and an opaque
   * gradient cannot crossfade: a gradient is not an animatable value, so
   * `motion.pocket` (620ms) had one consumer, `Frame`'s background, sitting behind
   * a `ScrollArea` at `inset: 0` that covered it completely. the pocket switch,
   * the product's signature move, measured 0ms on the canvas, the cards, the
   * plates and the nav. ending transparent lets the flat colour underneath show
   * through and TRANSITION, which is most of the screen's area.
   */
  canvas: string;
  surface: string;
  /** the "i" tooltip bubble: deliberately OFF the surface/sheet tone so the
   *  explanation reads as a layer over the card, not as the card. a touch darker
   *  than the light page, a touch lighter than the dark surface. */
  tip: string;
  /** the fill behind a home prompt card ("Private pocket not set up", "Fund this
   *  account"): a softer, lighter accent tint than a chip, so the card reads as a
   *  gentle nudge under the chart rather than a solid accent block. */
  promptBg: string;
  text: string;
  sub: string;
  faint: string;
  /** a light neutral for subtle "behind" lines, e.g. the chart trail past the cursor. */
  hairline: string;
  line: string;
  field: string;
  /**
   * a soft, accent-tinted surface, one step deeper than `field`.
   *
   * its one consumer is the quiet button's hover (`--pocket-quiet-hover`). this
   * said "used for the amount composer in send / move", and the composer does not
   * use it: `AmountComposer` fills its card from `t.bg` and reserves `t.field` for
   * the asset chip's recess. the sentence was describing an arrangement that had
   * been replaced, on a token whose whole job is to say where it belongs.
   */
  tint: string;
  /** floating bar and sheet fills, sitting over blurred content. */
  bar: string;
  sheet: string;
  /** the one canonical drop shadow for raised surfaces, so elevation reads the
   *  same everywhere instead of each surface hand-writing a drifting rgba. */
  shadow: string;
  /** the loading shimmer's two stops, per pocket: a light sheen on the dark
   *  canvas, a dark one on the light surface, so the balance-loading state reads
   *  as motion in both rather than a dull smudge in the private pocket. handed to
   *  the stylesheet's `.pocket-skeleton` gradient through custom properties. */
  skeletonBase: string;
  skeletonHi: string;
  /** the modal backdrop behind sheets and dialogs. one value for both pockets. */
  scrim: string;
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
   * NOT the accent. a light accent on a near-white surface cannot reach the 3:1
   * a focus indicator needs, and every control here is built with `all: unset`, so the
   * ring is the only focus signal there is.
   */
  ring: string;
}

export function theme(pocket: Pocket): Theme {
  return pocket === "private" ? PRIVATE : PUBLIC;
}

// every field maps to a measured ramp stop; the mapping is the only place a
// colour gets a job. contrast was verified against the surface each colour is
// actually drawn on, not chosen by eye. contrast figures are recorded beside the
// stops they justify rather than in a separate document that has since drifted.
const PUBLIC: Theme = {
  pocket: "public",
  dark: false,
  accent: sky[400],
  // 7.19:1 on sky[400].
  onAccent: ink[900],
  // the accent-tint stop: a soft accent fill for icon circles, tiles and cards.
  accentSoft: sky[100],
  accentOnSoft: ink[900],
  accentLine: sky[200],
  // flat: the palette carries no gradients. the primary fill is the accent.
  accentFill: sky[400],
  bg: warm.bg,
  // a faint blue wash at the top of every page, settling into the flat bg. the
  // hue is the pocket's own; it is barely there, which is the point.
  // a pool of hue that is deepest at the top-centre and fades in every direction
  // from there: strong under the tabs, thinning toward the edges and downward,
  // rather than a flat band of one colour across the whole width.
  canvas: `radial-gradient(130% 130px at 50% 0px, ${sky[200]} 0%, transparent 72%)`,
  surface: warm[0],
  // a faint step darker than the page, so the tooltip reads as a raised layer.
  tip: warm[100],
  // the ramp stop, not a hand-written near-copy of it. this was "#dff4ff", a raw
  // hex sitting below the block whose own first paragraph says "nothing below
  // this block names a raw colour", and within one unit per channel of sky[50].
  promptBg: sky[50],
  // blue-tinted slates rather than neutral ink: neutral black type read as not
  // belonging on the sky-blue cards and fields (the amount card, the recipient
  // field). these are the measured blue-grey stops, tinted toward the pocket's own
  // accent, so the type sits ON the blue instead of clashing with it. still deep
  // enough to clear contrast on the near-white page.
  text: cool[700],
  sub: cool[550],
  faint: cool[450],
  hairline: ink[400],
  line: warm[200],
  // fields and soft panels wear a light blue tint, not a neutral gray, so inputs,
  // the search bar and the pocket toggle read as the wallet's own surface. `tint`
  // is one stop DEEPER than field, so the amount composer reads as a raised card
  // over the fields nested in it (the same field/tint step the dark pocket has).
  field: sky[50],
  tint: sky[100],
  bar: warm[0],
  sheet: warm[0],
  shadow: "0 12px 30px -14px rgba(20, 21, 26, 0.35)",
  // a dark sheen: the light public surface needs a shadow-toned sweep to read.
  skeletonBase: shimmerDark.base,
  skeletonHi: shimmerDark.hi,
  scrim: fixed.scrim,
  danger: dangerRamp.light,
  onDanger: warm[0],
  dangerSoft: dangerRamp.lightTint,
  // positive is NOT green: it is the pocket's own deep, readable accent stop, so a
  // received payment, a gain, or a completed op reads as the wallet's own colour
  // rather than a third hue. clears 4.5:1 on positiveSoft, and drives white text
  // as a solid badge fill (the received-direction dot).
  positive: sky[700],
  positiveSoft: sky[50],
  // "exposed" marks an amount that is public: the pocket's own accent at a deep,
  // readable stop, so it reads as an INFO note ("this is visible") rather than the
  // red of a real error (`danger`).
  //
  // its OWN stop, because it was `sky[700]` and so was `positive`: byte-identical,
  // with identical softs. History states the reasoning for choosing `exposed` over
  // `danger` on an unresolved submission, and in the public pocket that choice
  // produced the same pixels as a completed one. the private pocket keeps the two
  // 17 L* apart and this file states that as a rule. 10.33:1 on sky[50], and 1.61:1
  // from `positive`, the same order of separation the private pair has.
  exposed: sky[800],
  exposedSoft: sky[50],
  ring: warm[900],
};

const PRIVATE: Theme = {
  pocket: "private",
  dark: true,
  accent: teal[400],
  // 4.77:1 on teal[400].
  onAccent: ink[900],
  accentSoft: teal[800],
  // a light teal, NOT the raw accent: teal[400] on teal[800] is only ~3.2:1.
  accentOnSoft: teal[200],
  // its own stop, so accent cards/chips keep a visible edge here as they do in
  // public (teal[800] as both fill and line made the border vanish).
  accentLine: teal[600],
  accentFill: teal[400],
  // the page floor is the near-black cool.bg, the private mirror of the public
  // pocket flooring its pages at warm.bg: the page itself is the darkest plane and
  // the raised surfaces (bar/cards/field/composer) sit a measured step above it, so
  // they read as distinct planes rather than one dark mass. the order still reads
  // page < raised (bar/cards) < field < composer.
  bg: cool.bg,
  canvas: `radial-gradient(130% 130px at 50% 0px, ${teal[850]} 0%, transparent 72%)`,
  surface: cool[750],
  // the same fill the field and text components use (#21323e), a clear step lighter
  // than the near-black surface so the tooltip lifts off the sheet.
  tip: cool[600],
  // the private pocket keeps the dark accent tint for its own prompt cards.
  promptBg: teal[800],
  // the type greys go one step WHITER to match the brighter surfaces: on the raised
  // cards the old secondary/tertiary greys had lost contrast, so sub and faint each
  // step up (paper[150] is the one measured grey added for exactly this).
  text: paper[100],
  sub: paper[150],
  faint: paper[200],
  hairline: paper[600],
  line: cool[625],
  // on dark, a recessed input disappears; the field is the raised stop instead,
  // so it reads as a field rather than a hole.
  field: cool[600],
  tint: cool[500],
  // the floating nav sits DARKER than the cards (cool[650] L* 4.93 against the
  // surface's 8.35) and close to the page floor, so it recedes and its teal glow
  // does the lifting. the comment here used to say "one stop LIGHTER ... so it
  // separates from the cards", which is the opposite of both the code and the
  // stop's own note twenty lines up.
  bar: cool[650],
  sheet: cool[750],
  shadow: "0 14px 34px -14px rgba(0, 0, 0, 0.7)",
  // a light sheen: on the near-black canvas a mid-grey barely travels, so the
  // private pocket gets a brighter white sweep than public's dark one.
  skeletonBase: shimmerLight.base,
  skeletonHi: shimmerLight.hi,
  scrim: fixed.scrim,
  danger: dangerRamp.dark,
  onDanger: cool[950],
  dangerSoft: dangerRamp.darkTint,
  // positive is NOT green here either: a light readable teal stop of the pocket's
  // own accent, so positive states read as the wallet's colour on the dark surface.
  positive: teal[300],
  positiveSoft: teal[950],
  // "exposed" as the pocket's own accent, a LIGHT readable stop (100) on the dark
  // surface: an info note that an amount is public, not a red error. lighter than
  // positive (300) on purpose, so the two tones stop reading as the same colour.
  exposed: teal[100],
  exposedSoft: teal[950],
  ring: cool[100],
};
