// amounts.
//
// stellar carries seven decimals, so a balance is long and the interesting part
// is usually at the front. the whole number is set at full size and the fraction
// sits under it in the same tabular figures at a smaller size: the value is
// complete, and it is still readable at a glance. below one that rule inverts,
// because then the front carries nothing, so the figure is set as one run.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { FRAME, fontSizes, fonts, motion, space, type Theme } from "./theme";

export type Treatment = "plain" | "exposed";

const SIZES = {
  hero: fontSizes.hero,
  display: fontSizes.display,
  row: fontSizes.body,
  inline: fontSizes.small,
} as const;

/** the popup's content column: the frame, less the gutter on either side. */
const COLUMN = FRAME.width - space.gutter * 2;
/** the display face's figures measure close to this fraction of their size. */
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
  /** rolls each digit to its new value instead of snapping. ON by default: a figure
   *  that changes under the user (a balance after a receive, a scrubbed value, a
   *  spendable that just moved) should tally to its new value, and a figure that
   *  never changes simply never rolls, so this is safe to leave on everywhere. the
   *  review/receipt figures sit inside a `pocket-still` sheet, which freezes the
   *  roll for the one place stillness is the point. */
  animate = true,
  /** "hide balance": the digits are replaced by a fixed run of asterisks, so the
   *  magnitude is hidden too (not just the exact value), the way a masked balance
   *  reads in every wallet. the currency sign, if any, stays. */
  hidden = false,
  /** show EVERY fraction digit, not the four-place display cap. a confirm and a
   *  receipt must show the exact figure being signed: a shown value that differs
   *  from the signed value, even by a truncated tail, is a shown != signed gap. */
  full = false,
  /** render the figure as ONE run at one size, never a demoted fraction. for a
   *  value sitting in a row (a confirm fact) rather than as a hero. */
  flat = false,
}: {
  t: Theme;
  value: string;
  code?: string;
  size?: keyof typeof SIZES;
  treatment?: Treatment;
  animate?: boolean;
  hidden?: boolean;
  full?: boolean;
  flat?: boolean;
}) {
  const { whole, fraction: rawFraction } = splitAmount(value);
  // the visible figure shows at most FOUR fraction digits: stellar's seven made a
  // long, hard-to-read tail on every balance. it is a DISPLAY cap only, truncated
  // (never rounded up); the exact value is still spoken to a screen reader from
  // `value` below and is what the worker signs. `full` lifts the cap where the
  // exact figure IS the point (the confirm, the receipt).
  const fraction = full ? rawFraction : rawFraction.slice(0, 4);
  const big = size === "hero" || size === "display";
  // the mask: a fixed three-star run per part, keeping the sign in front, so a
  // hidden balance is "$***.***" rather than a length that leaks its magnitude.
  const MASK = "∗∗∗";
  const sign = whole.startsWith("$") ? "$" : whole.startsWith("-") ? "-" : "";
  const dispWhole = hidden ? `${sign}${MASK}` : whole;
  const dispFraction = hidden ? (fraction ? MASK : "") : fraction;
  // never roll a figure being SIGNED: `full`/`flat` are the confirm and receipt,
  // where the exact digits are the point and stillness is the treatment; rolling
  // them would also swap the drawn glyphs for ten-deep digit columns. everything
  // else (balances, heroes, spendables) is a live figure that should tally.
  const doAnimate = animate && !hidden && !full && !flat;

  /*
   * a figure below one keeps everything that matters after the point, and the
   * split that demotes the fraction puts a meaningless "0" at full size with
   * the number itself at half of it and six tenths of the opacity. under one,
   * the figure is not split at all: it runs at a single size, stepped down to
   * whatever the column takes rather than left to wrap mid-number.
   */
  // `flat` forces the whole figure onto one run at one size, no demoted fraction:
  // a confirm row shows the exact amount being signed, and a faded, half-size tail
  // on a value you are approving reads as less certain than the whole part.
  const oneRun = fraction !== "" && (flat || (big && (whole === "0" || whole === "-0")));

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
        fontFamily: fonts.display,
        // the integer sits at 700; the fraction run below drops to 400. lining
        // figures so digits sit on the baseline, tabular so they never reflow.
        fontVariantNumeric: "tabular-nums lining-nums",
        // the hero balance tracks text.hero (-0.035em) so it is pixel-identical
        // to the amount typed into Send/Move, which becomes this balance; the
        // smaller display role keeps text.display's -0.03em.
        letterSpacing: size === "hero" ? "-0.035em" : big ? "-0.03em" : undefined,
        fontWeight: 700,
        fontSize: px,
        lineHeight: 1.1,
        minWidth: 0,
        ...tones[treatment],
        ...(hidden ? { userSelect: "none" } : null),
      }}
    >
      {/* the exact figure, unsplit and ungrouped. reading a balance out of three
          separate spans gives "nine thousand, point, zero zero zero" and a
          grouped one gives the digits in the wrong groups, so the value a
          screen reader announces is this one, and it is also the one a test
          can match. hidden: the value is not spoken either. */}
      <span style={EXACT}>{hidden ? "Balance hidden" : code ? `${value} ${code}` : value}</span>
      <span aria-hidden style={{ display: "inline-flex", alignItems: "baseline" }}>
        {oneRun && !hidden ? (
          doAnimate ? (
            <Rolling value={`${whole}.${fraction}`} />
          ) : (
            `${whole}.${fraction}`
          )
        ) : (
          <>
            {doAnimate ? <Rolling value={dispWhole} /> : dispWhole}
            {dispFraction && (
              <span
                style={{ fontSize: Math.round(px * fractionOf), fontWeight: 400, opacity: 0.62 }}
              >
                {doAnimate ? <Rolling value={`.${dispFraction}`} /> : `.${dispFraction}`}
              </span>
            )}
          </>
        )}
      </span>
      {code && (
        <span
          aria-hidden
          style={{ fontSize: Math.round(px * codeOf), fontWeight: 600, color: t.sub }}
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
export function Rolling({ value }: { value: string }) {
  const chars = value.split("");
  return (
    <span style={{ display: "inline-flex", alignItems: "flex-end", whiteSpace: "pre" }}>
      {chars.map((ch, i) => {
        // key by distance from the END, not the start: when a value crosses a
        // grouping boundary ("999" -> "1,000") the units digit must stay in the
        // units column and roll 9->0, not shift left one place and animate to a
        // digit that was never in that slot. from-end keys hold each column to its
        // place value; the new leading digit and comma mount fresh on the left.
        const key = chars.length - 1 - i;
        return ch >= "0" && ch <= "9" ? (
          <RollDigit key={key} digit={Number(ch)} />
        ) : (
          <span key={key} style={{ display: "inline-block", height: "1em", lineHeight: "1em" }}>
            {ch}
          </span>
        );
      })}
    </span>
  );
}

function RollDigit({ digit }: { digit: number }) {
  // a digit that changes blurs for the length of the roll, so the column reads
  // as travelling rather than as ten stacked numbers.
  const [blur, setBlur] = useState(0);
  const [settling, setSettling] = useState(false);
  // the column starts at 0 and travels to its value, so the FIRST paint rolls
  // too, not only later scrubs: the balance visibly tallies up the moment the
  // ledger answers (the null->number transition mounts a fresh Rolling). the
  // rendered transform reads this state, and the effect walks it to `digit` on
  // the next frame so the transition has a from-value to travel from. seeding
  // prev at 0 (not `digit`) is what lets the mount animate rather than snap.
  const [shown, setShown] = useState(0);
  const prev = useRef(0);

  useEffect(() => {
    if (prev.current === digit) return;
    prev.current = digit;
    setBlur(1.2);
    setSettling(false);
    const r = requestAnimationFrame(() => {
      setSettling(true);
      setBlur(0);
      setShown(digit);
    });
    return () => cancelAnimationFrame(r);
  }, [digit]);

  // one gesture, so the travel and the blur settling out of it share a duration
  // and a curve. `motion.roll` is that duration; neither number is chosen here.
  const transition =
    `transform ${motion.roll} ${motion.enter}` +
    (settling ? `, filter ${motion.roll} ${motion.enter}` : "");

  return (
    <span
      style={{
        display: "inline-block",
        height: "1em",
        overflow: "hidden",
        verticalAlign: "bottom",
      }}
    >
      <span
        style={{
          display: "flex",
          flexDirection: "column",
          transform: `translateY(${-shown}em)`,
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
  hidden = false,
}: {
  t: Theme;
  value: string | null;
  code: string;
  treatment?: Treatment;
  hidden?: boolean;
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
        <span
          role="status"
          aria-live="polite"
          style={{ display: "block", width: 190, maxWidth: "100%" }}
        >
          <span style={EXACT}>Reading the ledger</span>
          <span
            aria-hidden
            className="pocket-skeleton"
            style={{ display: "block", width: "100%", height: 38 }}
          />
        </span>
      ) : (
        <Amount
          t={t}
          value={value}
          code={code}
          size="hero"
          treatment={treatment}
          animate
          hidden={hidden}
        />
      )}
    </div>
  );
}
