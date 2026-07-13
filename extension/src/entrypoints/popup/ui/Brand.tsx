// the mark.
//
// a rounded tile with a pocket cut into it, drawn rather than shipped as art so
// it takes the accent of whichever pocket is open.
import { type Theme } from "./theme";

export function Brand({ t, size = 56 }: { t: Theme; size?: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        background: t.accentFill,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        boxShadow: t.dark
          ? `0 12px 30px -14px ${t.accent}`
          : "0 12px 28px -16px rgba(20,21,26,0.55)",
      }}
    >
      <svg
        width={Math.round(size * 0.56)}
        height={Math.round(size * 0.56)}
        viewBox="0 0 24 24"
        fill="none"
        stroke={t.onAccent}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 7.5C4 6.11929 5.11929 5 6.5 5H17.5C18.8807 5 20 6.11929 20 7.5V16.5C20 17.8807 18.8807 19 17.5 19H6.5C5.11929 19 4 17.8807 4 16.5V7.5Z" />
        <path d="M4 10.5H8.5C8.5 12.4330 10.067 14 12 14C13.933 14 15.5 12.4330 15.5 10.5H20" />
      </svg>
    </span>
  );
}

/** the wordmark and the mark together, for a screen that has no other header. */
export function BrandRow({ t, size = 40 }: { t: Theme; size?: number }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 10,
        // at 500% zoom the popup is 160px wide, and a mark plus a wordmark on
        // one line is wider than that.
        flexWrap: "wrap",
        maxWidth: "100%",
      }}
    >
      <Brand t={t} size={size} />
      <span
        style={{
          fontSize: Math.round(size * 0.5),
          fontWeight: 700,
          letterSpacing: "-0.03em",
          color: t.text,
          overflowWrap: "anywhere",
          minWidth: 0,
        }}
      >
        Pocket
      </span>
    </span>
  );
}

/**
 * the real packaged wordmark (logo.png), the same asset the Home and Unlock
 * screens use. shown wherever a screen wants the brand rather than the small drawn
 * tile. logo.png is dark artwork, so on a dark pocket it inverts to white.
 */
export function Logo({ t, width }: { t: Theme; width: number | string }) {
  return (
    <img
      src="/logo.png"
      alt="Pocket"
      style={{
        width,
        maxWidth: "82%",
        height: "auto",
        display: "block",
        margin: "0 auto",
        filter: t.dark ? "invert(1)" : "none",
      }}
    />
  );
}
