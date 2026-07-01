import type { ReactNode } from "react";
import { chunkAddress } from "../../../core/chain/address";
import { leading, mono, radius, type Theme } from "./theme";

/**
 * The one container for a value that is long, exact, and worth reading
 * character by character: an address, a transaction hash, a memo. Screens had
 * grown three different treatments for these, two of them bare text with no
 * container at all, which made a hash look like debug output next to an
 * address that looked like a field.
 */
export function MonoBlock({ children, t }: { children: ReactNode; t: Theme }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 13,
        lineHeight: leading.relaxed,
        letterSpacing: "0.02em",
        color: t.text,
        background: t.field,
        border: `1px solid ${t.line}`,
        borderRadius: radius.md,
        padding: "10px 12px",
        wordBreak: "break-all",
        userSelect: "all",
      }}
    >
      {children}
    </div>
  );
}

/**
 * A full address, chunked in fours, monospace. Never truncated.
 *
 * Matching a Stellar address's first four and last four characters costs 2^32
 * attempts, which is about an hour on a laptop at a measured 1.16M
 * candidates/sec. So the familiar "GB43...Z3F7" is not a safe way to confirm a
 * recipient, and this component exists to make the safe form the easy one.
 *
 * The chunks carry no whitespace between them: the gap is a margin, so
 * selecting or copying the block yields the address itself.
 */
export function AddressBlock({ address, t }: { address: string; t: Theme }) {
  return (
    <MonoBlock t={t}>
      {chunkAddress(address).map((group, i) => (
        <span key={i} style={{ marginRight: 6 }}>
          {group}
        </span>
      ))}
    </MonoBlock>
  );
}
