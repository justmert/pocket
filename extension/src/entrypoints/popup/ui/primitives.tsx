import type { CSSProperties, ReactNode } from "react";
import { FRAME, fontSizes, leading, motion, radius, sans, space, text, type Theme } from "./theme";

export function Frame({ t, children }: { t: Theme; children: ReactNode }) {
  return (
    <div
      style={{
        width: FRAME.width,
        // Fixed, not a minimum. Chrome caps a toolbar popup at 600px and then
        // scrolls the BODY, which drags the header off the top of the window.
        // A fixed frame keeps the header put and lets the content scroll under
        // it, the same way on every screen.
        height: FRAME.height,
        background: t.bg,
        color: t.text,
        fontFamily: sans,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
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
    padding: "13px 16px",
    borderRadius: radius.lg,
    border: "1px solid transparent",
    cursor: disabled ? "not-allowed" : "pointer",
    fontFamily: sans,
    transition: `transform ${motion.press} ${motion.ease}, background ${motion.press} ${motion.ease}`,
  };
  const variants: Record<string, CSSProperties> = {
    primary: { background: t.accent, color: t.onAccent },
    quiet: { background: t.field, color: t.text, borderColor: t.line },
    danger: { background: t.danger, color: "#FFFFFF" },
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
        gridTemplateColumns: "1fr 1fr",
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
  return <div style={{ display: "grid", gap: space.md, marginTop: space.gutter }}>{children}</div>;
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
    outline: "none",
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
      }}
    >
      <span style={{ ...text.heading, color: t.text }}>{title}</span>
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
export function Loading({ label, t }: { label: string; t: Theme }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.sm, minHeight: 24 }}>
      <Spinner t={t} />
      <span style={{ ...text.body, color: t.sub }}>{label}</span>
    </div>
  );
}
