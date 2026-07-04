// the floating bar.
//
// five slots, the same five in both pockets, so switching pockets never moves a
// control out from under a finger. what the middle action MEANS changes with the
// pocket, and the accent it is wearing is what says which.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { useWallet } from "./WalletProvider";
import { radius, space, type Theme } from "./theme";
import { Gear, HomeIcon, QrIcon, Send, Shield } from "./icons";

export function BottomNav() {
  const w = useWallet();
  const t = w.t;
  // chrome zooms to 500%, which leaves the popup 160px wide. five controls at
  // their normal size cannot fit that, and a control that does not fit is a
  // control that is gone, so they shrink with the window rather than spill.
  const compact = useCompact();
  const tile = compact ? 30 : 50;
  const glyph = compact ? 18 : 22;
  const fab = compact ? 36 : 54;
  const onHome = w.tab === "home";
  const onSettings = w.tab === "settings";
  const receiveOpen = w.sheets.includes("receive");
  const moveOpen = w.sheets.includes("move");

  return (
    <>
      <div aria-hidden style={fade(t)} />
      <nav aria-label="Wallet" style={bar(t, compact)}>
        <Tile
          t={t}
          width={tile}
          label="Home"
          active={onHome && w.sheets.length === 0}
          onClick={() => {
            w.closeAllSheets();
            w.setTab("home");
          }}
        >
          <HomeIcon size={glyph} />
        </Tile>
        <Tile t={t} width={tile} label="Receive" active={receiveOpen} onClick={() => w.openSheet("receive")}>
          <QrIcon size={glyph} />
        </Tile>
        <button
          type="button"
          aria-label={w.pocket === "private" ? "Send privately" : "Send"}
          onClick={() => w.openSheet("send")}
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: "pointer",
            width: fab,
            height: fab,
            borderRadius: "50%",
            background: t.accentFill,
            color: t.onAccent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "0 0 auto",
            boxShadow: `0 0 22px -2px ${t.accentLine}`,
          }}
        >
          <Send size={Math.round(glyph * 1.1)} />
        </button>
        <Tile t={t} width={tile} label="Move" active={moveOpen} onClick={() => w.openSheet("move")}>
          <Shield size={glyph} />
        </Tile>
        <Tile
          t={t}
          width={tile}
          label="Settings"
          active={onSettings && w.sheets.length === 0}
          onClick={() => {
            w.closeAllSheets();
            w.setTab("settings");
          }}
        >
          <Gear size={glyph} />
        </Tile>
      </nav>
    </>
  );
}

function Tile({
  t,
  label,
  active,
  onClick,
  width,
  children,
}: {
  t: Theme;
  label: string;
  active: boolean;
  onClick: () => void;
  width: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onClick={onClick}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        width,
        height: 44,
        minWidth: 0,
        borderRadius: radius.md,
        background: active ? t.accentSoft : "transparent",
        color: active ? (t.dark ? t.accent : t.text) : t.faint,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        transition: "background 200ms ease, color 200ms ease",
      }}
    >
      {children}
    </button>
  );
}

/** rows dissolve into the surface above the bar instead of cutting at its edge. */
function fade(t: Theme): CSSProperties {
  const to = t.bg;
  return {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: 100,
    background: `linear-gradient(to bottom, ${hexAlpha(to, 0)} 0%, ${to} 32%, ${to} 100%)`,
    pointerEvents: "none",
    zIndex: 6,
  };
}

function bar(t: Theme, compact: boolean): CSSProperties {
  return {
    position: "absolute",
    left: compact ? space.xs : space.md,
    right: compact ? space.xs : space.md,
    bottom: compact ? space.xs : space.md,
    height: 66,
    borderRadius: radius.xl,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-around",
    padding: `0 ${compact ? 2 : space.sm}px`,
    zIndex: 7,
    background: t.bar,
    backdropFilter: "blur(24px) saturate(1.7)",
    WebkitBackdropFilter: "blur(24px) saturate(1.7)",
    border: t.dark ? "1px solid rgba(255,255,255,0.07)" : "1px solid rgba(20,21,26,0.05)",
    boxShadow: t.dark
      ? "0 10px 38px -8px rgba(0,0,0,0.7)"
      : "0 10px 34px -12px rgba(20,21,26,0.28)",
  };
}

/** the fade needs the frame colour at zero alpha, and both themes give a hex. */
function hexAlpha(hex: string, alpha: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** how much room a screen must leave at its bottom for the bar. */
export const NAV_SPACE = 100;

/** true once the window is too narrow for the bar at its normal size. */
function useCompact(): boolean {
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const measure = () => setCompact(window.innerWidth < 300);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, []);
  return compact;
}
