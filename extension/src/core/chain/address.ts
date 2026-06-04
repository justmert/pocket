// Address handling and the address-substitution defence.
//
// The governing measurement (research/phase2/05-threat-model.md B.3): matching
// a Stellar address's first 4 and last 4 characters costs 2^32 attempts, which
// at a measured 1.16M candidates/sec on a 12-core laptop is about ONE HOUR.
// Not a datacentre. A laptop, in an hour.
//
// Note the naive estimate (32^8) overstates this by 256x, because character 0
// is fixed by the version byte and character 1 carries only 2 free bits. The
// real number is much worse than the obvious one.
//
// 6+6 is ~123 years on the same machine and 8+8 is astronomical, so the cliff
// sits between 4 and 6. Since "GB43...Z3F7" is exactly the 4+4 shape every
// wallet shows, truncated display is not a safe way to confirm a recipient.
// Hence: full address, chunked, monospace, at every confirm step.
import { StrKey } from "@stellar/stellar-sdk/base";

export type AddressKind = "account" | "contract" | "muxed";

export interface ParsedAddress {
  kind: AddressKind;
  value: string;
}

export class InvalidAddressError extends Error {
  constructor(
    public readonly input: string,
    public readonly reason: "malformed" | "checksum" | "unsupported",
  ) {
    super(`invalid address (${reason})`);
    this.name = "InvalidAddressError";
  }
}

/**
 * Parse and validate a strkey. Distinguishes malformed from checksum failure:
 * a checksum failure is more likely a typo or a corrupted paste, a malformed
 * value is more likely the wrong kind of string entirely.
 */
export function parseAddress(input: string): ParsedAddress {
  const value = input.trim();
  if (StrKey.isValidEd25519PublicKey(value)) return { kind: "account", value };
  if (StrKey.isValidContract(value)) return { kind: "contract", value };
  if (StrKey.isValidMed25519PublicKey(value)) return { kind: "muxed", value };

  // Right shape, wrong checksum: worth telling the user apart from junk.
  if (/^[GCM][A-Z2-7]{55,68}$/.test(value)) {
    throw new InvalidAddressError(input, "checksum");
  }
  throw new InvalidAddressError(input, "malformed");
}

export function isValidAddress(input: string): boolean {
  try {
    parseAddress(input);
    return true;
  } catch {
    return false;
  }
}

/**
 * Chunk an address for confirm-step display: the FULL value, in groups of 4,
 * intended for a monospace face. Never truncates. The 4-character grouping
 * makes a transposition visible without inviting the user to compare only the
 * ends, which is the failure the measurement above describes.
 */
export function chunkAddress(address: string, groupSize = 4): string[] {
  const out: string[] = [];
  for (let i = 0; i < address.length; i += groupSize) {
    out.push(address.slice(i, i + groupSize));
  }
  return out;
}

/**
 * Shortened form for LISTS ONLY, where the address is a label rather than
 * something being confirmed. Must never appear on a confirm screen.
 */
export function shortenForList(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-6)}`;
}

/**
 * True when two addresses look alike under 4+4 truncation but are different.
 * Used to warn when a pasted address collides with a known contact, which is
 * the poisoning pattern: the attacker's address is generated to match.
 */
export function isLookalike(a: string, b: string): boolean {
  if (a === b) return false;
  return a.slice(0, 4) === b.slice(0, 4) && a.slice(-4) === b.slice(-4);
}
