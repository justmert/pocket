// the shared visual vocabulary. every screen and sheet composes these, so a
// button, a field or a sheet is the same object wherever it appears.
import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, Ref, ReactNode, UIEventHandler } from "react";
import { FRAME, fonts, motion, radius, ROW_STAGGER_MS, space, text, type Theme } from "./theme";
import { Back as BackIcon, Close as CloseIcon } from "./icons";

/* ---------------------------------------------------------------- frame -- */

/**
 * the popup shell.
 *
 * height is a fixed pixel value and the ceiling is measured, never `vh`: a
 * toolbar popup is sized from its own document, so a viewport unit resolves
 * against a 25px first layout and crushes the frame chrome is about to measure.
 */
export function Frame({
  t,
  children,
  className,
}: {
  t: Theme;
  children: ReactNode;
  /** full-frame ROUTES (Send, Move) pass `pocket-page` so they enter like a screen
   *  instead of hard-cutting into place; Screen animates its inner ScrollArea. */
  className?: string;
}) {
  const cap = useWindowCap();
  return (
    <div
      className={className}
      style={{
        position: "relative",
        // a FIXED pixel width, and nothing viewport-relative: chrome sizes the
        // toolbar popup to the frame's used width, and the root chain (#root/body)
        // has no width of its own. `width:100%` had nothing to resolve against and
        // `maxWidth:100vw` clamped against a `vw` that is ~0 during the popup's
        // initial auto-size; either one collapsed the whole popup to a few pixels.
        // 384 is the popup's identity and it must be a plain length.
        width: FRAME.width,
        height: FRAME.height,
        maxHeight: cap,
        overflow: "hidden",
        background: t.bg,
        color: t.text,
        fontFamily: fonts.body,
        // the surface crossfades on a pocket switch instead of hard cutting, on the
        // pocket-crossing duration and the shared "arriving" easing (not bare ease).
        transition: `background ${motion.pocket} ${motion.enter}`,
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
  onScroll,
  ref,
}: {
  children: ReactNode;
  background?: string;
  className?: string;
  style?: CSSProperties;
  /** the scroll position drives the home screen's collapsing header. */
  onScroll?: UIEventHandler<HTMLDivElement>;
  /** Home attaches a NATIVE (non-passive) wheel listener here to collapse/expand
   *  its header on the wheel intent, before the browser scrolls, which a passive
   *  React onWheel cannot do. */
  ref?: Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      className={className}
      onScroll={onScroll}
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
  subtitle,
  onBack,
  right,
}: {
  t: Theme;
  title?: string;
  /** a quiet second line under the title, e.g. the direction a Move is headed. */
  subtitle?: ReactNode;
  onBack?: () => void;
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
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1 style={{ ...text.screenTitle, color: t.text, minWidth: 0, margin: 0 }}>{title}</h1>
          {subtitle && <div style={{ ...text.rowSub, color: t.sub, marginTop: 2 }}>{subtitle}</div>}
        </div>
      ) : (
        <div style={{ flex: 1 }} />
      )}
      {right}
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
  size = 34,
  children,
  style,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  t: Theme;
  /** "back" is the one built-in glyph; anything else (e.g. the close X) is passed
   *  as children. */
  glyph?: "back";
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
      // pk-tap gives the wallet's most-used control (back / close / refresh / more)
      // the same hover veil every tappable now carries.
      className={["pk-tap", className].filter(Boolean).join(" ")}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        width: size,
        height: size,
        borderRadius: "50%",
        background: t.accentSoft,
        // the glyph must clear 4.5:1 on accentSoft in BOTH pockets; the raw accent
        // does not on the dark fill, so this reads from the dedicated stop.
        color: t.accentOnSoft,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
        // callers may position the button (e.g. the sheet's absolute close X);
        // their style merges on top of the base rather than being dropped.
        ...style,
      }}
    >
      {glyph === "back" && <BackIcon size={inner} sw={2.4} />}
      {!glyph && children}
    </button>
  );
}

/**
 * a round disc holding a centred glyph or mark.
 *
 * this shape (a circle filled with the accent, its ink drawn on top, flex
 * centred) was hand-rolled at four sizes across Home, Send, Move and the asset
 * detail sheet, so a colour or a radius fix had to be made in each. one
 * primitive owns it; `tone` picks the fill from tokens: `accent` for the lit
 * disc every screen shows, `field` for the neutral plate the detail rows use.
 */
export function IconDisc({
  t,
  size,
  tone = "accent",
  children,
}: {
  t: Theme;
  size: number;
  tone?: "accent" | "accentSoft" | "field";
  children: ReactNode;
}) {
  const tones: Record<string, { bg: string; fg: string }> = {
    accent: { bg: t.accent, fg: t.onAccent },
    // the pocket-tinted tile the asset marks sit on: the same soft accent every
    // list row draws them over, so the detail header matches the list.
    accentSoft: { bg: t.accentSoft, fg: t.accentOnSoft },
    field: { bg: t.field, fg: t.sub },
  };
  const c = tones[tone]!;
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flex: "0 0 auto",
        background: c.bg,
        color: c.fg,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        // a mark can never be the thing that overflows the disc.
        overflow: "hidden",
      }}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------- buttons -- */

export function Button({
  t,
  variant = "primary",
  size = "lg",
  busy = false,
  disabled,
  children,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  t: Theme;
  variant?: "primary" | "soft" | "quiet" | "danger";
  /**
   * `lg` is the full-width 52px call to action; `pill` is a compact auto-width
   * action for the same solid-accent look at chip scale (Use max, an inline
   * action). the variant (primary/quiet/danger) picks the fill either way, so the
   * five hand-rolled `all: unset` accent pills stop each re-deriving that fill.
   */
  size?: "lg" | "pill";
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
  // primary is a solid accent with an inner white glow for the lit look. the glow
  // STAYS on the full-width CTA. what read as a border was the `border: 1px solid
  // transparent` below: a border sits OUTSIDE the inset glow, so it left a 1px hair
  // of the un-lit base accent right around the rim. the fix is to drop the border,
  // not the glow, so the glow reaches the very edge and there is no ring.
  //
  // the small pill drops the glow: at chip scale the inner white sheen read as a
  // soft gradient rather than a button, and "Use max" / "Paste" want a plain solid
  // fill with white text. danger carries the same glow as primary, so the two
  // choices on a destructive confirm ("Keep this wallet" / "I understand") share
  // one treatment and differ only in colour.
  const glow = size === "pill" ? undefined : "inset 0 0 14px rgba(255,255,255,0.65)";
  const fills: Record<string, CSSProperties> = {
    primary: { background: t.accentFill, color: t.onAccent, boxShadow: glow },
    soft: { background: t.accentSoft, color: t.accentOnSoft },
    quiet: { background: t.field, color: t.text, border: `1px solid ${t.line}` },
    danger: { background: t.danger, color: t.onDanger, boxShadow: glow },
  };
  // one place decides scale: the block CTA fills its column at 52px on the button
  // role; the pill hugs its label at chip scale. everything else (fill, radius,
  // reset) is shared below, so the two sizes cannot drift in anything but size.
  const sized: CSSProperties =
    size === "pill"
      ? { ...text.chip, width: "auto", padding: "8px 14px" }
      : { ...text.button, width: "100%", minHeight: 52, padding: "14px 18px" };
  return (
    <button
      {...rest}
      // pk-btn adds the reference button's hover-lighten; :hover cannot be
      // inline. the press is already global to every button. see popup/style.css.
      // the quiet variant opts out of the brightness lighten (which washes its pale
      // fill toward white) and gets its own deeper-fill hover.
      className={variant === "quiet" ? "pk-btn pk-btn-quiet" : "pk-btn"}
      type={type}
      disabled={disabled && !busy}
      aria-disabled={off || undefined}
      aria-busy={busy || undefined}
      onClick={off ? undefined : rest.onClick}
      style={{
        ...sized,
        // reset the native button chrome, or the browser draws its own faint
        // bevel/border on the pill (a dark bottom-right edge) over our fill.
        appearance: "none",
        WebkitAppearance: "none",
        boxSizing: "border-box",
        minWidth: 0,
        // a pill: the reference's ctaRadius is 30, which at this height rounds
        // the ends fully, so radius.pill is the same shape and stays one whether
        // the label wraps to a second line or not.
        borderRadius: radius.pill,
        // no base border. a border (even transparent) sits outside the primary's
        // inset glow and shows a 1px ring of the un-lit base accent, which read as
        // a border at zoom. the quiet variant sets its own visible border below.
        border: "none",
        cursor: off ? "not-allowed" : "pointer",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: space.sm,
        overflowWrap: "anywhere",
        ...(off ? { background: t.field, color: t.faint } : fills[variant]),
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
  trailing,
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
  /**
   * A control inside the field's right edge, such as a password reveal.
   *
   * It is a sibling of the input rather than a wrapper around it, so the input
   * keeps its own focus ring and its own accessible name. The input reserves
   * room for it, because an overlay that sits on top of text the user is typing
   * is worse than no control at all.
   */
  trailing?: ReactNode;
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
    fontFamily: mono ? fonts.mono : fonts.body,
    // verbatim data (the phrase import) is mono at 500; prose inputs keep 400.
    fontWeight: 500,
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
      <label
        htmlFor={id}
        style={{ ...text.label, color: t.sub, display: "block", marginBottom: space.xs }}
      >
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
        // The trailing control is a SIBLING that takes its own width, never an
        // overlay. Overlaid at `right: 4` it was correct at 384px and wrong at
        // 160px, which is what Chrome's maximum zoom leaves: the field is 94px
        // there, a 44px control covers x=46..90, and the input's own centre is
        // at 47. The control sat on top of the middle of the field, so a tap
        // aimed at the text landed on the eye.
        //
        // With no trailing control the input keeps the field chrome itself, so
        // every other field in the product renders exactly as it did.
        <div
          style={
            trailing
              ? {
                  ...base,
                  display: "flex",
                  alignItems: "center", // the frame is 160px at chrome's maximum zoom, and a fixed 16px here plus
                  // the control's own width left the field 28px wide. it gives way first.
                  padding: "0 4px 0 clamp(8px, 4vw, 16px)",
                }
              : undefined
          }
        >
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
            style={
              trailing
                ? {
                    ...base,
                    flex: 1,
                    // it may shrink below its content, or it pushes the control
                    // off the right edge instead of giving way to it.
                    minWidth: 0,
                    background: "transparent",
                    border: "none",
                    padding: "14px 0",
                  }
                : base
            }
          />
          {trailing}
        </div>
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
    <div
      style={{ borderRadius: radius.lg, padding: space.md, minWidth: 0, ...tones[tone], ...style }}
    >
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
  iconRing = false,
  index,
}: {
  t: Theme;
  icon?: ReactNode;
  title: string;
  sub?: ReactNode;
  value?: ReactNode;
  valueSub?: ReactNode;
  onClick?: () => void;
  /** a token's own artwork sits in a neutral bordered frame, not an accent fill:
   *  the logo carries the colour, so a tint behind it only competes with it. */
  iconRing?: boolean;
  /**
   * `inert` is a row that is present but cannot be pressed.
   *
   * without it the unavailable row carried the same title weight and the same
   * accent-filled mark as the live rows beside it, so the only signal that it
   * did nothing was pressing it and watching nothing happen.
   */
  tone?: "plain" | "danger" | "inert";
  /** staggers the entrance so a list arrives instead of appearing. */
  index?: number;
}) {
  // a row's name is its title. the subtitle describes it, and folding both into
  // one accessible name gave every control a name nobody would ever call it by.
  const id = useId();
  const titleId = `${id}-title`;
  const subId = `${id}-sub`;
  const valueId = `${id}-value`;
  const inner = (
    <>
      {icon && (
        <span
          style={{
            boxSizing: "border-box",
            width: 40,
            height: 40,
            borderRadius: radius.md,
            background: iconRing
              ? "transparent"
              : tone === "danger"
                ? t.dangerSoft
                : tone === "inert"
                  ? t.field
                  : t.accentSoft,
            border: iconRing ? `1px solid ${t.line}` : undefined,
            color: tone === "danger" ? t.danger : tone === "inert" ? t.faint : t.accentOnSoft,
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
          style={{
            ...text.rowTitle,
            color: tone === "danger" ? t.danger : tone === "inert" ? t.faint : t.text,
            display: "block",
          }}
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
        <span
          style={{ textAlign: "right", minWidth: 0, flex: "0 1 auto", overflowWrap: "anywhere" }}
        >
          {value && (
            <span id={valueId} style={{ ...text.value, color: t.text, display: "block" }}>
              {value}
            </span>
          )}
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
    animationDelay: index != null ? `${index * ROW_STAGGER_MS}ms` : undefined,
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
      // the value is part of the NAME, not the description. a settings row
      // reading "Network, button" with its current value only in a description
      // leaves a screen-reader user unable to tell which network is selected
      // without moving focus again, which is the one thing the row exists to
      // say. named, it reads "Network Testnet, button".
      aria-labelledby={value ? `${titleId} ${valueId}` : titleId}
      aria-describedby={sub ? subId : undefined}
      // pk-tap gives a pressable row the hover veil, so it reads as pressable before
      // it is pressed; the radius rounds that veil rather than filling a hard slab.
      className={["pk-tap", index != null ? "pocket-row-in" : null].filter(Boolean).join(" ")}
      style={{
        all: "unset",
        cursor: "pointer",
        boxSizing: "border-box",
        borderRadius: radius.md,
        ...style,
      }}
    >
      {inner}
    </button>
  );
}

export function Overline({ t, children }: { t: Theme; children: ReactNode }) {
  // a section header, not a tiny eyebrow: these read at the heading size and
  // weight in the pocket's own ink, so "Assets" and "Yield" look like headings.
  return <div style={{ ...text.heading, color: t.text, marginBottom: space.sm }}>{children}</div>;
}

/** a field or section label inside a screen. sentence case: a review is read,
 *  not shouted. */
export function Label({ t, children }: { t: Theme; children: ReactNode }) {
  return <div style={{ ...text.label, color: t.sub, marginBottom: space.xs }}>{children}</div>;
}

export function Chip({
  t,
  children,
  tone = "neutral",
}: {
  t: Theme;
  children: ReactNode;
  // only the two tones the product actually renders. Notice carries the full
  // danger/positive/exposed set for its 100+ call sites; Chip is a Settings
  // eyebrow and never needed them, so the union states what it draws.
  tone?: "neutral" | "accent";
}) {
  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: t.field, fg: t.sub },
    accent: { bg: t.accentSoft, fg: t.accentOnSoft },
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
  bare = false,
  children,
}: {
  t: Theme;
  tone?: "neutral" | "danger" | "positive" | "exposed";
  /**
   * drops the built-in bottom margin so the caller owns the spacing.
   *
   * the default margin is right when Notices stack, but a caller that wraps the
   * Notice to control spacing (a `marginTop` wrapper) then fights it and gets a
   * double gap; `bare` lets a flex/grid parent set the rhythm instead.
   */
  bare?: boolean;
  children: ReactNode;
}) {
  const tones: Record<string, { bg: string; fg: string }> = {
    neutral: { bg: t.field, fg: t.text },
    danger: { bg: t.dangerSoft, fg: t.danger },
    positive: { bg: t.positiveSoft, fg: t.positive },
    exposed: { bg: t.exposedSoft, fg: t.exposed },
  };
  const c = tones[tone]!;
  // a refusal interrupts, because it has to. an outcome is announced without
  // interrupting, because it arrives while someone may still be listening to
  // the step that produced it. what must not happen is the third case that used
  // to exist: a confirmation, a ledger number and a hash appearing with no
  // announcement at all, so a screen-reader user who pressed "Confirm and send"
  // hears the progress phases and then silence, and cannot tell a sent payment
  // from a stuck one.
  const live =
    tone === "danger" ? "alert" : tone === "positive" || tone === "exposed" ? "status" : undefined;
  return (
    <div
      role={live}
      aria-live={live === "status" ? "polite" : undefined}
      // a banner that interrupts a screen should announce itself visually the way
      // the toast beside it does; it fades in rather than snapping into the layout.
      className="pocket-fade-in"
      style={{
        ...text.body,
        background: c.bg,
        color: c.fg,
        padding: `${space.sm}px ${space.md}px`,
        borderRadius: radius.md,
        marginBottom: bare ? undefined : space.md,
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
export function Skeleton({
  width,
  height = 16,
  radius: r = 8,
}: {
  width: number | string;
  height?: number;
  /** the corner radius of what this stands in for, so a card-shaped placeholder
   *  does not visibly change shape when the real, more-rounded card lands. */
  radius?: number;
}) {
  return (
    <span
      className="pocket-skeleton"
      style={{ display: "block", width, maxWidth: "100%", height, borderRadius: r }}
    />
  );
}

/**
 * keep a boolean-gated overlay mounted through its exit.
 *
 * a bare `{open && <Menu/>}` vanishes on close, cutting whatever entrance it played.
 * this holds it mounted for `ms` after `open` goes false so it can animate out;
 * `render` says whether to mount it, `leaving` says to play the exit class.
 */
export function useLeave(open: boolean, ms = 200): { render: boolean; leaving: boolean } {
  const [render, setRender] = useState(open);
  useEffect(() => {
    if (open) {
      setRender(true);
      return;
    }
    if (render) {
      const id = setTimeout(() => setRender(false), ms);
      return () => clearTimeout(id);
    }
  }, [open, render, ms]);
  return { render, leaving: render && !open };
}

/**
 * hold the last non-null value through an exit.
 *
 * a detail sheet keyed on `asset != null` empties the instant the value is cleared,
 * so it slides down showing a blank card. this returns the live value while it is
 * set and the LAST value for `ms` after it is cleared, so `<Sheet open={v != null}>`
 * can close while its body still renders what it was showing.
 */
export function useRetained<T>(value: T | null, ms = 300): T | null {
  const [held, setHeld] = useState<T | null>(value);
  useEffect(() => {
    if (value != null) {
      setHeld(value);
      return;
    }
    const id = setTimeout(() => setHeld(null), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return value ?? held;
}

/**
 * a transient status line over the app.
 *
 * it manages its own mount so it can LEAVE rather than vanish: while `message` is
 * set it fades in; when the caller clears it to null the last message is held
 * through a fade-out before the node unmounts, the same mount-through-exit the
 * Sheet uses. so the caller renders `<Toast message={x}/>` unconditionally.
 */
export function Toast({ t, message }: { t: Theme; message: string | null }) {
  const [shown, setShown] = useState<string | null>(message);
  useEffect(() => {
    if (message != null) {
      setShown(message);
      return;
    }
    if (shown != null) {
      const id = setTimeout(() => setShown(null), 200);
      return () => clearTimeout(id);
    }
  }, [message, shown]);
  if (shown == null) return null;
  const leaving = message == null;
  return (
    <div
      role="status"
      className={leaving ? "pocket-fade-out" : "pocket-fade-in"}
      style={{
        ...text.body,
        position: "absolute",
        left: "50%",
        bottom: 104,
        transform: "translateX(-50%)",
        // an inverse of the surface, so the toast reads as a layer over the app.
        background: t.text,
        color: t.bg,
        padding: "11px 18px",
        borderRadius: radius.pill,
        zIndex: 60,
        maxWidth: FRAME.width - 48,
        textAlign: "center",
        boxShadow: t.shadow,
      }}
    >
      {shown}
    </div>
  );
}

/* --------------------------------------------------------------- sheets -- */

const SHEET_MS = 280;

/** the drag pill at the top of every sheet, one definition so the title'd and the
 *  headerless layout draw the identical handle. */
function grabHandle(t: Theme): CSSProperties {
  return {
    width: 38,
    height: 4,
    borderRadius: radius.pill,
    background: t.line,
    margin: "0 auto",
    flex: "0 0 auto",
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
  /**
   * a primary action pinned to the bottom of the sheet.
   *
   * it is a flex SIBLING of the scroll body, not the last thing inside it, so it
   * sits at the very bottom of the sheet whether the content overflows or barely
   * fills it. `position: sticky` inside the scroll body could not do this: sticky
   * only holds an element against the viewport edge while there is content to
   * scroll, so on a short sheet the button floated in the middle with blank sheet
   * beneath it, which is exactly what it looked like on the asset detail sheet.
   */
  footer,
  /** fills the frame, for a step that needs the room. */
  full = false,
  /**
   * changes when the sheet swaps what it is showing. focus follows it, because
   * a panel replaced under a keyboard user drops focus to the document body.
   */
  focusKey,
  /** nothing moves while someone is reading the thing they are confirming. */
  still = false,
  /** a small info affordance rendered beside the title, e.g. an InfoTip whose
   *  hover carries a consequence that used to sit as a paragraph in the body. */
  info,
  /** fired once the sheet has finished its slide-down and unmounted its content.
   *  lets a caller sequence something AFTER the exit (e.g. leaving a full-frame
   *  route) rather than during it, so the close animates instead of being cut. */
  onClosed,
  /** drop the close X. for a sheet whose own buttons are the only way out (a
   *  confirm: Cancel while reviewing, Go to Home while it works, Done after), so a
   *  stray X does not offer a fourth, ambiguous exit. the backdrop still obeys
   *  `onClose`, which the confirm makes a no-op while it is working. */
  hideClose = false,
}: {
  t: Theme;
  open: boolean;
  onClose: () => void;
  title?: string;
  children: ReactNode;
  footer?: ReactNode;
  full?: boolean;
  focusKey?: string;
  still?: boolean;
  info?: ReactNode;
  onClosed?: () => void;
  hideClose?: boolean;
}) {
  const [mounted, setMounted] = useState(open);
  // ONE transform drives entrance, exit AND drag, in pixels, so a drag-to-close
  // continues straight into the exit slide with no snap. the old split (a CSS
  // exit animation plus an inline drag transform) fought each other: releasing a
  // drag jumped the sheet back to 0 and then a separate animation slid it down.
  const [y, setY] = useState(0);
  const [grabbing, setGrabbing] = useState(false);
  const [entering, setEntering] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const enterTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const startY = useRef<number | null>(null);
  const panel = useRef<HTMLElement>(null);

  useEffect(() => {
    if (open) {
      clearTimeout(timer.current);
      setMounted(true);
      setY(0);
      setGrabbing(false);
      startY.current = null;
      // let the entrance animation play, then hand the transform back to drag.
      setEntering(true);
      clearTimeout(enterTimer.current);
      enterTimer.current = setTimeout(() => setEntering(false), SHEET_MS);
    } else if (mounted) {
      // slide down from wherever it is, be that 0 or a drag position, then
      // unmount. one mechanism, so there is nothing to snap against.
      setEntering(false);
      setY(panel.current?.offsetHeight ?? 800);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setMounted(false);
        setY(0);
        onClosed?.();
      }, SHEET_MS);
    }
    return () => {
      clearTimeout(timer.current);
      clearTimeout(enterTimer.current);
    };
  }, [open, mounted]);

  // grab the header and pull down to dismiss; released short of the threshold it
  // springs back.
  const onGrabDown = (e: React.PointerEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, input, textarea, a, [role='button']")) return;
    startY.current = e.clientY;
    setGrabbing(true);
    setEntering(false);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* capture unavailable; the drag still tracks over the header */
    }
  };
  const onGrabMove = (e: React.PointerEvent<HTMLElement>) => {
    if (startY.current == null) return;
    setY(Math.max(0, e.clientY - startY.current));
  };
  const onGrabEnd = () => {
    if (startY.current == null) return;
    const dismiss = y > 90;
    startY.current = null;
    setGrabbing(false);
    if (dismiss) onClose();
    else setY(0);
  };

  // focus goes to the sheet's first field when it has one, so the next
  // keystroke lands in the form rather than on the screen behind. a sheet with
  // no field takes focus itself, which is what announces the dialog.
  useEffect(() => {
    if (!open || !mounted) return;
    const root = panel.current;
    if (!root) return;
    const field = root.querySelector<HTMLElement>(
      "input:not([disabled]), textarea:not([disabled])",
    );
    // preventScroll is load-bearing, not a nicety. focusing an element makes the
    // browser scroll its scrollable ancestor to reveal it, and the sheet sits at
    // bottom: 0 inside the frame's scroll container, so revealing it dragged the
    // whole screen behind it upward. measured at the real 384x600 frame: the
    // title went from y=18 to y=-465 and the bottom bar from y=520 to y=37, a
    // 483px lurch one frame after the sheet mounted. behind a 6px blur that
    // reads as the backdrop tearing rather than as a panel arriving over the
    // screen you were on. with preventScroll both move 0px.
    (field ?? root).focus({ preventScroll: true });
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

  const hasTitle = Boolean(title && title.trim());

  return (
    <>
      <div
        onClick={onClose}
        className={open ? "pocket-fade-in" : "pocket-fade-out"}
        style={{
          position: "absolute",
          inset: 0,
          background: t.scrim,
          backdropFilter: "blur(6px) saturate(1.1)",
          WebkitBackdropFilter: "blur(6px) saturate(1.1)",
          zIndex: 30,
          // the backdrop is driven ONLY by the fade-in/out classes. an earlier inline
          // opacity tied to the drag looked nice mid-pull, but on a drag-to-dismiss
          // `grabbing` clears one frame before `open` does, so the dimmed backdrop
          // snapped back to full for that frame before the close faded it out, which
          // read as a black flash. the panel sliding down is the drag feedback; the
          // backdrop just fades.
        }}
      />
      <section
        ref={panel}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={keepFocusInside}
        className={
          `${entering && !grabbing ? "pocket-sheet-in" : ""}${still ? " pocket-still" : ""}`.trim() ||
          undefined
        }
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
          // the entrance runs as a CSS animation; once it is done, this inline
          // transform owns the sheet for drag and exit. the border-radius eases too,
          // so a sheet that grows to full height (MoveSheet menu -> review) rounds
          // its corners off over the same beat rather than squaring them in one frame.
          transform: `translateY(${y}px)`,
          transition: grabbing
            ? "none"
            : `transform ${SHEET_MS}ms ${motion.enter}, border-radius ${SHEET_MS}ms ${motion.enter}`,
        }}
      >
        <div
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabEnd}
          onPointerCancel={onGrabEnd}
          style={{
            cursor: grabbing ? "grabbing" : "grab",
            touchAction: "none",
            position: "relative",
            // one horizontal gutter shared with every full page (Screen/Home/
            // Settings all pad with space.gutter), so a Row inside a sheet sits
            // the same distance from the frame edge as the same Row on a page.
            padding: `${space.sm}px ${space.gutter}px 0`,
            flex: "0 0 auto",
          }}
        >
          {/* drag-to-dismiss and tap-outside are how a sheet is closed, and the
              handle says so. the grab area holds ONLY the handle, so the whole
              strip drags: an interactive control here (the close X used to sit on
              this line) makes part of the drag strip refuse the drag. */}
          <div aria-hidden style={grabHandle(t)} />
          {hasTitle && (
            // the close X rides the SAME row as the title, right-aligned, so a
            // title'd sheet keeps one header row, now with a way out.
            <div
              style={{ marginTop: space.md, display: "flex", alignItems: "center", gap: space.sm }}
            >
              <h2
                style={{
                  ...text.screenTitle,
                  color: t.text,
                  minWidth: 0,
                  margin: 0,
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                {title}
                {info}
              </h2>
              {!hideClose && (
                <IconButton t={t} size={30} label="Close" onClick={onClose}>
                  <CloseIcon size={17} />
                </IconButton>
              )}
            </div>
          )}
        </div>
        {!hasTitle && !hideClose && (
          // a headerless (full) sheet: the X sits in its OWN row just below the
          // drag handle, right-aligned. it is off the drag line (so the handle
          // strip drags cleanly) and reads as a header control rather than being
          // crammed onto the drag pill or pinned to the very top edge.
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              padding: `${space.xs}px ${space.gutter}px 0`,
              flex: "0 0 auto",
            }}
          >
            <IconButton t={t} size={30} label="Close" onClick={onClose}>
              <CloseIcon size={17} />
            </IconButton>
          </div>
        )}
        <div
          style={{
            // grows to fill the sheet so a pinned footer sits at the true bottom
            // even when the content is short; scrolls when the content is long.
            flex: "1 1 auto",
            padding: `${space.sm}px ${space.gutter}px ${footer ? space.md : space.lg}px`,
            overflowX: "hidden",
            overflowY: "auto",
            minHeight: 0,
          }}
        >
          {children}
        </div>
        {footer && (
          // an opaque bar flush with the sheet bottom, the same behaviour as the
          // wallet's bottom nav: it hides whatever scrolls under it and never
          // leaves a gap beneath the action.
          <div
            style={{
              flex: "0 0 auto",
              padding: `${space.md}px ${space.gutter}px ${space.lg}px`,
              background: t.sheet,
              boxShadow: `0 -16px 20px -14px ${t.sheet}`,
            }}
          >
            {footer}
          </div>
        )}
      </section>
    </>
  );
}
