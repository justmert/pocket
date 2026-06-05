import type { CSSProperties, ReactNode } from "react";
import { FRAME, sans, text, type Theme } from "./theme";

export function Frame({ t, children }: { t: Theme; children: ReactNode }) {
  return (
    <div
      style={{
        width: FRAME.width,
        minHeight: FRAME.height,
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
  t,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "quiet" | "danger";
  t: Theme;
}) {
  const base: CSSProperties = {
    ...text.button,
    width: "100%",
    padding: "13px 16px",
    borderRadius: 12,
    border: "none",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.45 : 1,
    fontFamily: sans,
    transition: "transform 0.12s ease",
  };
  const variants: Record<string, CSSProperties> = {
    primary: { background: t.accent, color: t.onAccent },
    quiet: { background: t.field, color: t.text, border: `1px solid ${t.line}` },
    danger: { background: t.danger, color: "#fff" },
  };
  return (
    <button style={{ ...base, ...variants[variant] }} onClick={onClick} disabled={disabled}>
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
    borderRadius: 10,
    border: `1px solid ${t.line}`,
    background: t.field,
    color: t.text,
    fontFamily: sans,
    fontSize: 15,
    outline: "none",
    resize: "none",
    boxSizing: "border-box",
  };
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <div style={{ ...text.label, color: t.sub, marginBottom: 6 }}>{label}</div>
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
  tone?: "info" | "exposed" | "danger";
  children: ReactNode;
  t: Theme;
}) {
  const tones = {
    info: { bg: t.field, fg: t.sub, border: t.line },
    exposed: { bg: t.exposedBg, fg: t.exposed, border: "transparent" },
    danger: { bg: "rgba(179,38,30,0.10)", fg: t.danger, border: "transparent" },
  } as const;
  const c = tones[tone];
  return (
    <div
      style={{
        ...text.body,
        background: c.bg,
        color: c.fg,
        border: `1px solid ${c.border}`,
        borderRadius: 10,
        padding: "10px 12px",
        lineHeight: 1.5,
        marginBottom: 14,
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

export function Spinner({ t }: { t: Theme }) {
  return (
    <div
      style={{
        width: 18,
        height: 18,
        border: `2px solid ${t.line}`,
        borderTopColor: t.accent,
        borderRadius: "50%",
        animation: "pocket-spin 0.7s linear infinite",
      }}
    />
  );
}
