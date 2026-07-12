// the processing view, shown while an approved transaction is in flight.
//
// the mark is the same accent disc the receipt draws its tick in, so success and
// waiting share one shape and the sheet does not jump between two different marks;
// here it holds three dots that pulse in turn rather than a tick. "Processing", and
// the way home, because the work carries on in the worker whether the popup stays
// open or not: the operation is submitted, the user is free to leave, and the
// activity list picks it up in the background.
import { Button } from "./primitives";
import { space, text, type Theme } from "./theme";

export function Progress({
  t,
  title = "Processing",
  subtitle = "Your transaction will continue in the background",
  onGoHome,
}: {
  t: Theme;
  title?: string;
  subtitle?: string;
  /** leaves for home while the worker finishes. absent for a step not yet
   *  submitted (a build), where there is nothing to continue in the background. */
  onGoHome?: () => void;
}) {
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: space.lg,
        padding: `${space.xl}px 0 0`,
      }}
    >
      <ProcessingMark t={t} />

      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 6,
          textAlign: "center",
        }}
      >
        <span style={{ ...text.screenTitle, color: t.text }}>{title}</span>
        <span style={{ ...text.body, fontWeight: 600, color: t.sub }}>{subtitle}</span>
      </div>

      {onGoHome && (
        // stretch, not the centred column's natural width: the way home is the
        // primary action here, so it fills the sheet like every other CTA.
        <div style={{ alignSelf: "stretch", marginTop: space.xs }}>
          <Button t={t} onClick={onGoHome}>
            Go to Home
          </Button>
        </div>
      )}
    </div>
  );
}

/** the receipt's accent disc, waiting: three dots that pulse in turn inside it. one
 *  shape for success and for the wait before it, so the sheet does not swap marks. */
function ProcessingMark({ t, size = 78 }: { t: Theme; size?: number }) {
  const dot = Math.round(size * 0.115);
  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <div
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: t.accent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: Math.round(dot * 0.8),
        }}
      >
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="pocket-proc-dot"
            style={{
              width: dot,
              height: dot,
              borderRadius: "50%",
              background: t.onAccent,
              animationDelay: `${i * 0.16}s`,
            }}
          />
        ))}
      </div>
    </div>
  );
}
