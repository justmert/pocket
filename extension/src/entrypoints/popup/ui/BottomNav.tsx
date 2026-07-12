// the floating bar.
//
// five slots, the same five in both pockets, so switching pockets never moves a
// control out from under a finger. what the middle action MEANS changes with the
// pocket, and the accent it is wearing is what says which.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useWallet, type SheetId } from "./WalletProvider";
import { useLeave } from "./primitives";
import { radius, space, type Theme } from "./theme";
import {
  BridgeIn,
  BridgeOut,
  Clock,
  Gear,
  HomeIcon,
  Plus,
  QrIcon,
  Send,
  Shield,
  SwapIcon,
  Unshield,
} from "./icons";
import { NETWORKS } from "../../../core/config";

export function BottomNav() {
  const w = useWallet();
  const t = w.t;
  // chrome zooms to 500%, which leaves the popup 160px wide. five controls at
  // their normal size cannot fit that, and a control that does not fit is a
  // control that is gone, so they shrink with the window rather than spill.
  const compact = useCompact();
  const [menuOpen, setMenuOpen] = useState(false);
  const tile = compact ? 30 : 50;
  const glyph = compact ? 18 : 22;
  const fab = compact ? 36 : 54;
  const onHome = w.tab === "home";
  const onHistory = w.tab === "history";
  const onSettings = w.tab === "settings";
  const receiveOpen = w.sheets.includes("receive");
  // both pockets now open a menu from the FAB. the private pocket lists the three
  // ways value moves between pockets (shield / send / unshield); the public pocket
  // lists its outward actions (send, swap, and the two cross-chain legs). the plus
  // turns into a close in either case, so the control means the same thing.
  const isPrivate = w.pocket === "private";
  const showMenu = menuOpen;
  // keep the menu mounted through its exit so it fades out instead of blinking away
  // while the FAB un-rotates over empty space.
  const menu = useLeave(showMenu, 200);

  const pick = (sheet: SheetId) => {
    setMenuOpen(false);
    w.openSheet(sheet);
  };
  const onFab = () => setMenuOpen((open) => !open);

  // the actions the FAB menu lists, per pocket. one shape and one component
  // (FabMenu) render both, so the two menus are the SAME icon row and can never
  // drift: private lists the three ways value moves between pockets; public lists
  // its outward actions, each with its own glyph (the two cross-chain legs never
  // share one). swap only appears where a swap venue is configured.
  const swapAvailable = Boolean(w.status && NETWORKS[w.status.network].aquarius);
  const menuItems: { key: SheetId; label: string; icon: ReactNode }[] = isPrivate
    ? [
        { key: "moveIn", label: "Shield", icon: <Shield size={24} /> },
        { key: "send", label: "Send", icon: <Send size={24} /> },
        { key: "moveOut", label: "Unshield", icon: <Unshield size={24} /> },
      ]
    : [
        { key: "send", label: "Send", icon: <Send size={24} /> },
        ...(swapAvailable
          ? [{ key: "swap" as SheetId, label: "Swap", icon: <SwapIcon size={24} /> }]
          : []),
        { key: "cctpSend", label: "Send to a chain", icon: <BridgeOut size={24} /> },
        { key: "cctpClaim", label: "Claim from a chain", icon: <BridgeIn size={24} /> },
      ];

  // Escape closes the open menu, the same as a tap on the catcher behind it: a
  // popup menu the keyboard cannot dismiss is a trap for anyone not on a mouse.
  useEffect(() => {
    if (!showMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showMenu]);

  return (
    <>
      <div aria-hidden style={fade(t)} />
      {menu.render && (
        <>
          {/* a transparent catcher: one tap outside closes the menu, and the
              screen behind it is NOT dimmed. */}
          <div
            aria-hidden
            onClick={() => setMenuOpen(false)}
            style={{ position: "absolute", inset: 0, zIndex: 8 }}
          />
          <FabMenu
            t={t}
            items={menuItems}
            ariaLabel={isPrivate ? "Move value" : "Actions"}
            onPick={pick}
            leaving={menu.leaving}
          />
        </>
      )}
      {/* the bar rises above the menu's scrim so its own controls stay lit. */}
      <nav aria-label="Wallet" style={{ ...bar(t, compact), zIndex: showMenu ? 9 : 7 }}>
        <Tile
          t={t}
          width={tile}
          label="Home"
          active={onHome && w.sheets.length === 0}
          onClick={() => {
            setMenuOpen(false);
            w.closeAllSheets();
            w.setTab("home");
          }}
        >
          <HomeIcon size={glyph} />
        </Tile>
        <Tile
          t={t}
          width={tile}
          label="Receive"
          active={receiveOpen}
          onClick={() => w.openSheet("receive")}
        >
          <QrIcon size={glyph} />
        </Tile>
        <button
          type="button"
          aria-label={isPrivate ? "Move value" : "Actions"}
          aria-haspopup="menu"
          aria-expanded={showMenu}
          onClick={onFab}
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: "pointer",
            width: fab,
            height: fab,
            borderRadius: "50%",
            background: t.accent,
            color: t.onAccent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            flex: "0 0 auto",
            // a bright accent halo around the action button, the way Umbra lights
            // its own: a wide soft glow in the pocket's accent, not the thin line
            // it used to carry.
            boxShadow: `0 0 30px 1px ${hexAlpha(t.accent, 0.6)}, 0 6px 16px -4px ${hexAlpha(t.accent, 0.45)}`,
          }}
        >
          {/* the rotate lives on an inner span, not the button: the global press
              rule sets `transform: scale(.96)` on the button on :active, and a
              button cannot hold both a scale and a rotate on one property, so the X
              used to snap back to a plus mid-press. composed on two elements, the
              press scales the button while the glyph keeps its rotation. */}
          <span
            aria-hidden
            style={{
              display: "flex",
              // the plus turns into a close as the menu opens, in either pocket: the
              // FAB is now an actions menu everywhere, so it reads the same way.
              transform: showMenu ? "rotate(45deg)" : "none",
              transition: `transform var(--pocket-quick) var(--pocket-enter)`,
            }}
          >
            <Plus size={Math.round(glyph * 1.1)} />
          </span>
        </button>
        <Tile
          t={t}
          width={tile}
          label="History"
          active={onHistory && w.sheets.length === 0}
          onClick={() => {
            setMenuOpen(false);
            w.closeAllSheets();
            w.setTab("history");
          }}
        >
          <Clock size={glyph} />
        </Tile>
        <Tile
          t={t}
          width={tile}
          label="Settings"
          active={onSettings && w.sheets.length === 0}
          onClick={() => {
            setMenuOpen(false);
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

/**
 * the actions the FAB raises, as one icon row.
 *
 * ONE component renders both pockets' menus, so they are the same row and cannot
 * drift: the caller passes the items (the private pocket's three ways value moves,
 * or the public pocket's outward actions) and the menu's accessible name. each
 * item opens straight into its own form; a menu that then shows another menu is
 * two taps where one would do.
 */
function FabMenu({
  t,
  items,
  ariaLabel,
  onPick,
  leaving,
}: {
  t: Theme;
  items: { key: SheetId; label: string; icon: ReactNode }[];
  ariaLabel: string;
  onPick: (sheet: SheetId) => void;
  leaving: boolean;
}) {
  // the menu only mounts while open, so focusing the first item on mount is
  // focusing it on open: a keyboard user lands inside the menu rather than being
  // left on the FAB, and Left/Right (or Up/Down) walk the row. Escape is handled
  // by the parent, which closes the menu. this brings the FAB menu up to the
  // keyboard contract every Sheet already honours.
  const btns = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    btns.current[0]?.focus();
  }, []);
  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const i = btns.current.findIndex((b) => b === document.activeElement);
    if (i < 0) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      e.preventDefault();
      btns.current[(i + 1) % items.length]?.focus();
    } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      e.preventDefault();
      btns.current[(i - 1 + items.length) % items.length]?.focus();
    }
  };
  return (
    // a full-width centring track: the card is centred by flexbox, NOT by a
    // transform, because the `pocket-row-in` entrance animates `transform` and
    // would otherwise clobber a translateX and shove the card off to one side.
    <div
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        // clear of the bar (66 tall, sitting space.md off the bottom) with a gap.
        bottom: 66 + space.md + space.sm,
        zIndex: 10,
        display: "flex",
        justifyContent: "center",
        pointerEvents: "none",
      }}
    >
      <div
        role="menu"
        aria-label={ariaLabel}
        className={leaving ? "pocket-fade-out" : "pocket-row-in"}
        onKeyDown={onKey}
        style={{
          pointerEvents: "auto",
          // a compact horizontal row of icons, not a stacked list: the three ways
          // value moves, side by side above the action they came from.
          display: "flex",
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          padding: `${space.xs}px ${space.sm}px`,
          borderRadius: radius.lg,
          background: t.sheet,
          boxShadow: t.dark
            ? `0 18px 46px -12px rgba(0,0,0,0.75), 0 0 26px -6px ${t.accent}`
            : `0 18px 46px -14px rgba(20,21,26,0.32), 0 0 24px -6px ${t.accent}`,
        }}
      >
        {items.map((it, idx) => (
          <button
            key={it.key}
            ref={(el) => {
              btns.current[idx] = el;
            }}
            type="button"
            role="menuitem"
            aria-label={it.label}
            onClick={() => onPick(it.key)}
            className="pk-tap"
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              width: 52,
              height: 52,
              borderRadius: radius.md,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: t.text,
            }}
          >
            {it.icon}
          </button>
        ))}
      </div>
    </div>
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
        // the active tile must read against the bar it sits on: the accent tint
        // is too faint on the dark bar, so there it steps up to the raised fill.
        background: active ? (t.dark ? t.field : t.accentSoft) : "transparent",
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
    borderRadius: radius.lg,
    display: "flex",
    alignItems: "center",
    justifyContent: "space-around",
    padding: `0 ${compact ? 2 : space.sm}px`,
    zIndex: 7,
    background: t.bar,
    backdropFilter: "blur(24px) saturate(1.7)",
    WebkitBackdropFilter: "blur(24px) saturate(1.7)",
    // a UNIFORM accent halo (0/0 offset, so it is the same on every side) is the
    // bar's signature in both pockets. the light pocket ALSO carries a soft dark
    // ambient for lift; the dark pocket does NOT — a black drop shadow below the
    // bar is not just invisible on the dark page, it DARKENS the strip under the
    // bar and cancels the glow exactly where the user saw it missing. so on dark
    // the halo stands alone, wider and stronger, and reaches all the way round
    // including below.
    boxShadow: t.dark
      ? `0 0 40px 0px ${hexAlpha(t.accent, 0.7)}`
      : `0 10px 34px -12px rgba(20,21,26,0.28), 0 0 34px -3px ${hexAlpha(t.accent, 0.55)}`,
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
