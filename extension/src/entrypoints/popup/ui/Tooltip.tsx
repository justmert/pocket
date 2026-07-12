// an explanation that stays out of the way until asked for.
//
// the wallet used to write its reasoning into the screen: a paragraph under a
// balance, a caveat beside a yield figure, a list of effects on a confirm. that
// reads like documentation and buries the one number that matters. the rule now
// is that the UI states the fact and an info affordance carries the why, shown
// on hover and on focus, dismissed on leave and on escape.
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
  // a short close delay bridges the GAP between the icon and the bubble: the bubble
  // is PORTALED out of the wrapper (so a sheet's overflow cannot clip it), so moving
  // the pointer onto it would otherwise count as leaving the icon and close it.
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 90);
  };
  useEffect(() => () => cancelClose(), []);

  // a tap outside, or escape, closes it. hover-open alone would strand it open
  // on a touch device where there is no leave. the bubble is portaled, so an inside
  // tap must check the bubble too or scrolling the tip would dismiss it.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!wrap.current?.contains(target) && !bubble.current?.contains(target)) setOpen(false);
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

  // measure once open, in VIEWPORT coordinates, and render the bubble in a portal at
  // document.body with `position: fixed`. the portal escapes the confirm sheet's
  // `overflow: auto` (which clipped the bubble's top) AND the sheet's `translateY`
  // (which had made a plain fixed bubble land off-screen), because document.body has
  // no transformed ancestor between it and the bubble. it still opens on whichever
  // side has more room and caps to it, scrolling inside when the content is taller.
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
    const spaceAbove = anchor.top - GAP - EDGE;
    const spaceBelow = window.innerHeight - anchor.bottom - GAP - EDGE;
    const above = spaceAbove >= spaceBelow;
    const maxHeight = Math.max(72, Math.floor(above ? spaceAbove : spaceBelow));
    setPos({
      position: "fixed",
      left: targetLeft,
      width,
      maxHeight,
      ...(above ? { bottom: window.innerHeight - anchor.top + GAP } : { top: anchor.bottom + GAP }),
    });
  }, [open, children]);

  return (
    <span
      ref={wrap}
      style={{ position: "relative", display: "inline-flex", flex: "0 0 auto", lineHeight: 0 }}
      onPointerEnter={() => {
        cancelClose();
        setOpen(true);
      }}
      onPointerLeave={scheduleClose}
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
          // the "i" stands OFF its page: a DARK filled disc in the light pocket, a
          // VERY LIGHT disc in the dark pocket, each with a contrasting glyph, so it
          // reads clearly against either background.
          background: t.dark ? t.accentOnSoft : t.accent,
          color: t.dark ? t.accentSoft : t.onAccent,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Info size={Math.round(size * 0.72)} sw={2.2} />
      </button>
      {open &&
        createPortal(
          <span
            id={id}
            ref={bubble}
            role="tooltip"
            className="pocket-fade-in"
            onPointerEnter={cancelClose}
            onPointerLeave={scheduleClose}
            style={{
            // its own tone, OFF the surface/sheet it opens over, so the explanation
            // reads as a layer rather than the card: a touch darker than the light
            // page, a touch lighter than the dark surface (see `tip` in theme).
            background: t.tip,
            color: t.text,
            border: `1px solid ${t.line}`,
            ...text.caption,
            // the tooltip reads at 13, one up from the caption's 12, for comfortable
            // body reading in the bubble.
            fontSize: 13,
            lineHeight: 1.45,
            padding: `${space.sm}px ${space.md}px`,
            borderRadius: radius.md,
            // the canonical raised-surface shadow, per pocket, rather than a
            // hand-written rgba that had drifted from every other raised surface.
            boxShadow: t.shadow,
            // portaled to body, above every sheet/backdrop/menu (which top out at 41).
            zIndex: 2000,
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
            ...(pos ?? { position: "fixed", top: -9999, left: -9999, width: TIP_W }),
          }}
        >
          {children}
        </span>,
          document.body,
        )}
    </span>
  );
}
