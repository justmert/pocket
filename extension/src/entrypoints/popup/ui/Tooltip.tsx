// an explanation that stays out of the way until asked for.
//
// the wallet used to write its reasoning into the screen: a paragraph under a
// balance, a caveat beside a yield figure, a list of effects on a confirm. that
// reads like documentation and buries the one number that matters. the rule now
// is that the UI states the fact and an info affordance carries the why, shown
// on hover and on focus, dismissed on leave and on escape.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { FRAME, radius, space, text, type Theme } from "./theme";
import { Info } from "./icons";

// the gap between the icon and the bubble, and the minimum margin the bubble
// keeps from the frame edges. the bubble is measured and clamped into the frame
// rather than anchored to the icon's right edge, which overflowed the moment an
// info icon sat anywhere but the far right of a row (a settings title, a prompt).
const GAP = 8;
const EDGE = 8;
const TIP_W = 240;

/**
 * a small "i" that reveals `children` on hover or focus.
 *
 * the bubble is positioned with `position: fixed` from the icon's measured rect
 * and its left edge is CLAMPED into the 384px frame, so it never spills past the
 * left or right edge wherever the icon happens to sit. it opens above the icon
 * when there is room and below when there is not. tap toggles it, for a pointer
 * with no hover.
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
  const [pos, setPos] = useState<CSSProperties | null>(null);
  const id = useId();
  const wrap = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);

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

  // measure once open: clamp the bubble's viewport-left into the frame, then
  // express it as an offset from the wrapper. ABSOLUTE (relative to the wrapper),
  // not fixed: a `position: fixed` bubble is positioned against the nearest
  // transformed ancestor, and every sheet has a `translateY`, so a fixed tooltip
  // inside a sheet landed off-screen and read as "not opening". absolute is
  // transform-safe because it and the wrapper share the same transformed space.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const anchor = wrap.current?.getBoundingClientRect();
    if (!anchor) return;
    const frameW = Math.min(FRAME.width, window.innerWidth);
    const width = Math.min(TIP_W, frameW - 2 * EDGE);
    const targetLeft = Math.max(EDGE, Math.min(anchor.right - width, frameW - width - EDGE));
    const left = targetLeft - anchor.left;
    // open on whichever side of the icon has more vertical room, and CAP the
    // bubble to that room. without the cap a tall explanation (a full "what this
    // does" list) in a small/zoomed popup spilled past the window edge and its top
    // was cut off; capped with an inner scroll, it always fits and scrolls itself.
    const spaceAbove = anchor.top - GAP - EDGE;
    const spaceBelow = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = spaceAbove >= spaceBelow;
    const maxHeight = Math.max(72, Math.floor(above ? spaceAbove : spaceBelow));
    setPos({
      position: "absolute",
      left,
      width,
      maxHeight,
      ...(above ? { bottom: `calc(100% + ${GAP}px)` } : { top: `calc(100% + ${GAP}px)` }),
    });
  }, [open, children]);

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
        className="pk-tap"
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
        }}
      >
        <Info size={Math.round(size * 0.72)} sw={2.2} />
      </button>
      {open && (
        <span
          id={id}
          ref={bubble}
          role="tooltip"
          className="pocket-fade-in"
          style={{
            // the wallet's own surface, not a stray charcoal that belonged to no
            // theme. a card with a hairline and a soft shadow, light in light and
            // dark in dark, so it reads as part of the product.
            background: t.surface,
            color: t.text,
            border: `1px solid ${t.line}`,
            ...text.caption,
            lineHeight: 1.45,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            // the canonical raised-surface shadow, per pocket, rather than a
            // hand-written rgba that had drifted from every other raised surface.
            boxShadow: t.shadow,
            zIndex: 60,
            // scroll inside the bubble when its content is taller than the room it
            // was capped to (maxHeight, from `pos`): a long "what this does" in a
            // small/zoomed popup then fits and scrolls instead of being cut off.
            // `auto` (not `none`) so a tapped-open tip can actually be scrolled.
            pointerEvents: "auto",
            overflowY: "auto",
            overscrollBehavior: "contain",
            textAlign: "left",
            // measured on open; until then it is placed off the flow so its first
            // paint (used to read its own height) does not flash at the corner.
            ...(pos ?? { position: "absolute", top: -9999, left: -9999, width: TIP_W }),
          }}
        >
          {children}
        </span>
      )}
    </span>
  );
}
