import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { FRAME, fontSizes, leading, motion, radius, sans, space, text, type Theme } from "./theme";

/**
 * The frame's height ceiling, MEASURED. Never `vh`, and never a percentage.
 *
 * A toolbar popup has no size of its own. Chrome gives it a 25x25 minimum and
 * an 800x600 maximum and then sizes it FROM the document, so the viewport is
 * the popup and the popup is the content. `100vh` closes that loop: on the
 * first layout it resolved against the 25px minimum, capped this frame at 25,
 * and Chrome sized the popup to the frame it had just crushed. The wallet
 * opened as a 3px sliver of its own header, with nothing in the console to say
 * why, and it stayed that way because a crushed frame gives Chrome no reason to
 * grow. Verified against Chrome's documented popup sizing, not inferred from
 * the symptom.
 *
 * Every e2e test passed throughout, because all of them open popup.html as a
 * TAB, where the viewport is the window, `100vh` is 600-plus and no cap ever
 * bites. The action popup is a layout mode the suite had never entered.
 *
 * A resize is the platform saying it has settled on a size, so it is the only
 * thing trusted here. Before the first one there is no cap at all, which is
 * exactly what lets Chrome measure this frame at its natural height and size
 * the popup to fit it.
 */
function usePopupHeightCap(): number | undefined {
  const [cap, setCap] = useState<number | undefined>(undefined);
  useEffect(() => {
    const measure = () => setCap(window.innerHeight);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return cap;
}

export function Frame({ t, children }: { t: Theme; children: ReactNode }) {
  const cap = usePopupHeightCap();
  return (
    <div
      style={{
        width: FRAME.width,
        // Fixed, not a minimum. Chrome caps a toolbar popup at 600px and then
        // scrolls the BODY, which drags the header off the top of the window.
        // A fixed frame keeps the header put and lets the content scroll under
        // it, the same way on every screen.
        // Fixed at 600 so an unzoomed popup is the full height Chrome allows,
        // but capped at the WINDOW so a zoomed one shrinks with it. Without the
        // cap the frame stayed 600px tall inside a 300px window at 200% zoom,
        // the body scrolled rather than the frame, and the sticky header went
        // with it: scrolling to the button that signs a payment scrolled away
        // the title saying which screen you were on.
        height: FRAME.height,
        maxHeight: cap,
        background: t.bg,
        color: t.text,
        fontFamily: sans,
        display: "flex",
        flexDirection: "column",
        // Hidden HORIZONTALLY, because nothing in this wallet should ever
        // scroll sideways. Vertically it must be able to scroll: at high zoom
        // a screen's own title and its only way out were being clipped with
        // no way to reach them, which is a trapped user rather than an untidy
        // layout. WCAG 1.4.4.
        overflowX: "hidden",
        overflowY: "auto",
      }}
    >
      {children}
    </div>
  );
}

/**
 * The scrolling column under a header. One screen gutter, one scroll model.
 *
 * The extra room at the bottom is deliberate: measured at 360x600 with a
 * receipt on screen and a form open, the private pocket's Review button landed
 * exactly on the fold, which reads as the end of the screen when it is not.
 */
export function Content({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        padding: space.gutter,
        paddingBottom: space.xl,
        flex: 1,
        overflowY: "auto",
      }}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled,
  variant = "primary",
  type = "button",
  t,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "quiet" | "danger";
  /**
   * Defaults to "button" on purpose. A bare <button> inside a <form> defaults
   * to "submit", so a Cancel next to a form used to fire the form's submit
   * handler as well as its own onClick. On the erase-and-restore screen that
   * meant Cancel could wipe the wallet.
   */
  type?: "button" | "submit";
  t: Theme;
}) {
  const base: CSSProperties = {
    ...text.button,
    width: "100%",
    // A grid or flex item will not shrink below its content without this, and
    // a button that cannot shrink is a button that gets clipped at high zoom.
    // The box shrinking is only half of it: the LABEL has to be able to wrap
    // too, or the text runs past the box it was just allowed to narrow. At
    // Chrome's 500% maximum the viewport is 160px and "Receive" overflowed by
    // 20px in place.
    minWidth: 0,
    overflowWrap: "anywhere",
    padding: "13px 16px",
    // A wrapped label needs room for its second line, so the height is a floor
    // rather than a fixed value.
    minHeight: 46,
    borderRadius: radius.lg,
    border: "1px solid transparent",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: sans,
    transition: `transform ${motion.press} ${motion.ease}, background ${motion.press} ${motion.ease}`,
  };
  const variants: Record<string, CSSProperties> = {
    primary: { background: t.accent, color: t.onAccent },
    quiet: { background: t.field, color: t.text, borderColor: t.line },
    // Not hardcoded white. On the dark theme's danger fill that is 2.92:1, and
    // this variant is the button that erases the wallet.
    danger: { background: t.danger, color: t.onDanger },
  };
  // Disabled is its own state, not the enabled state at 45% opacity: fading
  // the accent left dark ink on pale yellow, which fails contrast at the exact
  // moment the user is trying to work out what is missing.
  const off: CSSProperties = { background: t.field, color: t.faint, borderColor: t.line };
  return (
    <button
      type={type}
      style={{ ...base, ...(disabled ? off : variants[variant]) }}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** A pair of buttons: the way out on the left, the way on on the right. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        // `1fr` means `minmax(auto, 1fr)`, and `auto` here is the item's
        // min-content width, so the track refuses to shrink below its label.
        // At 200% zoom the pair needs 176px in a 156px track and `Frame` is
        // `overflow: hidden`, so the control CLIPS rather than scrolls: it is
        // gone, not merely awkward. Spelling the minimum as 0 is what lets it
        // shrink. WCAG 1.4.4.
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        gap: space.md,
        marginTop: space.gutter,
      }}
    >
      {children}
    </div>
  );
}

/** A stack of full-width buttons, most important first. */
export function ButtonStack({ children }: { children: ReactNode }) {
  // Single column, so nothing to clip horizontally, but the items still need
  // to be allowed to shrink below their content at high zoom.
  return (
    <div style={{ display: "grid", gap: space.md, marginTop: space.gutter, minWidth: 0 }}>
      {children}
    </div>
  );
}

/** The small text buttons in a header or under a form. */
export function TextButton({
  children,
  onClick,
  t,
}: {
  children: ReactNode;
  onClick: () => void;
  t: Theme;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        ...text.caption,
        background: "none",
        border: "none",
        color: t.sub,
        cursor: "pointer",
        padding: space.xs,
        margin: `-${space.xs}px`,
        textAlign: "left",
        fontFamily: sans,
        // A button does not shrink below its content on its own, so a label
        // longer than a zoomed viewport runs past the edge with nothing to
        // scroll. "Forgot your password?" needed 130px in a 124px window.
        maxWidth: "100%",
        minWidth: 0,
      }}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  multiline,
  t,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  multiline?: boolean;
  t: Theme;
}) {
  const style: CSSProperties = {
    width: "100%",
    padding: "11px 12px",
    borderRadius: radius.md,
    border: `1px solid ${t.line}`,
    background: t.field,
    color: t.text,
    fontFamily: sans,
    // 15 was off the type scale. What you type into a wallet should be at
    // least as big as what it reads back to you.
    fontSize: fontSizes.body,
    fontWeight: 500,
    // NOT `outline: none`. An inline style beats any stylesheet rule that is
    // not `!important`, so setting it here silently overrode the focus ring
    // the stylesheet defines, and every text field in the wallet focused with
    // no visible indicator, keyboard and pointer alike. On Send that is three
    // fields in a column and no way to tell which one you are typing into.
    // WCAG 2.4.7. The stylesheet owns focus; this leaves it alone.
    resize: "none",
    boxSizing: "border-box",
  };
  return (
    <label style={{ display: "block", marginBottom: space.lg }}>
      <div style={{ ...text.label, color: t.sub, marginBottom: space.xs }}>{label}</div>
      {multiline ? (
        <textarea
          style={{ ...style, minHeight: 88 }}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          style={style}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

/** A statement of fact the user needs before acting. Not decoration. */
export function Notice({
  tone = "info",
  children,
  t,
}: {
  tone?: "info" | "exposed" | "danger" | "success";
  children: ReactNode;
  t: Theme;
}) {
  const tones = {
    info: { bg: t.field, fg: t.sub, border: t.line },
    exposed: { bg: t.exposedBg, fg: t.exposed, border: "transparent" },
    danger: { bg: t.dangerBg, fg: t.danger, border: "transparent" },
    success: { bg: t.positiveBg, fg: t.positive, border: "transparent" },
  } as const;
  const c = tones[tone];
  return (
    <div
      // A Notice appears in response to something: a refusal, a warning, a
      // confirmation. Without a live region a screen reader user is told
      // nothing at all, which on a refusal means they believe the action
      // worked. `alert` for the two urgent tones because they interrupt;
      // `status` for the rest because they should not. WCAG 4.1.3.
      role={tone === "danger" || tone === "exposed" ? "alert" : "status"}
      aria-live={tone === "danger" || tone === "exposed" ? "assertive" : "polite"}
      style={{
        ...text.body,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        borderRadius: radius.md,
        padding: "10px 12px",
        lineHeight: leading.normal,
        marginBottom: space.lg,
      }}
    >
      {children}
    </div>
  );
}

export function Header({ title, right, t }: { title: string; right?: ReactNode; t: Theme }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px 18px",
        borderBottom: `1px solid ${t.line}`,
        // Sticky, so scrolling to the button that signs a payment does not
        // scroll away the title that says which screen you are on. At 200%
        // zoom the header sat 284px above a 300px window while the user was
        // being asked to approve something.
        position: "sticky",
        top: 0,
        zIndex: 1,
        background: t.bg,
      }}
    >
      {/* A real heading, not a styled span. Screen reader users navigate by
          heading first, and every screen in this wallet returned zero. */}
      <h1 style={{ ...text.heading, color: t.text, margin: 0 }}>{title}</h1>
      {right}
    </div>
  );
}

/** The caption above a value or a section. One treatment, everywhere. */
export function Label({ children, t }: { children: ReactNode; t: Theme }) {
  return <div style={{ ...text.label, color: t.sub, marginBottom: space.xs }}>{children}</div>;
}

/** The all-caps caption naming a pocket or a balance. */
export function SectionLabel({ children, t }: { children: ReactNode; t: Theme }) {
  return <div style={{ ...text.caption, color: t.faint, marginBottom: space.xs }}>{children}</div>;
}

export function Spinner({ t }: { t: Theme }) {
  return (
    <div
      // Named so the reduced-motion rule can slow it rather than freeze it.
      className="pocket-spinner"
      style={{
        width: 18,
        height: 18,
        flexShrink: 0,
        border: `2px solid ${t.line}`,
        borderTopColor: t.accent,
        borderRadius: "50%",
        animation: `pocket-spin ${motion.spin} linear infinite`,
      }}
    />
  );
}

/**
 * A wait, always named. Three screens had grown their own spinner-and-label
 * row with different gaps; a wallet that says nothing while it waits is
 * indistinguishable from one that has hung.
 */
/** After this long, a wait starts counting out loud. */
const ELAPSED_AFTER_MS = 3_000;

export function Loading({ label, t }: { label: string; t: Theme }) {
  // Proving is one phase and it is genuinely slow: measured at 6.8 seconds of a
  // single unchanging sentence, which is the picture a hung app shows. There is
  // no progress to report from inside bb.js, so the honest thing to report is
  // the time itself. A number that ticks is the difference between "working"
  // and "stuck", and it is the only signal available that is not invented.
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    // Restarts on every phase change, so the count is the age of THIS phase and
    // not of the whole operation. A counter that kept running across phases
    // would say 40s while the wallet was two seconds into its last step.
    setSeconds(0);
    const started = Date.now();
    const id = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1_000);
    return () => clearInterval(id);
  }, [label]);

  const elapsed = seconds * 1_000 >= ELAPSED_AFTER_MS ? ` ${seconds}s` : "";
  return (
    <div
      // The label CHANGES as the worker moves through its phases, and each
      // change is the only signal a screen reader user gets that anything is
      // happening. Polite, so it does not cut across what they are reading.
      role="status"
      aria-live="polite"
      style={{ display: "flex", alignItems: "center", gap: space.sm, minHeight: 24 }}
    >
      <Spinner t={t} />
      <span style={{ ...text.body, color: t.sub }}>{label}</span>
      {/* Outside the live region's sentence but inside the same row: a screen
          reader should not read a new number every second, so this is
          aria-hidden and the label alone remains the announced text. */}
      {elapsed && (
        <span aria-hidden="true" style={{ ...text.caption, color: t.faint, fontVariantNumeric: "tabular-nums" }}>
          {elapsed}
        </span>
      )}
    </div>
  );
}
