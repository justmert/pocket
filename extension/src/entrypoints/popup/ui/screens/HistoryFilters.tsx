// the two ways the activity list is narrowed: a date range and a set of types.
//
// both are filters over what is LOADED (the contract has no server-side filter),
// the same honest narrowing the search box does. the labels ("Today", month
// names) are all computed from the real clock, never stored.
import { useEffect, useState } from "react";
import { DATE_LOCALE } from "../period";
import type { ReactNode } from "react";
import { Sheet, Button } from "../primitives";
import { Back, ChevronRight, ArrowDown, Send, Shield, Unshield } from "../icons";
import { radius, space, text, type Theme } from "../theme";
import type { HistoryEntry } from "../../../../core/messages";

export type FilterCategory = "received" | "sent" | "movedIn" | "movedOut";
/** epoch-ms day bounds; null when that end is open. */
export type DateRange = { start: number | null; end: number | null };

/** which filter chip an entry answers to, or null when it is uncategorised
 *  (setup / make-spendable), which no chip claims. */
export function categoryOf(e: Pick<HistoryEntry, "kind" | "direction">): FilterCategory | null {
  switch (e.kind) {
    case "receive":
    case "privateReceive":
    case "create":
      return "received";
    case "send":
    case "privateSend":
      return "sent";
    // A swap is the one kind with a leg in each direction, so it cannot be
    // filed by kind alone: it files under whichever leg this entry is. Taking
    // the entry rather than the bare kind is what makes that expressible.
    // Returning null instead would hide BOTH legs whenever any type filter is
    // on, which is how a filtered list comes to assert that a swap the user
    // made never happened.
    case "swap":
      return e.direction === "in" ? "received" : "sent";
    case "shield":
      return "movedIn";
    case "unshield":
      return "movedOut";
    default:
      return null;
  }
}

const CATS: { key: FilterCategory; label: string; icon: ReactNode }[] = [
  { key: "received", label: "Received", icon: <ArrowDown size={20} /> },
  { key: "sent", label: "Sent", icon: <Send size={20} /> },
  { key: "movedIn", label: "Shielded", icon: <Shield size={20} /> },
  { key: "movedOut", label: "Unshielded", icon: <Unshield size={20} /> },
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const MONTHS_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

const dayMs = (y: number, m: number, d: number): number => new Date(y, m, d).getTime();
const endOfDay = (ms: number): number => {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999).getTime();
};
const fmtDay = (ms: number): string =>
  new Date(ms).toLocaleDateString(DATE_LOCALE, { month: "short", day: "numeric", year: "numeric" });

/** a small text link, for Clear / Clear all. */
function LinkButton({
  t,
  onClick,
  children,
}: {
  t: Theme;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        cursor: "pointer",
        color: t.accent,
        ...text.button,
      }}
    >
      {children}
    </button>
  );
}

/** the type filter: a 2x2 of chips, applied together. */
export function TypeFilterSheet({
  t,
  open,
  value,
  pocket,
  onClose,
  onApply,
}: {
  t: Theme;
  open: boolean;
  value: Set<FilterCategory>;
  /** which pocket's stream is being filtered; two categories only exist in one. */
  pocket: "public" | "private";
  onClose: () => void;
  onApply: (v: Set<FilterCategory>) => void;
}) {
  const [sel, setSel] = useState<Set<FilterCategory>>(new Set(value));
  useEffect(() => {
    if (open) setSel(new Set(value));
  }, [open]);

  const toggle = (k: FilterCategory) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });

  return (
    <Sheet
      t={t}
      open={open}
      onClose={onClose}
      title="Filters"
      footer={
        <Button
          t={t}
          onClick={() => {
            onApply(new Set(sel));
            onClose();
          }}
        >
          Apply filters
        </Button>
      }
    >
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          marginTop: -space.xs,
          marginBottom: space.md,
        }}
      >
        <LinkButton t={t} onClick={() => setSel(new Set())}>
          Clear all
        </LinkButton>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: space.sm }}>
        {/* Shielded and Unshielded are produced only by PRIVATE entries, so in
            the public pocket either chip guarantees an empty list, and the empty
            list then drives the auto-pager through up to twenty pages while the
            screen reads "Still reading older history". a filter that cannot match
            is not a filter. */}
        {CATS.filter((c) => pocket === "private" || (c.key !== "movedIn" && c.key !== "movedOut")).map((c) => {
          const on = sel.has(c.key);
          return (
            <button
              key={c.key}
              type="button"
              aria-pressed={on}
              onClick={() => toggle(c.key)}
              className="pk-tap"
              style={{
                all: "unset",
                boxSizing: "border-box",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                gap: space.sm,
                padding: `${space.md}px ${space.md}px`,
                borderRadius: radius.lg,
                background: on ? t.accent : t.field,
                color: on ? t.onAccent : t.dark ? t.accent : t.text,
                ...text.button,
              }}
            >
              {c.icon}
              <span style={{ color: on ? t.onAccent : t.text }}>{c.label}</span>
            </button>
          );
        })}
      </div>
      <div style={{ height: space.sm }} />
    </Sheet>
  );
}

/** the date range: a month calendar, a start bound and an end bound. */
export function DateRangeSheet({
  t,
  open,
  value,
  onClose,
  onApply,
}: {
  t: Theme;
  open: boolean;
  value: DateRange;
  onClose: () => void;
  onApply: (r: DateRange) => void;
}) {
  const [start, setStart] = useState<number | null>(value.start);
  const [end, setEnd] = useState<number | null>(value.end);
  const [picking, setPicking] = useState<"start" | "end">("start");
  const [viewY, setViewY] = useState(new Date().getFullYear());
  const [viewM, setViewM] = useState(new Date().getMonth());
  // three drill-down views: the day grid, the month grid (tap the month/year), and
  // the year grid (tap the year). that is how you cross years without hammering an
  // arrow. `yearBase` is the first year of the 12-year block the year grid shows.
  const [view, setView] = useState<"days" | "months" | "years">("days");
  const [yearBase, setYearBase] = useState(new Date().getFullYear() - 11);

  useEffect(() => {
    if (!open) return;
    setStart(value.start);
    setEnd(value.end);
    setPicking("start");
    setView("days");
    const base = value.start !== null ? new Date(value.start) : new Date();
    setViewY(base.getFullYear());
    setViewM(base.getMonth());
  }, [open]);

  // activity is history: no entry can be dated in the future, so days past today
  // are not selectable and the grid marks where the timeline ends.
  const nowDate = new Date();
  const todayMs = endOfDay(nowDate.getTime());
  const todayStartMs = dayMs(nowDate.getFullYear(), nowDate.getMonth(), nowDate.getDate());

  const daysInMonth = new Date(viewY, viewM + 1, 0).getDate();
  const firstDow = new Date(viewY, viewM, 1).getDay();
  const cells: (number | null)[] = [
    ...Array<null>(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];

  const shiftMonth = (delta: number) => {
    const total = viewM + delta;
    setViewY(viewY + Math.floor(total / 12));
    setViewM(((total % 12) + 12) % 12);
  };
  // no entry can be dated in the future, so months and years past today are dead.
  const curY = nowDate.getFullYear();
  const curM = nowDate.getMonth();
  // opening the year grid shows the 12-year block that ends on the viewed year.
  const openYears = () => {
    setYearBase(viewY - 11);
    setView("years");
  };
  const monthFuture = (m: number) => viewY > curY || (viewY === curY && m > curM);
  const yearFuture = (y: number) => y > curY;
  // the "next" (forward-in-time) arrow is dead once it would cross into the future.
  // the arrows step by MONTH in the day grid, by YEAR in the month grid, and by a
  // 12-year BLOCK in the year grid.
  const nextDisabled =
    view === "days"
      ? viewY > curY || (viewY === curY && viewM >= curM)
      : view === "months"
        ? viewY >= curY
        : yearBase + 11 >= curY;
  const onPrev = () => {
    if (view === "days") shiftMonth(-1);
    else if (view === "months") setViewY((y) => y - 1);
    else setYearBase((b) => b - 12);
  };
  const onNext = () => {
    if (nextDisabled) return;
    if (view === "days") shiftMonth(1);
    else if (view === "months") setViewY((y) => y + 1);
    else setYearBase((b) => b + 12);
  };

  const pick = (day: number) => {
    const ms = dayMs(viewY, viewM, day);
    // picking an END with no start yet is the same gesture as picking a start,
    // and it used to fill a day in the grid while leaving the primary button
    // disabled with nothing saying why: `apply` returns early on a null start and
    // both footer branches are `disabled={start === null}`. reachable without
    // ever pressing Clear (tap "End", tap a day), so it is its own path.
    if (picking === "start" || start === null) {
      setStart(ms);
      if (end !== null && ms > end) setEnd(null);
    } else if (ms < start) {
      // an end before the start just becomes the new start.
      setEnd(start);
      setStart(ms);
    } else {
      setEnd(ms);
    }
  };

  const selected = (day: number): "start" | "end" | "mid" | null => {
    const ms = dayMs(viewY, viewM, day);
    if (ms === start) return "start";
    if (ms === end) return "end";
    if (start !== null && end !== null && ms > start && ms < end) return "mid";
    return null;
  };

  const apply = () => {
    if (start === null) return;
    onApply({ start, end: end !== null ? endOfDay(end) : endOfDay(start) });
    onClose();
  };
  const clear = () => {
    setStart(null);
    setEnd(null);
    setPicking("start");
    // and APPLY the cleared range, which is the whole point of the control.
    // it only reset local state, and both footer branches are disabled while
    // `start === null`, so after pressing Clear there was no live button left to
    // commit it with: closing the sheet discarded it and the mount effect put
    // the still-applied range back on reopen. the only ways out were leaving
    // Activity or the "Clear filters" button that appears solely when the
    // narrowing matches nothing. the sibling sheet in this same file gets it
    // right and carried no note about the difference.
    onApply({ start: null, end: null });
    onClose();
  };

  const summary =
    start !== null
      ? `${fmtDay(start)}${end !== null ? ` – ${fmtDay(end)}` : ""}`
      : "Pick a start date";

  return (
    <Sheet
      t={t}
      open={open}
      onClose={onClose}
      title="Date range"
      footer={
        picking === "start" ? (
          <Button t={t} disabled={start === null} onClick={() => setPicking("end")}>
            Next
          </Button>
        ) : (
          <Button t={t} disabled={start === null} onClick={apply}>
            Apply date range
          </Button>
        )
      }
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: -space.xs,
          marginBottom: space.md,
        }}
      >
        <span style={{ ...text.rowSub, color: t.sub }}>{summary}</span>
        <LinkButton t={t} onClick={clear}>
          Clear
        </LinkButton>
      </div>

      {/* start / end segmented control */}
      <div
        role="group"
        aria-label="Date bound"
        style={{
          display: "flex",
          gap: 4,
          background: t.field,
          borderRadius: radius.pill,
          padding: 4,
          marginBottom: space.lg,
        }}
      >
        {(["start", "end"] as const).map((p) => {
          const on = picking === p;
          return (
            <button
              key={p}
              type="button"
              aria-pressed={on}
              onClick={() => setPicking(p)}
              className="pk-tap"
              style={{
                all: "unset",
                boxSizing: "border-box",
                flex: 1,
                textAlign: "center",
                cursor: "pointer",
                // the SAME segment as the history pocket toggle one screen away:
                // identical pill-in-track shape, and this copy was the only one at
                // `text.chip` 14/600 against the other two at `text.pocketTab`
                // 16/700, with a different vertical padding as well.
                padding: "8px 0",
                borderRadius: radius.pill,
                background: on ? t.accent : "transparent",
                color: on ? t.onAccent : t.sub,
                ...text.pocketTab,
              }}
            >
              {/* sentence case, like every other control in the product. */}
              {p === "start" ? "Start date" : "End date"}
            </button>
          );
        })}
      </div>

      {/* the header, and how you cross time without hammering an arrow. the label is
          a DRILL-DOWN button: in the day grid it is "March 2026" and opens the month
          grid; in the month grid it is "2026" and opens the year grid; in the year
          grid it is the block range and does not drill further. the arrows step by the
          unit the current grid shows: one month, one year, or a 12-year block. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: space.md,
        }}
      >
        {view === "years" ? (
          <span style={{ ...text.heading, color: t.text }}>
            {yearBase} – {yearBase + 11}
          </span>
        ) : (
          <button
            type="button"
            onClick={view === "days" ? () => setView("months") : openYears}
            aria-label={view === "days" ? "Choose a month" : "Choose a year"}
            style={{
              all: "unset",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: 6,
              ...text.heading,
              color: t.text,
            }}
          >
            {view === "days" ? `${MONTHS[viewM]} ${viewY}` : viewY}
            <span aria-hidden style={{ color: t.accent, display: "flex" }}>
              <ChevronRight size={17} />
            </span>
          </button>
        )}
        <div style={{ display: "flex", gap: space.sm, color: t.accent }}>
          <button
            type="button"
            aria-label={
              view === "days"
                ? "Previous month"
                : view === "months"
                  ? "Previous year"
                  : "Earlier years"
            }
            onClick={onPrev}
            // the commit that gave `.pk-tap` to every calendar day, month and
            // year cell did not give it to the two arrows that page between them.
            className="pk-tap"
            style={{ all: "unset", cursor: "pointer", display: "flex", padding: 4 }}
          >
            <Back size={20} />
          </button>
          <button
            type="button"
            aria-label={
              view === "days" ? "Next month" : view === "months" ? "Next year" : "Later years"
            }
            disabled={nextDisabled}
            onClick={nextDisabled ? undefined : onNext}
            className="pk-tap"
            style={{
              all: "unset",
              cursor: nextDisabled ? "default" : "pointer",
              display: "flex",
              padding: 4,
              opacity: nextDisabled ? 0.35 : 1,
            }}
          >
            <ChevronRight size={20} />
          </button>
        </div>
      </div>

      {view === "days" ? (
        <>
          {/* weekday header */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", marginBottom: 4 }}>
            {WEEKDAYS.map((d) => (
              <span key={d} style={{ ...text.caption, color: t.faint, textAlign: "center" }}>
                {d}
              </span>
            ))}
          </div>

          {/* the day grid */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2 }}>
            {cells.map((day, i) => {
              if (day === null) return <span key={`b-${i}`} />;
              const ms = dayMs(viewY, viewM, day);
              const sel = selected(day);
              const filled = sel === "start" || sel === "end";
              const future = ms > todayMs;
              const isToday = ms === todayStartMs;
              return (
                <button
                  key={day}
                  type="button"
                  disabled={future}
                  className="pk-tap"
                  onClick={future ? undefined : () => pick(day)}
                  style={{
                    all: "unset",
                    boxSizing: "border-box",
                    cursor: future ? "default" : "pointer",
                    height: 38,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.md,
                    background: filled ? t.accent : sel === "mid" ? t.accentSoft : "transparent",
                    // today is anchored with a hairline so the selectable edge is legible.
                    border: isToday && !filled ? `1px solid ${t.accentLine}` : undefined,
                    color: filled ? t.onAccent : future ? t.faint : t.text,
                    ...text.body,
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>
        </>
      ) : view === "months" ? (
        // the month grid: pick a month and it drops back to that month's days. the
        // chosen month wears the SAME solid accent a picked day does, not the pale
        // range-fill: this is a selection, and a selection is filled, so the grids
        // never disagree about what "chosen" looks like.
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: space.sm }}>
          {MONTHS_SHORT.map((m, idx) => {
            const on = idx === viewM;
            const future = monthFuture(idx);
            return (
              <button
                key={m}
                type="button"
                disabled={future}
                className="pk-tap"
                onClick={
                  future
                    ? undefined
                    : () => {
                        setViewM(idx);
                        setView("days");
                      }
                }
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: future ? "default" : "pointer",
                  height: 52,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.md,
                  background: on ? t.accent : "transparent",
                  color: on ? t.onAccent : future ? t.faint : t.text,
                  ...text.body,
                  fontWeight: on ? 600 : 400,
                }}
              >
                {m}
              </button>
            );
          })}
        </div>
      ) : (
        // the year grid: a 12-year block, picked the same way a month is. the chosen
        // year carries the solid accent, tapping it drops to that year's months.
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: space.sm }}>
          {Array.from({ length: 12 }, (_, i) => yearBase + i).map((y) => {
            const on = y === viewY;
            const future = yearFuture(y);
            return (
              <button
                key={y}
                type="button"
                disabled={future}
                className="pk-tap"
                onClick={
                  future
                    ? undefined
                    : () => {
                        setViewY(y);
                        setView("months");
                      }
                }
                style={{
                  all: "unset",
                  boxSizing: "border-box",
                  cursor: future ? "default" : "pointer",
                  height: 52,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.md,
                  background: on ? t.accent : "transparent",
                  color: on ? t.onAccent : future ? t.faint : t.text,
                  ...text.body,
                  fontWeight: on ? 600 : 400,
                }}
              >
                {y}
              </button>
            );
          })}
        </div>
      )}
      <div style={{ height: space.sm }} />
    </Sheet>
  );
}
