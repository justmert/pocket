// Crediting a confidential transfer you RECEIVED.
//
// Without this the private pocket is send-only: the sender's proof verifies,
// the transfer lands, the recipient's on-chain receiving commitment moves, and
// the recipient's wallet has no idea. Its stored opening stays zero,
// verifyAgainstChain reports a mismatch, and the pocket shows "diverged" with
// the money on chain and unreachable.
//
// The obstacle, and why the fix is not simply "call decryptIncomingTransfer":
// the transfer event publishes
//   {b_tilde, b_tilde_aud_s, r_e_point, r_tilde_aud_r, sigma, v_tilde,
//    v_tilde_aud_r, v_tilde_aud_s}
// and NOT c_transfer. So there is no published commitment to check a candidate
// opening against, which is exactly why sync.ts refuses these events rather
// than crediting an amount it cannot verify. That refusal is right.
//
// But the anchor exists somewhere better than the event: the CHAIN. A transfer
// moves the recipient's receiving accumulator by exactly the transferred
// commitment, so
//   C_receiving_after = C_receiving_before + C_transfer
// The recipient knows C_receiving_before (their stored opening), derives a
// candidate C_transfer from vk, R_e, v_tilde and sigma, and checks the sum
// against what the contract now holds. A wrong decryption, a transfer meant
// for somebody else, a replayed event, or a forged re-encoding all fail that
// check, because none of them reproduce the accumulator the chain agrees on.
//
// No archive is needed for recent history. Soroban RPC retains events for
// 120,960 ledgers, about seven days, which is what makes this reachable today.
// Older than that still needs the durable archive, and that is unchanged.
import type { rpc } from "@stellar/stellar-sdk";
import { Address, xdr, scValToNative } from "@stellar/stellar-sdk/base";
import { commit, add, decodePoint, equals, type Point } from "./crypto/grumpkin";
import { sharedScalar, transferBlinding, encryptAmount } from "./crypto/derive";
import { isCanonicalFr, fromBytesBE } from "./crypto/field";
import { MAX_AMOUNT } from "./witness/guards";
import { R } from "./crypto/field";
import type { Opening } from "./witness/types";

/** A transfer addressed to us, still to be applied. */
export interface InboundTransfer {
  /** `(ledger, tx hash, index)`, the only identity an event has. */
  id: string;
  ledger: number;
  opening: Opening;
}

export class InboundCreditError extends Error {
  override readonly name = "InboundCreditError";
}

/**
 * Derive the opening of a transfer addressed to this viewing key.
 *
 * Returns null when the event was not ours, which is the common case: every
 * transfer on the deployment reaches us and only some are addressed here.
 * Null is not an error and must not be reported as one.
 */
export function openInbound(vk: bigint, RE: Point, vTilde: bigint, sigma: bigint): Opening | null {
  // Same canonicality discipline as the published-commitment path. The sponge
  // reduces every absorbed input mod r, so sigma and sigma + r derive the
  // identical mask: one on-chain transfer would otherwise have unboundedly
  // many re-encodings that all decrypt to the same credit.
  if (!isCanonicalFr(vTilde) || !isCanonicalFr(sigma)) return null;
  if (RE.x === 0n && RE.y === 0n) return null;

  let s: bigint;
  try {
    s = sharedScalar(vk, RE);
  } catch {
    return null;
  }

  const value = (vTilde - encryptAmount(0n, s, sigma) + R) % R;
  // Every legitimate amount is under the circuit's range bound. A near-uniform
  // field element means this was somebody else's transfer.
  if (value >= MAX_AMOUNT) return null;
  return { value, randomness: transferBlinding(s, sigma) };
}

/**
 * Apply a batch of candidate inbound transfers, and REFUSE unless the result
 * reproduces the receiving commitment the contract now holds.
 *
 * All or nothing on purpose. Crediting a subset would leave a balance that
 * looks right and cannot be spent, which is worse than crediting none: the
 * proof would fail at submit time with the funds apparently present.
 */
export function creditInbound(
  before: Opening,
  candidates: InboundTransfer[],
  onChainReceiving: Point,
): Opening {
  let credited = before;
  for (const c of candidates) {
    credited = {
      value: credited.value + c.opening.value,
      // Blindings accumulate mod q, NEVER mod r. commit() does that reduction,
      // so the sum is left exact here and reduced there.
      randomness: credited.randomness + c.opening.randomness,
    };
  }

  if (!equals(commit(credited.value, credited.randomness), onChainReceiving)) {
    throw new InboundCreditError(
      "The transfers this device found do not add up to the balance the contract holds, so " +
        "Pocket will not credit them. Your funds are safe on chain. This usually means an " +
        "event is missing from the window that was searched.",
    );
  }
  return credited;
}

/** One event as the RAW endpoint returns it, before the SDK's parse. */
interface RawEvent {
  ledger: number;
  id: string;
  value: xdr.ScVal | string;
}

/** The eight-field transfer body, decoded. */
interface TransferBody {
  r_e_point: Uint8Array;
  v_tilde: bigint;
  sigma: bigint;
}

function decodeTransferBody(data: xdr.ScVal): TransferBody | null {
  const native = scValToNative(data) as Record<string, unknown>;
  const point = native.r_e_point;
  const v = native.v_tilde;
  const s = native.sigma;
  // EVERY field arrives as raw bytes, not as a bigint. The contract publishes
  // BytesN<32> for the scalars and BytesN<64> for the point, so scValToNative
  // hands back Uint8Arrays and a `typeof x === "bigint"` check silently
  // rejects every real event. That is exactly how this path came to find
  // nothing at all while looking like it worked.
  if (!(point instanceof Uint8Array) || point.length !== 64) return null;
  if (!(v instanceof Uint8Array) || v.length !== 32) return null;
  if (!(s instanceof Uint8Array) || s.length !== 32) return null;
  return { r_e_point: point, v_tilde: fromBytesBE(v), sigma: fromBytesBE(s) };
}

/**
 * Find transfers addressed to `account` in the RPC's retained window.
 *
 * Reads ONLY what RPC still holds. It does not claim completeness and must not
 * be treated as recovery: a wallet that has been offline longer than the
 * retention floor needs the durable archive, and `creditInbound`'s check is
 * what makes that failure loud rather than silent.
 */
export async function findInbound(
  server: rpc.Server,
  tokenId: string,
  account: string,
  vk: bigint,
  fromLedger: number,
): Promise<InboundTransfer[]> {
  const me = Address.fromString(account).toScVal();
  // The floor belongs HERE, not in the caller. A `startLedger` even one ledger
  // outside retention returns ZERO EVENTS WITH NO ERROR, so getting it wrong
  // produces silence rather than a complaint, and the widest possible request
  // is the one that silently finds nothing. Asking the RPC where its window
  // actually starts is the only reliable answer: computing it as
  // `latestLedger - 120_960` assumes a constant the node is free to change.
  //
  // A caller cannot get this wrong now, because the function that talks to the
  // RPC is the one that knows the RPC's constraint.
  const health = (await server.getHealth()) as { oldestLedger?: number };
  const floor = typeof health.oldestLedger === "number" ? health.oldestLedger : fromLedger;
  const from = Math.max(fromLedger, floor);

  const found: InboundTransfer[] = [];
  let cursor: string | undefined;
  // A page budget. The loop's only other exit is the RPC's cursor, and a
  // server handing out a fresh one forever would spin here indefinitely. 41
  // pages covered the entire retained window against the live deployment, so
  // this is far above any honest history and terminates promptly against a
  // dishonest one.
  let pages = 0;
  const MAX_PAGES = 200;

  // topics: [event name, from, to]. Matching the RECIPIENT slot makes the RPC
  // do the filtering. It MUST be on the cursor branch too: without it every
  // paginated call pulls every event the contract ever emitted, and the
  // all-or-nothing check downstream ends up reasoning about a different event
  // set than the first page did.
  const filters = [
    {
      type: "contract" as const,
      contractIds: [tokenId],
      topics: [[xdr.ScVal.scvSymbol("transfer").toXDR("base64"), "*", me.toXDR("base64")]],
    },
  ];

  for (;;) {
    // The RAW accessor, for the same reason balances.ts and ttl.ts use theirs.
    // `getEvents` parses with `(raw.events ?? []).map(...)`, so a reply with no
    // events field at all, or events: null, has already become an empty array
    // by the time we see it and is byte-identical to "the window held nothing
    // for you". Only the raw response can tell those apart.
    const page = (await (cursor
      ? server._getEvents({ cursor, filters })
      : server._getEvents({ startLedger: from, filters }))) as {
      latestLedger?: unknown;
      events?: unknown;
      cursor?: string;
    };

    // An empty page is NOT the end. Scanning a wide range, the RPC returns
    // empty pages carrying a cursor and expects you to keep asking; stopping
    // here gave up before reaching any event and made a working search look
    // like "you have received nothing". Only the absence of a cursor ends it.
    // The parsed accessor does `(raw.events ?? []).map(...)`, so a reply with
    // no events field, or events: null, has already become an empty array by
    // the time the SDK hands it over and is byte-identical to "the window held
    // nothing for you". Reading the RAW response is what makes them
    // distinguishable, and this is the check that uses it. Without it the
    // iteration below throws a TypeError, which reaches the user as the
    // generic message and tells them nothing.
    if (typeof page.latestLedger !== "number" || !Array.isArray(page.events)) {
      throw new InboundCreditError(
        "The ledger did not answer which transfers this account received, so Pocket will not " +
          "conclude that it received none.",
      );
    }

    for (const e of page.events as RawEvent[]) {
      // The raw endpoint hands back base64 XDR where the parsed one hands
      // back an ScVal.
      const val = typeof e.value === "string" ? xdr.ScVal.fromXDR(e.value, "base64") : e.value;
      const body = decodeTransferBody(val);
      if (!body) continue;
      let RE: Point;
      try {
        RE = decodePoint(body.r_e_point);
      } catch {
        continue;
      }
      const opening = openInbound(vk, RE, body.v_tilde, body.sigma);
      if (!opening) continue;
      found.push({ id: `${e.ledger}:${e.id}`, ledger: e.ledger, opening });
    }
    if (!page.cursor || page.cursor === cursor) break;
    if (++pages >= MAX_PAGES) {
      throw new InboundCreditError(
        "Pocket stopped searching the ledger rather than paging through it indefinitely. " +
          "Your funds are safe on chain.",
      );
    }
    cursor = page.cursor;
  }
  return found;
}

export { add };
