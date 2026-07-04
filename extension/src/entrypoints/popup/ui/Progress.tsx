// progress for an operation that takes minutes.
//
// four steps and the worker's own phase text, never a percentage. a percentage
// would have to be invented, and an invented one that sits at 80% for a minute
// is worse than no number at all. the elapsed clock is real and is what tells
// someone the wallet has not hung.
import { useEffect, useRef, useState } from "react";
import { radius, space, text, type Theme } from "./theme";
import { Spinner } from "./primitives";

const STEPS = ["Prepare", "Prove", "Submit", "Confirm"] as const;

/**
 * which step a worker phase belongs to.
 *
 * matched on the phrases the worker actually emits. an unrecognised phase holds
 * the current step rather than jumping, so a new phase string can never make the
 * bar go backwards.
 */
export function stepOf(phase: string | null): number {
  if (!phase) return 0;
  const p = phase.toLowerCase();
  if (p.includes("verification key") || p.includes("circuit") || p.includes("auditor key")) return 0;
  if (p.includes("proving")) return 1;
  if (p.includes("simulating") || p.includes("signing") || p.includes("submitting")) return 2;
  if (p.includes("making it spendable") || p.includes("confirm")) return 3;
  return 0;
}

export function Progress({
  t,
  phase,
  label,
  fallback,
}: {
  t: Theme;
  /** the worker's current phase, or null before it reports one. */
  phase: string | null;
  /** what is being done, in the words the previous screen used. */
  label: string;
  /**
   * what this operation does, for the stretches where the worker publishes no
   * phase. without it the screen showed four step names and never mentioned the
   * ledger it was waiting on, which is the longest part of the wait.
   */
  fallback: string;
}) {
  const step = stepOf(phase);
  const elapsed = useElapsed();

  return (
    <div role="status" aria-live="polite">
      <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginBottom: space.md }}>
        <Spinner size={18} color={t.accent} />
        <span style={{ ...text.rowTitle, color: t.text, flex: 1, minWidth: 0 }}>{label}</span>
        <span style={{ ...text.caption, color: t.faint, fontVariantNumeric: "tabular-nums" }}>
          {clock(elapsed)}
        </span>
      </div>

      {/* the four steps only appear once the worker is naming them. a stepper
          stuck on its first step for a minute is a worse claim than no stepper. */}
      {phase ? (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6 }}>
          {STEPS.map((name, i) => (
            <div key={name}>
              <div
                className={i === step ? "pocket-pulse" : undefined}
                style={{
                  height: 3,
                  borderRadius: radius.pill,
                  background: i <= step ? t.accent : t.line,
                  transition: "background 300ms ease",
                }}
              />
              <div
                style={{
                  ...text.caption,
                  fontSize: 10,
                  marginTop: 5,
                  color: i === step ? (t.dark ? t.accent : t.text) : t.faint,
                }}
              >
                {name}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div
          className="pocket-pulse"
          style={{ height: 3, borderRadius: radius.pill, background: t.accent }}
        />
      )}

      <div style={{ ...text.body, color: t.sub, marginTop: space.md, lineHeight: 1.45 }}>
        {phase ?? fallback}
      </div>
    </div>
  );
}

/** seconds since this mounted, ticked by a timer rather than read during render. */
function useElapsed(): number {
  const [seconds, setSeconds] = useState(0);
  const start = useRef(0);
  useEffect(() => {
    start.current = performance.now();
    const id = setInterval(() => {
      setSeconds(Math.floor((performance.now() - start.current) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return seconds;
}

function clock(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
