// the shared visual vocabulary. every screen and sheet composes these, so a
// button, a field or a sheet is the same object wherever it appears.
import { useEffect, useId, useRef, useState } from "react";
import type { ButtonHTMLAttributes, CSSProperties, Ref, ReactNode, UIEventHandler } from "react";
import {
  chipPad,
  FRAME,
  fonts,
  motion,
  radius,
  ROW_STAGGER_MS,
  space,
  text,
  type Theme,
} from "./theme";
import { Back as BackIcon, Close as CloseIcon } from "./icons";
import { escapeClaimed } from "./escapeLayers";

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
        // the glow rides as an IMAGE over the pocket's flat colour, so the colour
        // is what crosses on a pocket switch. handed as one `background` shorthand
        // it was opaque and covered `Frame`'s 620ms crossfade entirely, which is
        // why that transition measured 0ms on every surface a user can see.
        backgroundColor: "var(--pocket-bg)",
        backgroundImage: background,
        transition: `background-color ${motion.pocket} ${motion.enter}`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/**
 * a full-frame ROUTE: a header that stays put over a body that scrolls.
 *
 * Eight screens opened with the identical two lines, the identical header block
 * and the identical scroll body, and `Screen` does not cover it, which is exactly
 * why eight of them hand-rolled the three-part version. The gain is not tidiness:
 * nothing on those eight told a user that content continued below the fold
 * (scrollbars are hidden by design, and no screen drew any other cue), and here
 * that is one place to add rather than eight to remember.
 *
 * `header` and `children` are slots and nothing is decided inside, so the prop
 * surface cannot grow into a kitchen sink.
 */
export function Route({
  t,
  header,
  children,
}: {
  t: Theme;
  header: ReactNode;
  children: ReactNode;
}) {
  return (
    <Frame t={t} className="pocket-page">
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>{header}</div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            overflowX: "hidden",
            overflowY: "auto",
            padding: `0 ${space.gutter}px`,
            // the one cue that content continues. the frame hides its scrollbars
            // (384px cannot afford the gutter), so a route that overflowed looked
            // exactly like one that ended: the last row simply stopped at the
            // bottom edge. a short fade at the foot says otherwise, and it is
            // masked away as the end is reached.
            maskImage: "linear-gradient(to bottom, #000 calc(100% - 24px), transparent 100%)",
          }}
        >
          {children}
        </div>
      </div>
    </Frame>
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
        // BOTH, not one or the other. `.pocket-still`'s selector excludes the
        // element it is on (`.pocket-still *`), which is exactly so the two can
        // compose: the screen still settles into place, and nothing INSIDE it
        // moves while someone reads what they are about to make permanent. as an
        // either/or, five of the calmest screens in the product hard-cut in.
        className={still ? "pocket-page pocket-still" : "pocket-page"}
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
  dense = false,
}: {
  t: Theme;
  title?: string;
  /** a quiet second line under the title, e.g. the direction a Move is headed. */
  subtitle?: ReactNode;
  onBack?: () => void;
  right?: ReactNode;
  /** a title-only header in a PINNED band (Activity, Settings), where the 44px
   *  back-button row and the full bottom margin are dead height that push the
   *  content-cut line down. drops both; the pinned block's own padding sets the
   *  gap, and there is no back button to keep the 44px target for. */
  dense?: boolean;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.md,
        minHeight: dense ? undefined : 44,
        marginBottom: dense ? 0 : space.gutter,
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
    quiet: { background: t.field, color: t.text },
    // `onDanger`, NOT `onAccent`. they coincide in the public pocket, which is why
    // this read as fine from there, and in the private pocket `onAccent` #fcfdfe on
    // `danger` #fb6e64 is 2.74:1 against `onDanger`'s 7.48:1. every logged-out
    // screen renders under the private theme, so the coral fill is the one always
    // in force on Recover: the lowest-contrast text in the product was the label
    // on the button that erases the wallet.
    danger: { background: t.danger, color: t.onDanger, boxShadow: glow },
  };
  // one place decides scale: the block CTA fills its column at 52px on the button
  // role; the pill hugs its label at chip scale. everything else (fill, radius,
  // reset) is shared below, so the two sizes cannot drift in anything but size.
  const sized: CSSProperties =
    size === "pill"
      ? // a pill hugs its label on ONE line and never gives up width to a sibling: in
        // a prompt row next to a shrinking title it was being squeezed until "Set up"
        // and "Get XLM" broke onto two lines. nowrap + no-shrink keeps it a chip; the
        // title beside it is the one that ellipsises.
        { ...text.chip, width: "auto", padding: "8px 14px", whiteSpace: "nowrap", flexShrink: 0 }
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
      // PREVENT DEFAULT, not merely "no handler". Dropping `onClick` stops
      // React calling the handler and does nothing about the browser's own
      // behaviour: a `type="submit"` button keeps its default action, and the
      // HTML spec's implicit submission fires a click on the default button
      // when Enter is pressed in a field. So a busy submit could still be
      // driven from the keyboard, and the "blocks a second press" this prop
      // documents held for the mouse only.
      onClick={
        off
          ? (e) => {
              e.preventDefault();
            }
          : rest.onClick
      }
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
      className="pk-tap"
      style={{
        all: "unset",
        cursor: "pointer",
        // `all: unset` computes to `display: inline`, and a transform does not
        // apply to a non-replaced inline box, so the global press scale was
        // silently dropped here. inline-block restores it without changing the
        // flow at any of the call sites.
        display: "inline-block",
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
    // a resting hairline only where it is NEEDED: on a light `surface` card (unlock)
    // the pale fill and the card are the same value, so without an edge the field
    // disappears. on a dark pocket the fill is already lighter than the surface, so a
    // border there is a redundant box (the "ring" a field does not need) and is
    // dropped. no focus ring either way: the stylesheet suppresses it.
    border: `1px solid ${invalid ? t.danger : t.dark ? "transparent" : t.line}`,
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
          className="pk-field"
          {...verbatim}
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoFocus={autoFocus}
          aria-describedby={described}
          aria-invalid={invalid || undefined}
          rows={3}
          // `onSubmit` works here too. The prop is accepted by every Field and
          // was wired only to the single-line branch, so a caller that passed
          // it to a multiline one got no error, no warning, and no behaviour:
          // the field simply never submitted.
          //
          // Enter WITH A MODIFIER, not bare Enter. A textarea is where a
          // recovery phrase is typed, and a plain Enter there has to keep
          // inserting a newline or pasting a phrase across lines becomes
          // impossible; cmd/ctrl+Enter is the ordinary convention for "send
          // this" in a multiline field.
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && onSubmit) {
              e.preventDefault();
              onSubmit();
            }
          }}
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
          className={trailing ? "pk-field" : undefined}
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
            className={trailing ? undefined : "pk-field"}
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
    // borderless: the accent card reads by its accentSoft fill alone (a clear tint in
    // both pockets), so it drops the hairline that made it look like an old outlined
    // card. surface/field keep theirs for now (a white surface card needs the edge on
    // the near-white public page).
    accent: { background: t.accentSoft },
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
          {/* the same figure treatment as the line above it. this column is a
              column of dollar amounts sitting directly under a column of asset
              amounts, and it was set in a prose role while the one above declares
              `tabular-nums`, so the two jittered against each other as digits
              changed. three hand-patches elsewhere in the tree already add this
              per call site. */}
          {valueSub && (
            <span
              style={{
                ...text.rowSub,
                fontVariantNumeric: "tabular-nums lining-nums",
                color: t.sub,
                display: "block",
              }}
            >
              {valueSub}
            </span>
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
  //
  // and an <h2>, not a <div>. the comment already said they "look like headings"
  // and nothing in the tree said they WERE: Home's whole heading outline was the
  // wordmark, so a screen reader jumping by heading found one item on the busiest
  // screen in the product.
  return (
    <h2 style={{ ...text.heading, color: t.text, margin: `0 0 ${space.sm}px` }}>{children}</h2>
  );
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
        padding: chipPad.badge,
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
    // the exposed/info banner reads like the receive-address block: the neutral field
    // fill with plain readable text, NOT a low-contrast tint-on-tint. the "this is
    // public" signal is carried by the inline exposed-coloured markers, not the banner.
    exposed: { bg: t.field, fg: t.text },
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

/**
 * "there is nothing here", said the same way everywhere.
 *
 * Six empty states shared no structure and drew the same kind of sentence in
 * `t.faint` on three surfaces and `t.sub` on three, with no comment anywhere
 * explaining the split. The icon is optional, the action is optional, and the
 * sentence is the one required part.
 */
export function EmptyState({
  t,
  icon,
  children,
  action,
}: {
  t: Theme;
  icon?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: space.md,
        padding: `${space.xl}px 0`,
        textAlign: "center",
      }}
    >
      {icon && (
        <span aria-hidden style={{ color: t.faint, display: "flex" }}>
          {icon}
        </span>
      )}
      <span style={{ ...text.body, color: t.sub }}>{children}</span>
      {action}
    </div>
  );
}

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
        // `color` paints the RING. It painted the gap: `borderColor` was pinned
        // to `currentColor` and the caller's colour went to `borderTopColor`,
        // which is the quarter deliberately left out to make the ring look like
        // it is spinning. So the two History call sites that pass a theme
        // colour got a currentColor ring with a coloured notch, the opposite of
        // what they asked for.
        //
        // With no `color` this is byte-identical to what it was: ring in
        // currentColor, gap transparent.
        borderColor: color ?? "currentColor",
        borderTopColor: "transparent",
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
  // the SMALL stop from the radius scale, not a hand-picked 8 that is on no
  // scale at all. a placeholder's whole job is to be the shape of what replaces
  // it, and every card and row it stands in for is rounded from `radius`.
  radius: r = radius.sm,
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
export function Toast({
  t,
  message,
  tone = "neutral",
}: {
  t: Theme;
  message: string | null;
  tone?: "neutral" | "positive";
}) {
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
        // neutral is an inverse of the surface (a dark pill on light, light on dark);
        // positive is the pocket's own solid accent, so a success confirmation reads
        // as themed rather than as a generic dark box.
        background: tone === "positive" ? t.accentFill : t.text,
        color: tone === "positive" ? t.onAccent : t.bg,
        padding: "11px 18px",
        // NOT radius.pill. a pill radius (999) rounds a one-line toast into a clean
        // capsule, but a WRAPPED multi-line message (the fund-testnet result, "this
        // account already exists...") is a tall box, and 999 rounds it into an
        // ellipse/blob. xl (24) is more than half a single line's height, so a short
        // toast still reads as a capsule while a multi-line one gets honest rounded
        // corners instead of a blob.
        borderRadius: radius.xl,
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
  /**
   * the dialog's accessible NAME, when it is not the visible title.
   *
   * six sheets announced as a dialog with no name: two pass no `title` and four
   * pass `title=" "`, which the accessible-name computation discards and which
   * buys nothing visually either, since `hasTitle` is already false for a blank.
   */
  ariaLabel,
  still = false,
  /**
   * whether the header can be pulled down to dismiss.
   *
   * false while a confirm sheet is working: its `onClose` is a no-op then, so a
   * drag would take the dismiss branch, call nothing, and strand the panel at its
   * dragged offset. see `onGrabDown`.
   */
  dismissible = true,
  /** a small info affordance rendered beside the title, e.g. an InfoTip whose
   *  hover carries a consequence that used to sit as a paragraph in the body. */
  info,
  /** fired once the sheet has finished its slide-down and unmounted its content.
   *  lets a caller sequence something AFTER the exit (e.g. leaving a full-frame
   *  route) rather than during it, so the close animates instead of being cut. */
  onClosed,
  /** drop the close X. for a sheet whose own buttons are the only way out (a
   *  confirm: Cancel while reviewing, Go home while it works, Done after), so a
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
  ariaLabel?: string;
  still?: boolean;
  dismissible?: boolean;
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
  // the drag-dismiss backstop below reads `open` from a timer, after the render
  // that scheduled it; a ref is the only copy that is current when it fires.
  const openRef = useRef(open);
  openRef.current = open;
  const stuck = useRef<ReturnType<typeof setTimeout>>(undefined);

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
      clearTimeout(stuck.current);
    };
  }, [open, mounted]);

  // grab the header and pull down to dismiss; released short of the threshold it
  // springs back.
  const onGrabDown = (e: React.PointerEvent<HTMLElement>) => {
    // a sheet that cannot be closed cannot be dragged either. every confirm sheet
    // passes `onClose={busy ? () => undefined : ...}` while a transaction is in
    // flight, so a >90px pull took the dismiss branch, called a no-op, skipped
    // `setY(0)`, and left the panel parked at its dragged offset: the mount
    // effect that resets `y` keys on `[open, mounted]` and neither had changed.
    // inside a 384x600 frame with `overflow: hidden`, that pushes "Go home"
    // off the bottom during the one window where the product deliberately
    // removes every other exit, and the receipt then draws in the same displaced
    // panel. refusing the grab is better than always calling `setY(0)`, which
    // reintroduces the snap this one-transform design exists to avoid.
    if (!dismissible) return;
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
    if (!dismiss) {
      setY(0);
      return;
    }
    onClose();
    // ...and check that it actually closed.
    //
    // `dismissible` above stops the known case (a confirm sheet mid-flight),
    // but it puts the invariant in the CALLER's hands: any sheet whose
    // `onClose` declines, or whose parent ignores it, leaves the panel parked
    // at the drag offset with nothing to reset it, because the mount effect
    // keys on `[open, mounted]` and neither changed. Inside a 384x600 frame
    // with `overflow: hidden` that pushes the sheet's own buttons off the
    // bottom of the screen.
    //
    // A snap back is the thing this one-transform design exists to avoid, so
    // it happens only when the sheet is demonstrably still open a frame later,
    // which is to say only when the alternative is a stranded panel.
    clearTimeout(stuck.current);
    stuck.current = setTimeout(() => {
      if (openRef.current) setY(0);
    }, SHEET_MS);
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

  // ...and give it BACK on close.
  //
  // A modal takes focus on open, which is right, and every dismissal dropped it
  // on the floor: with the sheet gone the focused node is gone with it, so the
  // browser falls back to `document.body` and the next Tab starts from the top
  // of the page. A keyboard user who opened a sheet from the fourth control on
  // a screen had to walk back to it every time, and a screen-reader user was
  // returned to nothing at all with no announcement.
  //
  // Remembered on the way IN, restored on the way OUT, and only if the element
  // is still in the document: a sheet opened from a row that has since been
  // re-rendered has nothing to go back to, and focusing a detached node is
  // worse than leaving it.
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) {
      const active = document.activeElement;
      // Not something inside the sheet itself: on a re-entrant open that would
      // remember the sheet's own control and restore focus into a dead tree.
      if (active instanceof HTMLElement && !panel.current?.contains(active)) {
        returnTo.current = active;
      }
      return;
    }
    const back = returnTo.current;
    returnTo.current = null;
    if (back && back.isConnected) back.focus({ preventScroll: true });
  }, [open]);

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
      if (e.key !== "Escape") return;
      // ...but only if this sheet IS the top. an InfoTip inside a confirm
      // sheet is above it and claims Escape while it is open; both listened on
      // `window`, so one keypress aimed at the tip also cancelled the confirm
      // and discarded the staged transaction behind it.
      if (escapeClaimed()) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!mounted) return null;

  const hasTitle = Boolean(title && title.trim());

  return (
    <>
      <div
        onClick={() => onClose()}
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
        aria-label={ariaLabel ?? (title && title.trim() ? title : undefined)}
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
          // transform owns the sheet for drag and exit.
          //
          // the `border-radius` term is GONE: `full` is a prop, not state, so the
          // radius never changes on a mounted sheet, and the one case the old
          // comment named (MoveSheet menu -> review) is a case `MoveSheet` forbids
          // in its own comment. a transition on a value that cannot change is a
          // claim about a motion nobody can see.
          transform: `translateY(${y}px)`,
          transition: grabbing ? "none" : `transform ${SHEET_MS}ms ${motion.enter}`,
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
            // the same distance from the frame edge as the same Row on a page. a
            // headerless sheet adds a little bottom room so the thin handle keeps a
            // comfortable drag target; a titled sheet's title row already has height.
            padding: `${space.sm}px ${space.gutter}px ${hasTitle ? 0 : space.xs}px`,
            flex: "0 0 auto",
          }}
        >
          {/* drag-to-dismiss and tap-outside are how a sheet is closed, and the
              handle says so. the grab area holds ONLY the handle, so the whole
              strip drags: an interactive control here (the close X used to sit on
              this line) makes part of the drag strip refuse the drag. */}
          {/* a crisp thin bar in every sheet. it used to be inflated to a 32px box
              on a headerless sheet (paddingBlock + backgroundClip) to enlarge the
              drag target, but a pill radius on that tall box rendered as an ellipse
              rather than a line and stacked empty space above the close X. the whole
              strip is already the drag target (the handlers sit on it), so the strip
              carries the height and the bar stays a bar. */}
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
              {/* `() => onClose()`, never `onClose` itself. React hands a click
                  handler the EVENT as its first argument, and every sheet in
                  the app is mounted with `onClose={w.closeSheet}`, whose
                  signature is `(id?: SheetId)`. Passed bare, the X called
                  `closeSheet(mouseEvent)`, the "is this still the sheet on top"
                  guard compared an event to a string, decided no, and returned
                  the stack unchanged: the close button on every titled sheet in
                  the wallet did nothing at all. */}
              {!hideClose && (
                <IconButton t={t} size={30} label="Close" onClick={() => onClose()}>
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
              // no top padding: the drag strip's own bottom padding already sets the
              // gap to the handle, and the old top pad added to the empty band above
              // the X that made a headerless sheet's top read as wasted space.
              padding: `0 ${space.gutter}px 0`,
              flex: "0 0 auto",
            }}
          >
            <IconButton t={t} size={30} label="Close" onClick={() => onClose()}>
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
