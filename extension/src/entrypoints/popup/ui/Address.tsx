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

/**
 * a deterministic mark for an address.
 *
 * two accounts that differ anywhere get different marks, so the avatar is a
 * second signal that the wallet is on the account you think it is.
 */
export function Avatar({ address, size = 44 }: { address: string; size?: number }) {
  let h = 2166136261;
  for (let i = 0; i < address.length; i++) {
    h ^= address.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const a = Math.abs(h) % 360;
  const b = (a + 40 + (Math.abs(h >> 8) % 90)) % 360;
  const angle = Math.abs(h >> 16) % 360;
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flex: "0 0 auto",
        display: "block",
        background: `linear-gradient(${angle}deg, hsl(${a} 72% 62%), hsl(${b} 68% 48%))`,
        boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.16)",
      }}
    />
  );
}

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
