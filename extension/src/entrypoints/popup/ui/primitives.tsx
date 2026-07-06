// the shared visual vocabulary. every screen and sheet composes these, so a
// button, a field or a sheet is the same object wherever it appears.
import { useEffect, useId, useRef, useState } from "react";
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  PointerEvent as ReactPointerEvent,
  ReactNode,
} from "react";
import { FRAME, fonts, motion, radius, space, text, type Theme } from "./theme";
import { Back as BackIcon, Close as CloseIcon } from "./icons";

/* ---------------------------------------------------------------- frame -- */

/**
 * the popup shell.
 *
 * height is a fixed pixel value and the ceiling is measured, never `vh`: a
 * toolbar popup is sized from its own document, so a viewport unit resolves
 * against a 25px first layout and crushes the frame chrome is about to measure.
 */
export function Frame({ t, children }: { t: Theme; children: ReactNode }) {
  const cap = useWindowCap();
  return (
    <div
      style={{
        position: "relative",
        width: FRAME.width,
        height: FRAME.height,
        maxHeight: cap,
        overflow: "hidden",
        background: t.bg,
        color: t.text,
        fontFamily: fonts.sans,
        // the surface crossfades under the wash instead of hard cutting.
        transition: `background ${motion.pocket} ease`,
      }}
    >
      {children}
    </div>
  );
}

/**
 * the height chrome settled on, or nothing until it says.
 *
 * a resize is the platform reporting a decision. before the first one there is
 * no ceiling at all, which is what lets the frame be measured at its natural
 * height and the popup be sized to fit it.
 */
function useWindowCap(): number | undefined {
  const [cap, setCap] = useState<number | undefined>(undefined);
  useEffect(() => {
    const measure = () => setCap(window.innerHeight);
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return cap;
}

/** a full-height scrolling surface inside the frame. */
export function ScrollArea({
  children,
  background,
  className,
  style,
}: {
  children: ReactNode;
  background?: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={className}
      style={{
        position: "absolute",
        inset: 0,
        overflowX: "hidden",
        overflowY: "auto",
        background,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** a full page, entering with the page motion rather than a sheet's. */
export function Screen({
  t,
  children,
  background,
  /** nothing moves while someone is reading the thing they are confirming. */
  still = false,
}: {
  t: Theme;
  children: ReactNode;
  background?: string;
  still?: boolean;
}) {
  return (
    <Frame t={t}>
      <ScrollArea
        className={still ? "pocket-still" : "pocket-page"}
        background={background ?? t.canvas}
      >
        <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.xl}px` }}>
          {children}
        </div>
      </ScrollArea>
    </Frame>
  );
}

/* --------------------------------------------------------------- header -- */

export function Header({
  t,
  title,
  onBack,
  onClose,
  right,
}: {
  t: Theme;
  title?: string;
  onBack?: () => void;
  onClose?: () => void;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        minHeight: 44,
        marginBottom: space.gutter,
      }}
    >
      {onBack && <IconButton t={t} glyph="back" onClick={onBack} label="Back" />}
      {title ? (
        <h1 style={{ ...text.screenTitle, color: t.text, minWidth: 0, flex: 1, margin: 0 }}>
          {title}
        </h1>
      ) : (
        <div style={{ flex: 1 }} />
      )}
      {right}
      {onClose && <IconButton t={t} glyph="close" onClick={onClose} label="Close" />}
    </div>
  );
}

/**
 * every round icon control in the product.
 *
 * this was two components with the same job and different defaults, which is
 * the taxonomy defect the audit named: same job, one implementation, variants.
 */
export function IconButton({
  t,
  glyph,
  label,
  size = 38,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  t: Theme;
  /** the two the product ships. anything else comes in as children. */
  glyph?: "back" | "close";
  label: string;
  size?: number;
  children?: ReactNode;
}) {
  const inner = Math.round(size * 0.5);
  return (
    <button
      {...rest}
      type="button"
      aria-label={label}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        width: size,
        height: size,
        borderRadius: "50%",
        background: t.accentSoft,
        color: t.dark ? t.accent : t.text,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
      }}
    >
      {glyph === "back" && <BackIcon size={inner} sw={2.4} />}
      {glyph === "close" && <CloseIcon size={inner} sw={2.4} />}
      {!glyph && children}
    </button>
  );
}

/* -------------------------------------------------------------- buttons -- */

export function Button({
  t,
  variant = "primary",
  busy = false,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  t: Theme;
  variant?: "primary" | "quiet" | "danger";
  /** shows a spinner in place of the label and blocks a second press. */
  busy?: boolean;
  children: ReactNode;
}) {
  // busy is not disabled. "you cannot do this" and "this is happening" are
  // different facts, and only the first should take the control out of the tab
  // order. a focused button that becomes `disabled` drops the keyboard user to
  // the document body, which is exactly where they were left every time they
  // pressed the button that starts the slow work.
  const off = disabled || busy;
  const fills: Record<string, CSSProperties> = {
    primary: {
      background: t.accentFill,
      color: t.onAccent,
      boxShadow: t.dark ? "none" : "0 3px 10px -6px rgba(120,90,0,0.45)",
    },
    quiet: { background: t.field, color: t.text, border: `1px solid ${t.line}` },
    danger: { background: t.danger, color: t.onDanger },
  };
  return (
    <button
      {...rest}
      type={type}
      disabled={disabled && !busy}
      aria-disabled={off || undefined}
      aria-busy={busy || undefined}
      onClick={off ? undefined : rest.onClick}
      style={{
        ...text.button,
        boxSizing: "border-box",
        width: "100%",
        minWidth: 0,
        minHeight: 52,
        padding: "14px 18px",
        borderRadius: radius.pill,
        border: "1px solid transparent",
        fontFamily: "inherit",
        cursor: off ? "not-allowed" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        overflowWrap: "anywhere",
        ...(off
          ? { background: t.field, color: t.faint, border: `1px solid ${t.line}` }
          : fills[variant]),
      }}
    >
      {busy && <Spinner size={17} />}
      {children}
    </button>
  );
}

/** buttons in a column, most important first. */
export function ButtonStack({ children }: { children: ReactNode }) {
  return (
    <div style={{ display: "grid", gap: space.sm, marginTop: space.gutter, minWidth: 0 }}>
      {children}
    </div>
  );
}

/** the way out on the left, the way on on the right. */
export function ButtonRow({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        // spelling the minimum as 0 is what lets a track shrink below its
        // label, which is what keeps both buttons on screen at high zoom.
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
        gap: space.sm,
        marginTop: space.gutter,
      }}
    >
      {children}
    </div>
  );
}

/** a quiet inline action, for anything that is not a screen's main move. */
export function TextButton({
  t,
  children,
  tone = "accent",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  t: Theme;
  tone?: "accent" | "sub" | "danger";
  children: ReactNode;
}) {
  const colors = { accent: t.dark ? t.accent : t.text, sub: t.sub, danger: t.danger };
  return (
    <button
      {...rest}
      type="button"
      style={{
        all: "unset",
        cursor: "pointer",
        ...text.label,
        color: colors[tone],
        padding: "8px 4px",
        borderRadius: radius.sm,
      }}
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- inputs -- */

export function Field({
  t,
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  mono = false,
  autoFocus,
  multiline = false,
  hint,
  invalid,
  onSubmit,
}: {
  t: Theme;
  label: string;
  value: string;
  onChange(v: string): void;
  placeholder?: string;
  type?: "text" | "password";
  mono?: boolean;
  autoFocus?: boolean;
  multiline?: boolean;
  hint?: ReactNode;
  invalid?: boolean;
  onSubmit?(): void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const base: CSSProperties = {
    ...text.input,
    boxSizing: "border-box",
    width: "100%",
    minWidth: 0,
    padding: "14px 16px",
    borderRadius: radius.md,
    background: t.field,
    color: t.text,
    border: `1px solid ${invalid ? t.danger : "transparent"}`,
    fontFamily: mono ? fonts.mono : "inherit",
    // deliberately no `outline: none`. the stylesheet owns the focus ring, and
    // an inline reset here beats it, which left a focused field with nothing to
    // show for it.
    resize: "none",
  };
  const described = hint ? hintId : undefined;
  // `mono` means "this is a value, not prose", and the only multiline mono field
  // in the product is the recovery phrase. chrome's enhanced spell check sends
  // the contents of a text field away to be checked, so nothing here is offered
  // to it, to autofill, to autocorrect or to autocapitalise.
  const verbatim = mono
    ? ({
        spellCheck: false,
        autoComplete: "off",
        autoCorrect: "off",
        autoCapitalize: "off",
      } as const)
    : {};
  return (
    <div style={{ marginBottom: space.md }}>
      {/* the hint sits OUTSIDE the label and is pointed at instead. inside it,
          a rule that appears while you type becomes part of the field's own
          name, so the field stops being findable by the name it had. */}
      <label htmlFor={id} style={{ ...text.label, color: t.sub, display: "block", marginBottom: space.xs }}>
        {label}
      </label>
      {multiline ? (
        <textarea
          {...verbatim}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          aria-describedby={described}
          aria-invalid={invalid || undefined}
          rows={3}
          style={base}
        />
      ) : (
        <input
          {...verbatim}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          type={type}
          autoFocus={autoFocus}
          aria-describedby={described}
          aria-invalid={invalid || undefined}
          onKeyDown={(e) => {
            if (e.key === "Enter" && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
          style={base}
        />
      )}
      {hint && (
        <div
          id={hintId}
          style={{
            ...text.caption,
            color: invalid ? t.danger : t.faint,
            marginTop: space.xs,
          }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- surface -- */

export function Card({
  t,
  children,
  tone = "surface",
  style,
}: {
  t: Theme;
  children: ReactNode;
  tone?: "surface" | "accent" | "field";
  style?: CSSProperties;
}) {
  const tones: Record<string, CSSProperties> = {
    surface: { background: t.surface, border: `1px solid ${t.line}` },
    accent: { background: t.accentSoft, border: `1px solid ${t.accentLine}` },
    field: { background: t.field, border: "1px solid transparent" },
  };
  return (
    <div style={{ borderRadius: radius.lg, padding: space.md, minWidth: 0, ...tones[tone], ...style }}>
      {children}
    </div>
  );
}

/** a list row: leading glyph, title over subtitle, trailing value. */
export function Row({
  t,
  icon,
  title,
  sub,
  value,
  valueSub,
  onClick,
  tone = "plain",
  index,
}: {
  t: Theme;
  icon?: ReactNode;
  title: string;
  sub?: ReactNode;
  value?: ReactNode;
  valueSub?: ReactNode;
  onClick?: () => void;
  tone?: "plain" | "danger";
  /** staggers the entrance so a list arrives instead of appearing. */
  index?: number;
}) {
  // a row's name is its title. the subtitle describes it, and folding both into
  // one accessible name gave every control a name nobody would ever call it by.
  const id = useId();
  const titleId = `${id}-title`;
  const subId = `${id}-sub`;
  const inner = (
    <>
      {icon && (
        <span
          style={{
            width: 40,
            height: 40,
            borderRadius: radius.md,
            background: tone === "danger" ? t.dangerSoft : t.accentSoft,
            color: tone === "danger" ? t.danger : t.dark ? t.accent : t.text,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "0 0 auto",
            // a mark can never be the thing that overflows a row.
            overflow: "hidden",
          }}
        >
          {icon}
        </span>
      )}
      {/* a basis, not just a grow factor. with only `flex: 1` a long value on
          the right squeezed the title to twelve pixels, which is narrower than
          one of its own letters, so the title was cut off rather than the value
          wrapping onto its own line. */}
      <span style={{ minWidth: 0, textAlign: "left", flex: "1 1 90px" }}>
        <span
          id={titleId}
          style={{ ...text.rowTitle, color: tone === "danger" ? t.danger : t.text, display: "block" }}
        >
          {title}
        </span>
        {sub && (
          <span id={subId} style={{ ...text.rowSub, color: t.sub, display: "block", marginTop: 1 }}>
            {sub}
          </span>
        )}
      </span>
      {(value || valueSub) && (
        <span style={{ textAlign: "right", minWidth: 0, flex: "0 1 auto", overflowWrap: "anywhere" }}>
          {value && <span style={{ ...text.value, color: t.text, display: "block" }}>{value}</span>}
          {valueSub && (
            <span style={{ ...text.rowSub, color: t.sub, display: "block" }}>{valueSub}</span>
          )}
        </span>
      )}
    </>
  );

  const style: CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: space.md,
    width: "100%",
    padding: `${space.sm}px 0`,
    minWidth: 0,
    flexWrap: "wrap",
    animationDelay: index != null ? `${index * 45}ms` : undefined,
  };

  if (!onClick) {
    return (
      <div className={index != null ? "pocket-row-in" : undefined} style={style}>
        {inner}
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      aria-labelledby={titleId}
      aria-describedby={sub ? subId : undefined}
      className={index != null ? "pocket-row-in" : undefined}
      style={{ all: "unset", cursor: "pointer", boxSizing: "border-box", ...style }}
    >
      {inner}
    </button>
  );
}

export function Overline({ t, children }: { t: Theme; children: ReactNode }) {
  return (
    <div style={{ ...text.overline, color: t.faint, textTransform: "uppercase", marginBottom: space.sm }}>
      {children}
    </div>
  );
}

/** a field or section label inside a screen. sentence case: a review is read,
 *  not shouted. */
export function Label({ t, children }: { t: Theme; children: ReactNode }) {
  return (
    <div style={{ ...text.label, color: t.sub, marginBottom: space.xs }}>{children}</div>
  );
}

export function Chip({
  t,
  children,
  tone = "neutral",
}: {
  t: Theme;
  children: ReactNode;
  tone?: "neutral" | "accent" | "danger" | "positive" | "exposed";
}) {
  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: t.field, fg: t.sub },
    accent: { bg: t.accentSoft, fg: t.dark ? t.accent : t.text },
    danger: { bg: t.dangerSoft, fg: t.danger },
    positive: { bg: t.positiveSoft, fg: t.positive },
    exposed: { bg: t.exposedSoft, fg: t.exposed },
  };
  const c = tones[tone]!;
  return (
    <span
      style={{
        ...text.caption,
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "5px 10px",
        borderRadius: radius.pill,
        background: c.bg,
        color: c.fg,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Notice({
  t,
  tone = "neutral",
  children,
}: {
  t: Theme;
  tone?: "neutral" | "danger" | "positive" | "exposed";
  children: ReactNode;
}) {
  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: t.field, fg: t.text },
    danger: { bg: t.dangerSoft, fg: t.danger },
    positive: { bg: t.positiveSoft, fg: t.positive },
    exposed: { bg: t.exposedSoft, fg: t.exposed },
  };
  const c = tones[tone]!;
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      style={{
        ...text.body,
        background: c.bg,
        color: c.fg,
        padding: `${space.sm}px ${space.md}px`,
        borderRadius: radius.md,
        marginBottom: space.md,
        overflowWrap: "anywhere",
        lineHeight: 1.45,
      }}
    >
      {children}
    </div>
  );
}

/* ------------------------------------------------------------- feedback -- */

export function Spinner({ size = 20, color }: { size?: number; color?: string }) {
  return (
    <span
      aria-hidden
      className="pocket-spinner"
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        border: `${Math.max(2, Math.round(size / 9))}px solid`,
        borderColor: "currentColor",
        borderTopColor: color ?? "transparent",
        opacity: 0.75,
        display: "inline-block",
        flex: "0 0 auto",
      }}
    />
  );
}

/**
 * a value that has not arrived yet.
 *
 * a shimmer rather than a zero, because a zero is a number the user could act
 * on and it would be the wrong one.
 */
export function Skeleton({ width, height = 16 }: { width: number | string; height?: number }) {
  return (
    <span className="pocket-skeleton" style={{ display: "block", width, maxWidth: "100%", height }} />
  );
}

export function Toast({ t, children }: { t: Theme; children: ReactNode }) {
  return (
    <div
      role="status"
      className="pocket-fade-in"
      style={{
        ...text.body,
        position: "absolute",
        left: "50%",
        bottom: 104,
        transform: "translateX(-50%)",
        background: t.dark ? "#2A2733" : "#14151A",
        color: "#FFFFFF",
        padding: "11px 18px",
        borderRadius: radius.pill,
        zIndex: 60,
        maxWidth: FRAME.width - 48,
        textAlign: "center",
        boxShadow: "0 12px 30px -12px rgba(0,0,0,0.55)",
      }}
    >
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- sheets -- */

/**
 * grab a sheet's header and pull it down to put it away. released short of the
 * threshold it springs back.
 */
function useDragDismiss(onDismiss: () => void) {
  const [dy, setDy] = useState(0);
  const [grabbing, setGrabbing] = useState(false);
  const startY = useRef<number | null>(null);

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    // controls inside the header keep their own press.
    if ((e.target as HTMLElement).closest("button, input, textarea, a, [role='button']")) return;
    startY.current = e.clientY;
    setGrabbing(true);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // capture is not available on every target, and the drag still works.
    }
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (startY.current == null) return;
    const d = e.clientY - startY.current;
    setDy(d > 0 ? d : 0);
  };
  const finish = () => {
    if (startY.current == null) return;
    const dismiss = dy > 90;
    startY.current = null;
    setGrabbing(false);
    if (dismiss) onDismiss();
    else setDy(0);
  };

  return {
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: finish,
      onPointerCancel: finish,
    },
    grabStyle: { cursor: grabbing ? "grabbing" : "grab", touchAction: "none" } as CSSProperties,
    style: {
      transform: dy ? `translateY(${dy}px)` : undefined,
      transition: grabbing ? "none" : `transform ${motion.sheet} ${motion.enter}`,
    } as CSSProperties,
  };
}

/**
 * a bottom sheet.
 *
 * it stays mounted through the exit, so closing reads as putting it away rather
 * than as it vanishing. the backdrop fades on its own timing, independent of
 * the card's slide.
 */
export function Sheet({
  t,
  open,
  onClose,
  title,
  children,
  /** fills the frame, for a step that needs the room. */
  full = false,
  /**
   * changes when the sheet swaps what it is showing. focus follows it, because
   * a panel replaced under a keyboard user drops focus to the document body.
   */
  focusKey,
  /** nothing moves while someone is reading the thing they are confirming. */
  still = false,
}: {
  t: Theme;
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  full?: boolean;
  focusKey?: string;
  still?: boolean;
}) {
  const [mounted, setMounted] = useState(open);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const panel = useRef<HTMLElement>(null);
  const drag = useDragDismiss(onClose);

  useEffect(() => {
    if (open) {
      clearTimeout(timer.current);
      setMounted(true);
      setClosing(false);
    } else if (mounted) {
      setClosing(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setMounted(false);
        setClosing(false);
      }, 240);
    }
    return () => clearTimeout(timer.current);
  }, [open, mounted]);

  // focus goes to the sheet's first field when it has one, so the next
  // keystroke lands in the form rather than on the screen behind. a sheet with
  // no field takes focus itself, which is what announces the dialog.
  useEffect(() => {
    if (!open || !mounted) return;
    const root = panel.current;
    if (!root) return;
    const field = root.querySelector<HTMLElement>("input:not([disabled]), textarea:not([disabled])");
    (field ?? root).focus();
  }, [open, mounted, focusKey]);

  const keepFocusInside = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = panel.current;
    if (!root) return;
    const stops = Array.from(
      root.querySelectorAll<HTMLElement>(
        "button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
      ),
    ).filter((el) => el.offsetParent !== null);
    if (stops.length === 0) return;
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  // escape closes whatever is on top, the same as pressing close.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <>
      <div
        onClick={onClose}
        className={closing ? "pocket-fade-out" : "pocket-fade-in"}
        style={{
          position: "absolute",
          inset: 0,
          background: t.dark ? "rgba(4,3,10,0.42)" : "rgba(20,21,26,0.14)",
          backdropFilter: "blur(6px) saturate(1.1)",
          WebkitBackdropFilter: "blur(6px) saturate(1.1)",
          zIndex: 30,
        }}
      />
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={keepFocusInside}
        className={`${closing ? "pocket-sheet-out" : "pocket-sheet-in"}${still ? " pocket-still" : ""}`}
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          top: full ? 0 : "auto",
          maxHeight: "100%",
          display: "flex",
          flexDirection: "column",
          background: t.sheet,
          color: t.text,
          borderRadius: full ? 0 : `${radius.sheet}px ${radius.sheet}px 0 0`,
          zIndex: 31,
          boxShadow: t.dark ? "0 -20px 50px -30px #000" : "0 -18px 46px -30px rgba(20,21,26,0.5)",
          ...drag.style,
        }}
      >
        <div
          {...drag.handleProps}
          style={{ ...drag.grabStyle, padding: `${space.md}px ${space.lg}px 0`, flex: "0 0 auto" }}
        >
          {!full && (
            <div
              aria-hidden
              style={{
                width: 38,
                height: 4,
                borderRadius: radius.pill,
                background: t.line,
                margin: "0 auto",
              }}
            />
          )}
          <div style={{ display: "flex", alignItems: "center", gap: space.md, marginTop: space.md }}>
            {title ? (
              <h2 style={{ ...text.screenTitle, color: t.text, flex: 1, minWidth: 0, margin: 0 }}>
                {title}
              </h2>
            ) : (
              <div style={{ flex: 1 }} />
            )}
            <IconButton t={t} glyph="close" onClick={onClose} label="Close" />
          </div>
        </div>
        <div
          style={{
            padding: `${space.gutter}px ${space.lg}px ${space.lg}px`,
            overflowX: "hidden",
            overflowY: "auto",
            minHeight: 0,
          }}
        >
          {children}
        </div>
      </section>
    </>
  );
}
