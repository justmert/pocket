// amounts.
//
// stellar carries seven decimals, so a balance is long and the interesting part
// is usually at the front. the whole number is set at full size and the fraction
// sits under it in the same tabular figures at a smaller size: the value is
// complete, and it is still readable at a glance. below one that rule inverts,
// because then the front carries nothing, so the figure is set as one run.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { FRAME, fontSizes, motion, space, type Theme } from "./theme";

export type Treatment = "plain" | "exposed";

const SIZES = {
  hero: fontSizes.hero,
  display: fontSizes.display,
  row: fontSizes.body,
  inline: fontSizes.small,
} as const;

/** the popup's content column: the frame, less the gutter on either side. */
const COLUMN = FRAME.width - space.gutter * 2;
/** tabular figures at weight 800 measure close to this fraction of their size. */
const DIGIT_EM = 0.62;
/** the flex gap between the figure and its code, as a fraction of the size. */
const GAP_EM = 0.14;

/**
 * the largest size at which this figure still fits the column.
 *
 * `units` is measured in whole-part characters rather than in characters,
 * because the three runs are set at three sizes: a fraction at half the base
 * costs half the room per digit, and the code at four tenths costs four tenths.
 * so a figure is priced by adding up what each run costs in units of the base,
 * and the base is then whatever divides into the column.
 *
 * this applies to every amount, not only the sub-one ones it was written for.
 * the largest balance stellar can hold is 922,337,203,685.4775807, and its whole
 * part alone is fifteen characters: at the hero's own size that is 390px of
 * digits in a 348px column, which is a number that runs off the side of the one
 * screen whose whole job is to state it.
 */
function fit(px: number, units: number, gaps: number): number {
  const per = units * DIGIT_EM + gaps * GAP_EM;
  return Math.max(fontSizes.small, Math.min(px, Math.floor(COLUMN / per)));
}

/**
 * split a decimal string into a grouped whole part and its fraction.
 *
 * trailing zeros are dropped because they carry nothing: 40.0000000 and 40 are
 * the same number. no significant digit is ever removed.
 */
export function splitAmount(value: string): { whole: string; fraction: string } {
  const [rawWhole = "0", rawFraction = ""] = value.split(".");
  const negative = rawWhole.startsWith("-");
  const digits = negative ? rawWhole.slice(1) : rawWhole;
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return {
    whole: (negative ? "-" : "") + grouped,
    fraction: rawFraction.replace(/0+$/, ""),
  };
}

export function Amount({
  t,
  value,
  code,
  size = "row",
  treatment = "plain",
  /** rolls each digit to its new value instead of snapping. */
  animate = false,
}: {
  t: Theme;
  value: string;
  code?: string;
  size?: keyof typeof SIZES;
  treatment?: Treatment;
  animate?: boolean;
}) {
  const { whole, fraction } = splitAmount(value);
  const big = size === "hero" || size === "display";

  /*
   * a figure below one keeps everything that matters after the point, and the
   * split that demotes the fraction puts a meaningless "0" at full size with
   * the number itself at half of it and six tenths of the opacity. under one,
   * the figure is not split at all: it runs at a single size, stepped down to
   * whatever the column takes rather than left to wrap mid-number.
   */
  const oneRun = big && fraction !== "" && (whole === "0" || whole === "-0");

  // the two demoted runs, as fractions of the base size. read once here so the
  // measurement below and the rendering further down cannot drift apart.
  const fractionOf = big ? 0.5 : 0.85;
  const codeOf = big ? 0.4 : 0.85;
  const units =
    (oneRun ? whole.length + 1 + fraction.length : whole.length) +
    (!oneRun && fraction ? (fraction.length + 1) * fractionOf : 0) +
    (code ? code.length * codeOf : 0);
  const px = fit(SIZES[size], units, code ? 1 : 0);

  const tones: Record<Treatment, CSSProperties> = {
    plain: { color: t.text },
    exposed: { color: t.exposed },
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        flexWrap: "wrap",
        gap: Math.round(px * GAP_EM),
        fontVariantNumeric: "tabular-nums",
        letterSpacing: big ? "-0.03em" : undefined,
        fontWeight: big ? 800 : 700,
        fontSize: px,
        lineHeight: 1.1,
        minWidth: 0,
        ...tones[treatment],
      }}
    >
      {/* the exact figure, unsplit and ungrouped. reading a balance out of three
          separate spans gives "nine thousand, point, zero zero zero" and a
          grouped one gives the digits in the wrong groups, so the value a
          screen reader announces is this one, and it is also the one a test
          can match. */}
      <span style={EXACT}>{code ? `${value} ${code}` : value}</span>
      <span aria-hidden style={{ display: "inline-flex", alignItems: "baseline" }}>
        {oneRun ? (
          animate ? <Rolling value={`${whole}.${fraction}`} /> : `${whole}.${fraction}`
        ) : (
          <>
            {animate ? <Rolling value={whole} /> : whole}
            {fraction && (
              <span style={{ fontSize: Math.round(px * fractionOf), opacity: 0.62 }}>
                .{fraction}
              </span>
            )}
          </>
        )}
      </span>
      {code && (
        <span
          aria-hidden
          style={{ fontSize: Math.round(px * codeOf), fontWeight: 700, color: t.sub }}
        >
          {code}
        </span>
      )}
    </span>
  );
}

/** off screen but in the accessibility tree, which is where the exact figure belongs. */
const EXACT: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

/* --------------------------------------------------------------------- */

/** each digit sits in a column that slides to its new value. */
function Rolling({ value }: { value: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", whiteSpace: "pre" }}>
      {value.split("").map((ch, i) =>
        ch >= "0" && ch <= "9" ? (
          <RollDigit key={i} digit={Number(ch)} />
        ) : (
          <span key={i} style={{ display: "inline-block", height: "1em", lineHeight: "1em" }}>
            {ch}
          </span>
        ),
      )}
    </span>
  );
}

function RollDigit({ digit }: { digit: number }) {
  // a digit that changes blurs for the length of the roll, so the column reads
  // as travelling rather than as ten stacked numbers.
  const [blur, setBlur] = useState(0);
  const [settling, setSettling] = useState(false);
  const prev = useRef(digit);

  useEffect(() => {
    if (prev.current === digit) return;
    prev.current = digit;
    setBlur(1.2);
    setSettling(false);
    const r = requestAnimationFrame(() => {
      setSettling(true);
      setBlur(0);
    });
    return () => cancelAnimationFrame(r);
  }, [digit]);

  // one gesture, so the travel and the blur settling out of it share a duration
  // and a curve. `motion.roll` is that duration; neither number is chosen here.
  const transition =
    `transform ${motion.roll} ${motion.enter}` +
    (settling ? `, filter ${motion.roll} ${motion.enter}` : "");

  return (
    <span style={{ display: "inline-block", height: "1em", overflow: "hidden", verticalAlign: "bottom" }}>
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          transform: `translateY(${-digit}em)`,
          transition,
          filter: blur ? `blur(${blur}px)` : undefined,
          willChange: "transform, filter",
        }}
      >
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <span key={n} style={{ height: "1em", lineHeight: "1em" }}>
            {n}
          </span>
        ))}
      </span>
    </span>
  );
}

/** the hero, with the skeleton it shows before a real number arrives. */
export function HeroAmount({
  t,
  value,
  code,
  treatment = "plain",
}: {
  t: Theme;
  value: string | null;
  code: string;
  treatment?: Treatment;
}) {
  return (
    <div
      style={{
        minHeight: Math.round(fontSizes.hero * 1.25),
        display: "flex",
        alignItems: "center",
        marginBottom: space.xs,
      }}
    >
      {value === null ? (
        // a shimmer says "not yet" to someone looking. it says nothing at all to
        // someone listening, so the same fact is spelled out for them.
        <span role="status" aria-live="polite" style={{ display: "block", width: 190, maxWidth: "100%" }}>
          <span style={EXACT}>Reading the ledger</span>
          <span aria-hidden className="pocket-skeleton" style={{ display: "block", width: "100%", height: 38 }} />
        </span>
      ) : (
        <Amount t={t} value={value} code={code} size="hero" treatment={treatment} animate />
      )}
    </div>
  );
}
