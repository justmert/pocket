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

// The scan cursor, as two named functions rather than two pieces of arithmetic
// inlined at the call site.
//
// It is worth the names because the two halves have to agree and they were
// written twenty lines apart, where nothing made the disagreement visible. A
// cursor is a claim about what is ALREADY CREDITED, and `creditInbound` below
// is all-or-nothing, so an optimistic claim does not produce a stale balance,
// it produces a permanent one: the next scan re-reads an event the opening
// already contains, the sum overshoots the accumulator the contract holds, and
// the refusal repeats identically forever.

/**
 * The ledger a scan resumes at, given what is already accounted for.
 *
 * PLUS ONE because `startLedger` is inclusive. Measured against the live RPC,
 * not read off the docs: asking from ledger N returns N's own events.
 */
export function resumeFrom(syncedThrough: number): number {
  // Zero means nothing has ever been accounted for. `findInbound` clamps up to
  // the RPC's retention floor, so 1 asks for "as far back as you keep".
  return syncedThrough > 0 ? syncedThrough + 1 : 1;
}

/**
 * The cursor to store after a batch is credited: the newest ledger actually
 * credited from, floored at whatever the cursor already claimed.
 *
 * Deliberately NOT the chain tip. The tip is read before a scan that pages the
 * whole retained window with no upper bound, so a transfer landing mid-scan
 * gets credited by that scan and left behind by that cursor. Anchoring on the
 * events themselves closes the race by construction: this is only ever reached
 * once the credited sum reproduces the on-chain accumulator, which is proof
 * that every event at or below this ledger is in the opening. The cost is
 * re-scanning the empty ledgers up to the tip, which finds nothing.
 */
export function cursorAfter(previous: number, credited: InboundTransfer[]): number {
  let cursor = previous;
  for (const t of credited) if (t.ledger > cursor) cursor = t.ledger;
  return cursor;
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
  /** Base64 ScVals: `[event name, from, to]`. */
  topic?: string[];
}

/** The eight-field transfer body, decoded. */
interface TransferBody {
  r_e_point: Uint8Array;
  v_tilde: bigint;
  sigma: bigint;
}

/**
 * Decode a transfer-shaped body, from either event that carries one.
 *
 * `transfer` names its salt `sigma`; `spender_transfer` names it `sigma_a`,
 * because there the salt is the delegation's allowance salt rather than a
 * per-transfer one. The RECIPIENT does not care which: the two circuits derive
 * the recipient's opening identically, with sigma_a standing exactly where
 * sigma stands.
 *
 *   transfer         T7 r_transfer = Poseidon2(delta_transfer_blind, s, sigma)
 *   spender_transfer O7 r_transfer = Poseidon2(delta_transfer_blind, s, sigma_a)
 *   transfer         T9 v_tilde = v_transfer + Poseidon2(delta_transfer_amount, s, sigma)
 *   spender_transfer O9 v_tilde = v_transfer + Poseidon2(delta_transfer_amount, s, sigma_a)
 *
 * (circuits/transfer/src/main.nr:42,48 and circuits/spender_transfer/src/main.nr:38,44)
 *
 * So `openInbound` needs no new crypto for the second one, only the right field.
 */
function decodeTransferBody(data: xdr.ScVal): TransferBody | null {
  const native = scValToNative(data) as Record<string, unknown>;
  const point = native.r_e_point;
  const v = native.v_tilde;
  const s = native.sigma ?? native.sigma_a;
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

/** An ScVal that arrived as base64 from the raw endpoint, decoded to a string. */
function topicString(topic: string[] | undefined, index: number): string | null {
  const raw = topic?.[index];
  if (typeof raw !== "string") return null;
  try {
    const v = scValToNative(xdr.ScVal.fromXDR(raw, "base64")) as unknown;
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * The opening a DEPOSIT addressed to us produces.
 *
 * A deposit is the one credit to a confidential account that is not
 * confidential: `storage::deposit` commits `amount * G` with blinding ZERO
 * (`storage.rs:512`) and the amount rides in the event body in the clear. So
 * there is nothing to decrypt and nothing to derive, and the check that the
 * candidate is real is the same accumulator check every other candidate faces.
 *
 * This exists because `deposit(from, to, amount)` calls `from.require_auth()`
 * and nothing else (`mod.rs:291-296`), so ANYONE can deposit into your
 * receiving commitment and none of it needs your key or your consent. The scan
 * looked for `transfer` only, so those credits were invisible to the wallet: it
 * reported the pocket diverged and blamed history older than the RPC's window,
 * which was not the cause and pointed the user at a rebuild they could not run.
 */
function openDeposit(data: xdr.ScVal): Opening | null {
  const native = scValToNative(data) as Record<string, unknown>;
  const amount = native.amount;
  if (typeof amount !== "bigint" || amount < 0n || amount >= MAX_AMOUNT) return null;
  return { value: amount, randomness: 0n };
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
  //
  // THREE event names, because three things credit a receiving commitment, and
  // none of them needs the recipient's permission.
  //
  // A `deposit` needs no proof at all: it is how every shield works and the
  // contract lets anyone aim one at anyone.
  //
  // A `spender_transfer` is the one that hurts. `confidential_transfer_from`
  // calls `add_to_receiving(e, to, &payload.c_transfer)` (storage.rs:828) with
  // every `require_auth` in the file on the ACTING principal, never on `to`. So
  // a stranger holding a delegation from any third party moves the accumulator
  // of any registered account they choose. Missing from this filter, the scan
  // could never reproduce that accumulator, `creditInbound`'s all-or-nothing
  // check refused, and the pocket read `diverged` forever, refusing every
  // spend. The circuit puts no lower bound on the transferred amount either
  // (`v_transfer.assert_max_bit_size::<127>()` and no `assert(v_transfer != 0)`,
  // spender_transfer/src/main.nr:248), so the whole attack costs one fee.
  //
  // Its `to` sits at topic index THREE, not two: the topics are
  // ["spender_transfer", spender, from, to] against ["transfer", from, to].
  // Filtering it at index 2 would match on `from` and silently find nothing,
  // which is the same failure with an extra step.
  //
  // One filter object with all three names, so the RPC still does the recipient
  // filtering and the pagination stays a single cursor.
  const filters = [
    {
      type: "contract" as const,
      contractIds: [tokenId],
      topics: [
        [xdr.ScVal.scvSymbol("transfer").toXDR("base64"), "*", me.toXDR("base64")],
        [xdr.ScVal.scvSymbol("deposit").toXDR("base64"), "*", me.toXDR("base64")],
        [
          xdr.ScVal.scvSymbol("spender_transfer").toXDR("base64"),
          "*",
          "*",
          me.toXDR("base64"),
        ],
      ],
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

      if (topicString(e.topic, 0) === "deposit") {
        // OUR OWN shield, skipped. The staged "credit" resolution already
        // applied it the moment the deposit landed, so counting it again
        // overshoots the accumulator and the all-or-nothing check refuses,
        // which would wedge the pocket rather than merely miscount it. `from`
        // is exact for this: a deposit we authorised is one we sent.
        //
        // If that staged credit was itself lost, the recovery is the in-flight
        // record, which now survives a failed write and leads `reconcileInFlight`
        // back to the same consequence. It is not this scan's job.
        if (topicString(e.topic, 1) === account) continue;
        const opening = openDeposit(val);
        if (!opening) continue;
        found.push({ id: `${e.ledger}:${e.id}`, ledger: e.ledger, opening });
        continue;
      }

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
