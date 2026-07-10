// addresses.
//
// an address is either shown in full or shown as a recognisable shortening next
// to the thing that copies it. a confirm step always gets the full string:
// matching the first and last few characters of a stellar address is cheap to
// forge, so a shortened address is never what someone approves.
import { fontSizes, fonts, radius, space, text, type Theme } from "./theme";
import { Check, Copy } from "./icons";

/** first and last six, which is enough to recognise and not enough to approve. */
export function shortAddress(address: string): string {
  if (address.length <= 16) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

// the account mark lives in ./Avatar. it is seeded on an address but it is not
// an address concern, and its palette is a product decision this file has no
// business holding.

/** the full address, wrapped rather than clipped, with one press to copy it. */
export function AddressBlock({
  t,
  address,
  onCopy,
  copied,
}: {
  t: Theme;
  address: string;
  onCopy?: (value: string) => void;
  copied?: boolean;
}) {
  return (
    <div
      style={{
        background: t.field,
        borderRadius: radius.md,
        padding: space.md,
        display: "flex",
        alignItems: "flex-start",
        gap: space.sm,
      }}
    >
      <span
        style={{
          fontFamily: fonts.mono,
          // the scale, not a hand-picked 13. this is the string someone checks
          // character by character before an irreversible act, and it was set
          // smaller than the transaction hash on the receipt that follows.
          fontSize: fontSizes.body,
          fontWeight: 600,
          lineHeight: 1.55,
          color: t.text,
          wordBreak: "break-all",
          flex: 1,
          minWidth: 0,
        }}
      >
        {address}
      </span>
      {onCopy && (
        <button
          type="button"
          aria-label="Copy address"
          onClick={() => onCopy(address)}
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: "pointer",
            color: copied ? t.positive : t.sub,
            flex: "0 0 auto",
            // a target a finger can actually land on, not just the glyph.
            minWidth: 28,
            minHeight: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: radius.sm,
          }}
        >
          {copied ? <Check size={17} sw={2.4} /> : <Copy size={17} />}
        </button>
      )}
    </div>
  );
}

/** any other value that must be readable character by character. */
export function MonoBlock({ t, children }: { t: Theme; children: React.ReactNode }) {
  return (
    <div
      style={{
        ...text.body,
        fontFamily: fonts.mono,
        background: t.field,
        borderRadius: radius.md,
        padding: space.md,
        color: t.text,
        wordBreak: "break-all",
        lineHeight: 1.55,
      }}
    >
      {children}
    </div>
  );
}

/**
 * the origin asking for a signature.
 *
 * not a `MonoBlock`. a memo and a transaction hash can wrap wherever they like,
 * because nobody is deceived by where a hash breaks. a hostname is different:
 * the break point is a function of length, so an attacker who chooses the
 * hostname also chooses where it wraps, and can build one whose first line ends
 * in something that reads as the real domain. `wordBreak: break-all` handed that
 * choice over.
 *
 * so it does not wrap. one line, scrolled rather than broken, with the scheme
 * dimmed because it is never the part under attack and it is the part that eats
 * the width. nothing is truncated: the whole string is reachable.
 */
export function OriginBlock({ t, origin }: { t: Theme; origin: string }) {
  const split = origin.match(/^([a-z][a-z0-9+.-]*:\/\/)(.*)$/i);
  const scheme = split?.[1] ?? "";
  const rest = split?.[2] ?? origin;
  return (
    <div
      style={{
        background: t.field,
        borderRadius: radius.md,
        padding: space.md,
        // a deliberate scroller, which is also what keeps the layout audit
        // honest about it: content that scrolls is not content that is lost.
        overflowX: "auto",
        whiteSpace: "nowrap",
        lineHeight: 1.55,
      }}
    >
      <span style={{ ...text.body, fontFamily: fonts.mono, color: t.sub }}>{scheme}</span>
      <span
        style={{
          ...text.rowTitle,
          fontFamily: fonts.mono,
          fontSize: fontSizes.heading,
          color: t.text,
        }}
      >
        {rest}
      </span>
    </div>
  );
}
