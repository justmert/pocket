// the value chart, and the tabs that choose its range.
//
// what the line means is decided in core/chain/portfolio.ts, not here:
// balance_at(t) * price_at(t), which is a real history rather than today's
// holdings priced backwards. this file only draws it.
//
// it draws NOTHING when there is nothing real to draw. an empty series is a
// wallet that could not read enough, and a flat line at zero would say "you had
// nothing", which is a claim about the user rather than about the request. a
// stretch that predates the account IS drawn at zero, because that one is true.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { motion, radius, space, text, type Theme } from "./theme";
import { Skeleton } from "./primitives";
import type { ValueChart } from "../../../core/messages";

export const RANGE_IDS = ["1D", "1W", "1M", "6M", "1Y"] as const;
export type RangeId = (typeof RANGE_IDS)[number];

const HEIGHT = 92;

/** map a series into svg space, with a flat series sitting on the baseline. */
function points(values: number[], width: number, height: number): [number, number][] {
  const n = values.length;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  // a series that never moves has no range to normalise against. drawn low in
  // the box rather than through the middle, so "this did not change" does not
  // look like "this hovered around its average".
  const span = hi - lo;
  const pad = 6;
  const usable = height - pad * 2;
  return values.map((v, i) => [
    n === 1 ? width / 2 : (i / (n - 1)) * width,
    span === 0 ? height - pad : pad + (1 - (v - lo) / span) * usable,
  ]);
}

/** a smooth path through the points, which reads as a curve rather than a graph. */
function pathOf(pts: [number, number][]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0]![0]},${pts[0]![1]}`;
  let d = `M${pts[0]![0]},${pts[0]![1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]!;
    const [x1, y1] = pts[i]!;
    const mx = (x0 + x1) / 2;
    d += ` C${mx},${y0} ${mx},${y1} ${x1},${y1}`;
  }
  return d;
}

/**
 * the line, with an area under it and an optional scrub.
 *
 * `onScrub` reports the touched index so the hero figure can show the value at
 * that moment. it reports null on release, and the caller goes back to the
 * present: a chart you have stopped touching must not leave a stale number
 * standing where the current balance belongs.
 */
export function Sparkline({
  t,
  values,
  width,
  height = HEIGHT,
  onScrub,
}: {
  t: Theme;
  values: number[];
  width: number;
  height?: number;
  onScrub?: (index: number | null) => void;
}) {
  const [at, setAt] = useState<number | null>(null);
  const box = useRef<SVGSVGElement>(null);
  const id = `chart-${t.pocket}`;

  if (values.length < 2) return null;

  const pts = points(values, width, height);
  const line = pathOf(pts);
  const area = `${line} L${width},${height} L0,${height} Z`;

  const report = (index: number | null) => {
    setAt(index);
    onScrub?.(index);
  };

  const track = (clientX: number) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    report(Math.round(frac * (values.length - 1)));
  };

  const dot = at === null ? null : pts[Math.min(at, pts.length - 1)]!;

  return (
    <svg
      ref={box}
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      // decorative: the figure above it is the number, and it is already read
      // out. a screen reader announcing ninety-six sample values would bury it.
      aria-hidden
      style={{ display: "block", touchAction: "none", cursor: onScrub ? "col-resize" : "default" }}
      onPointerDown={(e) => {
        if (!onScrub) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        track(e.clientX);
      }}
      onPointerMove={(e) => {
        if (!onScrub || at === null) return;
        track(e.clientX);
      }}
      onPointerUp={() => report(null)}
      onPointerCancel={() => report(null)}
      onPointerLeave={() => report(null)}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={t.accent} stopOpacity={t.dark ? 0.34 : 0.28} />
          <stop offset="100%" stopColor={t.accent} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={t.accent}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {dot && (
        <>
          <line x1={dot[0]} y1={0} x2={dot[0]} y2={height} stroke={t.line} strokeWidth={1} />
          <circle cx={dot[0]} cy={dot[1]} r={4} fill={t.accent} stroke={t.bg} strokeWidth={2} />
        </>
      )}
    </svg>
  );
}

/** the range tabs. */
export function RangeTabs({
  t,
  value,
  onChange,
}: {
  t: Theme;
  value: RangeId;
  onChange: (r: RangeId) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label="Chart range"
      style={{ display: "flex", gap: space.xs, justifyContent: "space-between" }}
    >
      {RANGE_IDS.map((r) => {
        const on = r === value;
        return (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(r)}
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              flex: 1,
              textAlign: "center",
              padding: `6px 0`,
              borderRadius: radius.pill,
              ...text.rowSub,
              fontWeight: 700,
              color: on ? (t.dark ? t.accent : t.text) : t.faint,
              background: on ? t.accentSoft : "transparent",
              transition: `background ${motion.instant} ${motion.enter}, color ${motion.instant} ${motion.enter}`,
            }}
          >
            {r}
          </button>
        );
      })}
    </div>
  );
}

/** the percentage chip beside the figure. */
export function ChangeChip({ t, pct }: { t: Theme; pct: number | null }) {
  // null is not zero. a range that starts before the wallet was funded has no
  // percentage to report, and "0.00%" would claim it held steady at nothing.
  if (pct === null || !Number.isFinite(pct)) return null;
  const up = pct >= 0;
  const tone = up ? t.positive : t.danger;
  return (
    <span
      style={{
        ...text.rowSub,
        fontWeight: 700,
        color: tone,
        background: up ? t.positiveSoft : t.dangerSoft,
        borderRadius: radius.pill,
        padding: "4px 10px",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {up ? "▲" : "▼"} {Math.abs(pct).toFixed(2)}%
    </span>
  );
}

/**
 * the whole block: chart, tabs, and whatever it has to say when there is no
 * chart to show.
 */
export function ValueChartBlock({
  t,
  chart,
  loading,
  range,
  onRange,
  onScrub,
  width,
  style,
}: {
  t: Theme;
  chart: ValueChart | null;
  loading: boolean;
  range: RangeId;
  onRange: (r: RangeId) => void;
  onScrub?: (index: number | null) => void;
  width: number;
  style?: CSSProperties;
}) {
  const values = chart?.points.map((p) => p.value) ?? [];
  const drawable = values.length >= 2;

  // the tabs stay while a range is loading, so switching does not collapse the
  // block and shove everything below it up the screen.
  return (
    <div style={style}>
      <div style={{ height: HEIGHT, display: "flex", alignItems: "center" }}>
        {drawable ? (
          <Sparkline t={t} values={values} width={width} onScrub={onScrub} />
        ) : loading ? (
          // a shimmer, not an empty box. the chart reserves 92px whatever
          // happens, and left blank that gap reads as a rendering fault rather
          // than as work in progress. this is the same skeleton the balance and
          // the asset list use while they wait.
          <Skeleton width="100%" height={HEIGHT - 24} />
        ) : (
          <div style={{ ...text.caption, color: t.faint }}>
            {/* said plainly rather than left as an empty box. the wallet works
                without a chart, and someone who can see their balance but no
                curve should know which of the two is missing. */}
            No price history to chart yet.
          </div>
        )}
      </div>
      <div style={{ marginTop: space.sm }}>
        <RangeTabs t={t} value={range} onChange={onRange} />
      </div>
    </div>
  );
}

/**
 * re-fetch the chart whenever the range, or what is being charted, changes.
 *
 * `subject` is a plain string rather than a dependency array on purpose: an
 * array literal is a new value on every render, so a hook keyed on one refetches
 * forever. the caller names what it is charting ("home", "XLM") and the effect
 * runs when that name or the range changes, and at no other time.
 */
export function useValueChart(
  subject: string,
  fetcher: (range: RangeId) => Promise<ValueChart>,
): {
  chart: ValueChart | null;
  loading: boolean;
  range: RangeId;
  setRange: (r: RangeId) => void;
} {
  const [range, setRange] = useState<RangeId>("1W");
  const [chart, setChart] = useState<ValueChart | null>(null);
  const [loading, setLoading] = useState(true);
  // held in a ref so a caller passing an inline arrow does not restart the
  // effect on every render.
  const fetch = useRef(fetcher);
  fetch.current = fetcher;

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetch
      .current(range)
      .then((c) => {
        // a late answer for a range the user has already left must not paint
        // over the one they are looking at.
        if (live) setChart(c);
      })
      .catch(() => {
        if (live) setChart(null);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [range, subject]);

  return { chart, loading, range, setRange };
}
