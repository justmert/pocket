import { chunkAddress } from "../../../core/chain/address";
import { mono, type Theme } from "./theme";

/**
 * A full address, chunked in fours, monospace. Never truncated.
 *
 * Matching a Stellar address's first four and last four characters costs 2^32
 * attempts, which is about an hour on a laptop at a measured 1.16M
 * candidates/sec. So the familiar "GB43...Z3F7" is not a safe way to confirm a
 * recipient, and this component exists to make the safe form the easy one.
 */
export function AddressBlock({ address, t }: { address: string; t: Theme }) {
  return (
    <div
      style={{
        fontFamily: mono,
        fontSize: 13,
        lineHeight: 1.7,
        letterSpacing: "0.02em",
        color: t.text,
        background: t.field,
        border: `1px solid ${t.line}`,
        borderRadius: 10,
        padding: "10px 12px",
        wordBreak: "break-all",
        userSelect: "all",
      }}
    >
      {chunkAddress(address).map((group, i) => (
        <span key={i} style={{ marginRight: 6 }}>
          {group}
        </span>
      ))}
    </div>
  );
}
