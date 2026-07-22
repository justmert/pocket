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
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DATE_LOCALE } from "./period";
import type { CSSProperties } from "react";
import { motion, radius, space, text, type Theme } from "./theme";
import { Skeleton } from "./primitives";
import type { ValueChart } from "../../../core/messages";

export const RANGE_IDS = ["1D", "1W", "1M", "6M", "1Y"] as const;
export type RangeId = (typeof RANGE_IDS)[number];

const HEIGHT = 92;

/** cap a series to a range-appropriate point count so a dense feed reads as a
 *  smooth curve rather than noise: roughly hourly for a day, and a self-chosen
 *  ratio for the wider ranges. endpoints are kept, so the curve still starts and
 *  ends on the real values the headline reads. */
const TARGET_POINTS: Record<RangeId, number> = { "1D": 24, "1W": 28, "1M": 30, "6M": 26, "1Y": 24 };
function decimateChart(c: ValueChart, range: RangeId): ValueChart {
  const n = c.points.length;
  const target = TARGET_POINTS[range];
  if (n <= target || target < 2) return c;
  const points = [];
  for (let i = 0; i < target; i++) {
    points.push(c.points[Math.round((i * (n - 1)) / (target - 1))]!);
  }
  return { ...c, points };
}

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

/** linearly resample a series to exactly n points, so two curves can tween 1:1. */
function resample(arr: number[], n: number): number[] {
  if (arr.length === n) return arr.slice();
  if (arr.length < 2) return new Array(n).fill(arr[0] ?? 0);
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * (arr.length - 1);
    const a = Math.floor(x);
    const b = Math.min(arr.length - 1, a + 1);
    out.push(arr[a]! + (arr[b]! - arr[a]!) * (x - a));
  }
  return out;
}

/** the moment a touched point falls on, worded by how wide the range is. */
export function rangeLabel(range: RangeId): (ms: number) => string {
  return (ms) => {
    const d = new Date(ms);
    if (range === "1D") return d.toLocaleTimeString(DATE_LOCALE, { hour: "2-digit", minute: "2-digit" });
    if (range === "1Y") return d.toLocaleDateString(DATE_LOCALE, { month: "short", year: "numeric" });
    return d.toLocaleDateString(DATE_LOCALE, { month: "short", day: "numeric" });
  };
}

/**
 * the line, with an area under it and an optional scrub.
 *
 * scrubbing does three things, all of which the reference does and the first
 * port did not: it GREYS the line past the touched point, so the eye reads
 * "here, and everything after is later"; it drops a dot on the point; and it
 * floats a pill naming the moment. the VALUE at that moment is shown by the
 * caller in the headline figure, so the pill carries the time and the figure
 * carries the money, which is how the reference splits it too.
 *
 * `onScrub` reports the touched index and reports null on release, so the
 * headline returns to the present: a chart nobody is touching must not leave a
 * past number where the current balance belongs.
 */
export function Sparkline({
  t,
  values,
  times,
  width,
  height = HEIGHT,
  onScrub,
  labelAt,
}: {
  t: Theme;
  values: number[];
  /** the moment each value falls on, parallel to `values`. */
  times?: number[];
  width: number;
  height?: number;
  onScrub?: (index: number | null) => void;
  labelAt?: (ms: number) => string;
}) {
  const [at, setAt] = useState<number | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const id = `chart-${t.pocket}`;

  // the chart draws to its ACTUAL width, not a fixed 384: the passed `width` is a
  // ceiling, and when the frame collapses under it (chrome zooms to 500%, leaving
  // the popup ~160px) the container is narrower, so the curve reflows into it
  // rather than overflowing the clipped frame. at the normal width the measured
  // value is the ceiling, so nothing changes there.
  const [measured, setMeasured] = useState(width);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const read = () => setMeasured(el.clientWidth || width);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  const w = Math.min(measured, width);

  // the curve MORPHS to a new series on a range switch, instead of snapping. each
  // frame tweens the old shape toward the new one, so 1D flowing into 1W reads as
  // the line reshaping rather than a hard cut. keyed on a cheap signature of the
  // series so it only re-runs when the data actually changes.
  const [display, setDisplay] = useState<number[]>(values);
  const displayRef = useRef(display);
  displayRef.current = display;
  const raf = useRef<number | undefined>(undefined);
  const sig = values.length ? `${values.length}:${values[0]}:${values[values.length - 1]}` : "none";
  useEffect(() => {
    if (values.length < 2) {
      setDisplay(values);
      return;
    }
    // the morph is a JS rAF tween, so the stylesheet's prefers-reduced-motion block
    // cannot reach it; honour the preference here by landing on the new series at
    // once, the way Avatar's blink does for its own JS motion.
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setDisplay(values);
      return;
    }
    const prev = displayRef.current;
    if (prev.length < 2) {
      setDisplay(values);
      return;
    }
    const N = Math.max(prev.length, values.length);
    const from = resample(prev, N);
    const to = resample(values, N);
    const start = performance.now();
    // ease-OUT, not ease-in-out: an ease-in creeps through its first third, which
    // read as a pause before the line moved at all. out starts at full speed and
    // decelerates, so a range switch feels immediate rather than delayed.
    const DUR = 300;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / DUR);
      if (p >= 1) {
        // land on the real series, not the resampled `to`: `display` then has the
        // same length as `values`, so a scrub after the morph maps its reported
        // index onto the right point instead of onto a stretched copy.
        setDisplay(values);
        return;
      }
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      setDisplay(from.map((v, i) => v + (to[i]! - v) * e));
      raf.current = requestAnimationFrame(tick);
    };
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [sig]);

  if (values.length < 2) return null;

  // draw the morphing series while idle; the moment a scrub is live, draw the
  // REAL series instead. during a morph `display` is resampled to the longer of
  // the two curves, so its indices no longer line up with the value the scrub
  // reports; drawing `values` under the cursor keeps the dot, the grey split and
  // the pill all on the point the pointer is actually over.
  const active = at !== null;
  const series = active ? values : display.length >= 2 ? display : values;
  const pts = points(series, w, height);
  const area = `${pathOf(pts)} L${w},${height} L0,${height} Z`;
  // the muted stop, now that the type neutrals are themselves grey: past the
  // cursor is "behind you" and should not compete with the accent ahead of it.
  const muted = t.hairline;

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

  const cut = active ? Math.min(at, pts.length - 1) : 0;
  const dot = active ? pts[cut]! : null;
  // the pill is clamped off the edges so it never clips at the ends of a scrub.
  //
  // by its OWN half-width, measured, not by a literal 30. with `translateX(-50%)`
  // a 30px clamp only holds while the pill is at most 60px wide, and the padding
  // alone is 18px: the en-US 1D label "03:04 PM" already exceeds it, so every
  // label longer than about six characters clipped at both ends of every scrub,
  // under a comment saying it never does.
  const pill = useRef<HTMLDivElement>(null);
  const [pillW, setPillW] = useState(60);
  useLayoutEffect(() => {
    const el = pill.current;
    if (el) setPillW(el.offsetWidth);
  }, [label]);
  const half = pillW / 2 + 2;
  const pillX = dot ? Math.max(half, Math.min(w - half, dot[0])) : 0;
  const label = active && times && labelAt ? labelAt(times[Math.min(at, times.length - 1)]!) : null;

  return (
    <div
      ref={box}
      style={{
        position: "relative",
        // fluid up to the ceiling: fills the frame at normal size, shrinks with it
        // at high zoom. the drawing width `w` is measured from this box.
        width: "100%",
        maxWidth: width,
        touchAction: "none",
        // no cursor change on hover: the reveal follows the pointer, and swapping
        // the cursor to a resize handle read as "you can drag this", which is not
        // what a hover does.
      }}
      // HOVER, not hold-and-drag. a mouse tracks the line just by moving over
      // it; there is nothing to press. a touch, which has no hover, tracks while
      // a finger is down and lets go when it lifts. either way the reveal
      // follows the pointer rather than a gesture.
      onPointerMove={(e) => {
        if (!onScrub) return;
        track(e.clientX);
      }}
      onPointerDown={(e) => {
        if (!onScrub) return;
        track(e.clientX);
      }}
      onPointerLeave={() => report(null)}
      onPointerUp={() => report(null)}
      onPointerCancel={() => report(null)}
    >
      <svg
        width={w}
        height={height}
        viewBox={`0 0 ${w} ${height}`}
        // decorative: the figure above it is the number, and it is already read
        // out. a screen reader announcing ninety-six samples would bury it.
        aria-hidden
        style={{ display: "block" }}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={t.accent} stopOpacity={t.dark ? 0.34 : 0.28} />
            <stop offset="100%" stopColor={t.accent} stopOpacity={0} />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${id})`} />
        {!active ? (
          <path
            d={pathOf(pts)}
            fill="none"
            stroke={t.accent}
            strokeWidth={2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <>
            {/* past the cursor, greyed; up to it, in the pocket's colour. the
                two share the point at `cut`, so the line stays continuous. */}
            <path
              d={pathOf(pts.slice(cut))}
              fill="none"
              stroke={muted}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <path
              d={pathOf(pts.slice(0, cut + 1))}
              fill="none"
              stroke={t.accent}
              strokeWidth={2.5}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </>
        )}
        {dot && (
          <>
            <line x1={dot[0]} y1={0} x2={dot[0]} y2={height} stroke={t.line} strokeWidth={1} />
            <circle
              cx={dot[0]}
              cy={dot[1]}
              r={4.5}
              fill={t.accent}
              stroke={t.bg}
              strokeWidth={2.5}
            />
          </>
        )}
      </svg>
      {label && (
        <div
          ref={pill}
          aria-hidden
          style={{
            position: "absolute",
            left: pillX,
            top: -4,
            transform: "translateX(-50%)",
            background: t.accentSoft,
            color: t.dark ? t.accent : t.text,
            ...text.chip,
            padding: "3px 9px",
            borderRadius: radius.pill,
            whiteSpace: "nowrap",
            pointerEvents: "none",
          }}
        >
          {label}
        </div>
      )}
    </div>
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
    // aria-pressed toggle buttons, not a tablist: there is no tabpanel and no
    // roving-tabindex/arrow-key model here, and role=tablist would promise "tab,
    // 1 of 5" plus arrow navigation the control does not implement. a group of
    // pressed/unpressed buttons is the honest contract for a range picker.
    <div
      role="group"
      aria-label="Chart range"
      style={{ display: "flex", gap: space.xs, justifyContent: "space-between" }}
    >
      {RANGE_IDS.map((r) => {
        const on = r === value;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(r)}
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              flex: 1,
              display: "flex",
              justifyContent: "center",
              padding: `3px 0`,
            }}
          >
            {/* the pill hugs the label instead of filling the whole cell, so the
                selected background is the width of "1W", not the width of a fifth
                of the row. */}
            <span
              style={{
                padding: `5px 14px`,
                borderRadius: radius.pill,
                ...text.chip,
                color: on ? (t.dark ? t.accent : t.text) : t.faint,
                background: on ? t.accentSoft : "transparent",
                transition: `background ${motion.instant} ${motion.enter}, color ${motion.instant} ${motion.enter}`,
              }}
            >
              {r}
            </span>
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
  //
  // a SCRUB passes null for the length of the gesture, so a chip that unmounted on
  // null flashed out and back on every hover. instead the last real value is held
  // and the chip fades its opacity while the pointer is down, keeping its width so
  // the figure beside it does not jump. it only truly returns null before it has
  // ever had a value to show.
  const held = useRef<number | null>(null);
  const live = pct !== null && Number.isFinite(pct);
  if (live) held.current = pct;
  const shown = held.current;
  if (shown === null) return null;
  const up = shown >= 0;
  const tone = up ? t.positive : t.danger;
  return (
    <span
      style={{
        ...text.chip,
        color: tone,
        background: up ? t.positiveSoft : t.dangerSoft,
        borderRadius: radius.pill,
        padding: "4px 10px",
        whiteSpace: "nowrap",
        fontVariantNumeric: "tabular-nums",
        opacity: live ? 1 : 0,
        transition: `opacity var(--pocket-instant) var(--pocket-enter)`,
      }}
    >
      {up ? "▲" : "▼"} {Math.abs(shown).toFixed(2)}%
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
  bleed = 0,
  style,
}: {
  t: Theme;
  chart: ValueChart | null;
  loading: boolean;
  range: RangeId;
  onRange: (r: RangeId) => void;
  onScrub?: (index: number | null) => void;
  /** the chart's own pixel width, edge to edge. */
  width: number;
  /**
   * how far to pull the chart out past its padded parent, so it spans the frame
   * with no side gutter. the tabs stay inside the padding; only the line bleeds.
   */
  bleed?: number;
  style?: CSSProperties;
}) {
  const values = chart?.points.map((p) => p.value) ?? [];
  const times = chart?.points.map((p) => p.at) ?? [];
  const drawable = values.length >= 2;

  // nothing real to draw and nothing loading: render NOTHING, not a placeholder
  // line and range tabs over an empty box. a fresh account has no value history
  // for any range, and "No price history to chart yet." was the first thing a new
  // user saw under their balance, reading as a fault. the wallet works without a
  // chart; when there is a curve it appears, and until then the space is not taken.
  if (!drawable && !loading) return null;

  // the tabs stay while a range is loading, so switching does not collapse the
  // block and shove everything below it up the screen.
  return (
    <div style={style}>
      <div
        style={{
          height: HEIGHT,
          display: "flex",
          alignItems: "center",
          // the chart bleeds to the frame edges; its own padding lives here so
          // the loading and empty states stay inset with the rest of the column.
          margin: bleed ? `0 -${bleed}px` : undefined,
          paddingLeft: drawable ? 0 : bleed,
          paddingRight: drawable ? 0 : bleed,
        }}
      >
        {drawable ? (
          <Sparkline
            t={t}
            values={values}
            times={times}
            width={width}
            onScrub={onScrub}
            labelAt={rangeLabel(range)}
          />
        ) : (
          // a shimmer, not an empty box. the chart reserves its height whatever
          // happens, and left blank that gap reads as a rendering fault rather
          // than as work in progress. only reached while loading now: the empty
          // case returns null above rather than drawing a placeholder.
          <Skeleton width="100%" height={HEIGHT - 24} />
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
    // the PREVIOUS range's curve goes with the request. it only ever set `chart`
    // on success, so `!drawable` was never true once any chart existed: switching
    // 1W to 1M left the old curve and its percentage on screen, unlabelled, for
    // the whole wait, and the wait is never zero (`valueSeries` awaits `balances`
    // and a per-asset history on every call, uncached).
    setChart(null);
    fetch
      .current(range)
      .then((c) => {
        // a late answer for a range the user has already left must not paint
        // over the one they are looking at.
        if (live) setChart(decimateChart(c, range));
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
