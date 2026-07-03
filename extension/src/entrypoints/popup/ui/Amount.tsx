// amounts.
//
// stellar carries seven decimals, so a balance is long and the interesting part
// is at the front. the whole number is set at full size and the fraction sits
// under it in the same tabular figures at a smaller size: the value is complete,
// and it is still readable at a glance.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { fontSizes, motion, radius, space, type Theme } from "./theme";

export type Treatment = "plain" | "sealed" | "exposed";

const SIZES = {
  hero: fontSizes.hero,
  display: fontSizes.display,
  row: fontSizes.body,
  inline: fontSizes.small,
} as const;

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
  const px = SIZES[size];
  const big = size === "hero" || size === "display";

  const tones: Record<Treatment, CSSProperties> = {
    plain: { color: t.text },
    sealed: { color: t.text },
    exposed: { color: t.exposed },
  };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "baseline",
        gap: Math.round(px * 0.14),
        fontVariantNumeric: "tabular-nums",
        letterSpacing: big ? "-0.03em" : undefined,
        fontWeight: big ? 800 : 700,
        fontSize: px,
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
        {animate ? <Rolling value={whole} /> : whole}
        {fraction && (
          <span style={{ fontSize: Math.round(px * (big ? 0.5 : 0.85)), opacity: 0.62 }}>
            .{fraction}
          </span>
        )}
      </span>
      {code && (
        <span
          aria-hidden
          style={{ fontSize: Math.round(px * (big ? 0.4 : 0.85)), fontWeight: 700, color: t.sub }}
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

/** a confidential amount, marked as one wherever it is shown. */
export function SealedAmount({
  t,
  value,
  code,
  size = "row",
  animate = false,
}: {
  t: Theme;
  value: string;
  code?: string;
  size?: keyof typeof SIZES;
  animate?: boolean;
}) {
  return <Amount t={t} value={value} code={code} size={size} treatment="sealed" animate={animate} />;
}

/**
 * an amount that is public, or is about to become one.
 *
 * the tint is reserved for exactly that and appears nowhere else, so it stays a
 * signal rather than decoration.
 */
export function ExposedAmount({
  t,
  value,
  code,
  size = "row",
}: {
  t: Theme;
  value: string;
  code?: string;
  size?: keyof typeof SIZES;
}) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: `2px ${space.xs}px`,
        borderRadius: radius.sm,
        background: t.exposedSoft,
      }}
    >
      <Amount t={t} value={value} code={code} size={size} treatment="exposed" />
    </span>
  );
}

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

  const transition =
    `transform 560ms ${motion.enter}` + (settling ? ", filter 560ms ease-out" : "");

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
        minHeight: Math.round(fontSizes.hero * 1.12),
        display: "flex",
        alignItems: "center",
        marginBottom: space.xs,
      }}
    >
      {value === null ? (
        // a shimmer says "not yet" to someone looking. it says nothing at all to
        // someone listening, so the same fact is spelled out for them.
        <span role="status" aria-live="polite" style={{ display: "block", width: 190 }}>
          <span style={EXACT}>Reading the ledger</span>
          <span aria-hidden className="pocket-skeleton" style={{ display: "block", width: 190, height: 38 }} />
        </span>
      ) : (
        <Amount t={t} value={value} code={code} size="hero" treatment={treatment} animate />
      )}
    </div>
  );
}
