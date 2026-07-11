// an explanation that stays out of the way until asked for.
//
// the wallet used to write its reasoning into the screen: a paragraph under a
// balance, a caveat beside a yield figure, a list of effects on a confirm. that
// reads like documentation and buries the one number that matters. the rule now
// is that the UI states the fact and an info affordance carries the why, shown
// on hover and on focus, dismissed on leave and on escape.
import { useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { radius, space, text, type Theme } from "./theme";

/**
 * a small "i" that reveals `children` on hover or focus.
 *
 * the bubble opens ABOVE the icon and anchors to its right edge, so it grows
 * up-and-left and stays inside the 384px frame, where these icons sit at the end
 * of a heading or a row. tap toggles it, for a pointer with no hover.
 */
export function InfoTip({
  t,
  label,
  children,
  size = 18,
}: {
  t: Theme;
  /** what the icon is, for a screen reader. e.g. "About this balance". */
  label: string;
  children: ReactNode;
  size?: number;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);

  // a tap outside, or escape, closes it. hover-open alone would strand it open
  // on a touch device where there is no leave.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span
      ref={wrap}
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto", lineHeight: 0 }}
      onPointerEnter={() => setOpen(true)}
      onPointerLeave={() => setOpen(false)}
    >
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? id : undefined}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onClick={() => setOpen((o) => !o)}
        style={{
          all: "unset",
          boxSizing: "border-box",
          cursor: "pointer",
          width: size,
          height: size,
          borderRadius: "50%",
          background: t.field,
          color: t.faint,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: Math.round(size * 0.66),
          fontWeight: 700,
          fontStyle: "italic",
          fontFamily: "Georgia, 'Times New Roman', serif",
        }}
      >
        i
      </button>
      {open && (
        <span
          id={id}
          role="tooltip"
          style={{
            position: "absolute",
            bottom: "calc(100% + 8px)",
            right: 0,
            width: 240,
            maxWidth: "70vw",
            background: t.dark ? "#26232F" : "#2A2A2E",
            color: "#F2F1EE",
            ...text.caption,
            lineHeight: 1.45,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            boxShadow: "0 10px 30px -12px rgba(0,0,0,0.55)",
            zIndex: 60,
            pointerEvents: "none",
            textAlign: "left",
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}
