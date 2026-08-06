// Private-pocket transaction history, derived from the confidential event archive.
//
// The chain hides confidential AMOUNTS: an event publishes its parties as public
// topics but commits the amount. This device is the only one that can open its
// own commitments, and it already does so in the sync engine (core/sync.ts) to
// rebuild balances. This module reuses that exact, verified replay to surface a
// per-transaction list instead of a running total.
//
// The amount of any money movement is the CHANGE it makes to the relevant
// opening's plaintext value, and `applyEvent` computes that change for us:
//
//   shield (deposit)     receiving += public amount        -> Delta receiving
//   private receive      receiving += decrypted amount      -> Delta receiving
//   make spendable (merge)  receiving folded into spendable -> Delta spendable
//   unshield (withdraw)  spendable checkpoint               -> -Delta spendable
//   private send         spendable checkpoint               -> -Delta spendable
//
// So no amount is re-derived here; it is read off the state transition the
// replay already performs, which keeps this in lockstep with what makes a
// balance spendable.
//
// Honesty over completeness. When an event cannot be replayed (an inbound
// transfer whose commitment the archive did not keep, or a malformed event), the
// entry is still shown with a NULL amount, and any later amount that depends on
// the running total is nulled too rather than shown wrong. Per-event amounts
// that do not depend on the running total (a deposit's public amount, an inbound
// transfer's own decrypted amount) stay exact regardless. The chain, not this
// list, is the authority on what is spendable.
import {
  applyEvent,
  orderAndDedupe,
  INITIAL_STATE,
  UnreplayableEventError,
  MalformedEventError,
  type ConfidentialEvent,
  type ReplayState,
} from "./sync";
import { decodeStored } from "./recover-openings";
import { partitionForDisplay } from "./spam";
import { formatAmount } from "./chain/balances";
import type { StoredEvent } from "./chain/archive-types";
import type { HistoryEntry } from "./messages";

interface Classified {
  kind: HistoryEntry["kind"];
  direction: HistoryEntry["direction"];
  counterparty?: string;
  /** Plaintext stroops, or null when this device cannot determine it. */
  amount: bigint | null;
}

/** The other party, unless it is us (a self-operation has no counterparty). */
function other(address: string | undefined, me: string): string | undefined {
  return address && address !== me ? address : undefined;
}

/**
 * One replayed event into a history classification, or null when the event is
 * not this account's money or not a movement we render (a stranger's event,
 * a spender/delegation config change).
 *
 * `degraded` marks that an earlier event could not be replayed, so the running
 * total is no longer trustworthy: amounts derived from it are nulled, while
 * amounts intrinsic to a single event stay exact. `threw` marks that THIS event
 * could not be replayed at all.
 */
function classify(
  e: ConfidentialEvent,
  before: ReplayState,
  after: ReplayState,
  me: string,
  degraded: boolean,
  threw: boolean,
): Classified | null {
  const t = e.topics;
  const dReceiving = after.receiving.value - before.receiving.value;
  const dSpendable = after.spendable.value - before.spendable.value;

  switch (e.type) {
    case "register":
      return t[0] === me ? { kind: "setup", direction: "self", amount: null } : null;

    case "deposit": {
      // topics: [from, to]. Public amount, so exact unless the event itself was malformed.
      if (t[1] !== me) return null;
      return {
        kind: "shield",
        direction: "in",
        counterparty: other(t[0], me),
        amount: threw ? null : dReceiving,
      };
    }

    case "merge":
      // topics: [account]. Amount = the receiving total that was folded in, which
      // depends on the running total.
      if (t[0] !== me) return null;
      return { kind: "makeSpendable", direction: "self", amount: degraded ? null : dSpendable };

    case "withdraw":
      // topics: [from, to]. Amount = the drop in spendable, which depends on the running total.
      if (t[0] !== me) return null;
      return {
        kind: "unshield",
        direction: "out",
        counterparty: other(t[1], me),
        amount: degraded ? null : -dSpendable,
      };

    case "transfer": {
      // topics: [from, to].
      const toMe = t[1] === me;
      const fromMe = t[0] === me;
      if (toMe && fromMe) {
        // A transfer to oneself: the received amount is intrinsic to this event.
        return { kind: "privateSend", direction: "self", amount: threw ? null : dReceiving };
      }
      if (toMe) {
        // Received. The decrypted amount is this event's own, exact unless unreadable.
        return {
          kind: "privateReceive",
          direction: "in",
          counterparty: other(t[0], me),
          amount: threw ? null : dReceiving,
        };
      }
      if (fromMe) {
        // Sent. The amount is the drop in spendable, which depends on the running total.
        return {
          kind: "privateSend",
          direction: "out",
          counterparty: other(t[1], me),
          amount: degraded ? null : -dSpendable,
        };
      }
      return null;
    }

    case "spender_transfer": {
      // topics: [spender, from, to]. A credit to us that the event stream cannot
      // open, so the amount is unknowable on this device.
      if (t[2] !== me) return null;
      return {
        kind: "privateReceive",
        direction: "in",
        counterparty: other(t[1], me),
        amount: null,
      };
    }

    // Delegation config. It moves the spendable/allowance split but is not a
    // payment, so it is not shown in a transaction history.
    case "set_spender":
    case "revoke_spender":
      return null;
  }

  return null;
}

/** A decoded confidential event with the timestamp and hash the replay discards. */
export interface DecodedEvent {
  event: ConfidentialEvent;
  /** Epoch milliseconds. */
  at: number;
  hash: string;
  ledger: number;
}

/**
 * The history-building walk, over already-decoded events.
 *
 * Separated from the XDR decode below so it can be tested directly against the
 * same plain event objects the sync engine's own tests use.
 */
export function deriveHistory(
  decoded: DecodedEvent[],
  keys: { vk: bigint; address: string },
  code: string,
): HistoryEntry[] {
  const meta = new Map(decoded.map((d) => [d.event.id, d]));
  const ordered = orderAndDedupe(decoded.map((d) => d.event));
  const me = keys.address;
  const out: HistoryEntry[] = [];
  let state = INITIAL_STATE;
  let degraded = false;

  for (const e of ordered) {
    const before = state;
    let after = before;
    let threw = false;
    try {
      after = applyEvent(before, e, keys);
    } catch (err) {
      // Informational, not spendable state: a single unreadable or malformed
      // event degrades the amounts rather than failing the whole list. Anything
      // that is not one of these is a real programming error and must surface.
      if (err instanceof UnreplayableEventError || err instanceof MalformedEventError) {
        // The state does not advance across an event we could not apply: `after`
        // is still `before`, because the throw preceded its reassignment.
        threw = true;
        degraded = true;
      } else {
        throw err;
      }
    }

    const item = classify(e, before, after, me, degraded, threw);
    state = after;
    if (!item) continue;

    const m = meta.get(e.id);
    if (!m) continue;
    out.push({
      id: e.id,
      pocket: "private",
      kind: item.kind,
      direction: item.direction,
      code,
      amount: item.amount === null ? null : formatAmount(item.amount),
      counterparty: item.counterparty,
      at: m.at,
      hash: m.hash,
      ledger: m.ledger,
    });
  }

  // Newest first, ties broken by id, matching the public source's order.
  out.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  return markSpam(out);
}

/**
 * Mark the inbound transfers a default view hides. Spec 18.7.
 *
 * Anyone can send a zero-value confidential transfer to any registered account,
 * and every one of them arrives here as an ordinary "Received privately from
 * G... 0 XLM" row. `core/spam.ts` was written for exactly this and had no
 * caller outside its own test, so an account being flooded got one row per spam
 * event with nothing to collapse or hide them.
 *
 * MARKED, never dropped. The event still participates in the replay arithmetic
 * above (the module's own rule: ingest everything, filter at display only), the
 * entry is still in this list, and the screen offers to show it. Nothing
 * filtered may be unreachable.
 *
 * "Known" is derived from this same stream rather than from an address book the
 * wallet does not have: an address this account has itself sent to privately,
 * or shielded from, is one the user chose to transact with, and a zero-value
 * transfer back from it is not unsolicited.
 */
export function markSpam(entries: HistoryEntry[]): HistoryEntry[] {
  const known = new Set<string>();
  for (const e of entries) {
    if (e.direction === "out" && e.counterparty) known.add(e.counterparty);
  }
  const inbound = entries.filter((e) => e.kind === "privateReceive" && e.counterparty);
  if (inbound.length === 0) return entries;

  const { hidden } = partitionForDisplay(
    inbound.map((e) => ({
      eventId: e.id,
      from: e.counterparty!,
      ledger: e.ledger ?? 0,
      // A null amount is one this device could not read, which is NOT a zero.
      // `parseAmount` is the wrong tool here: these are already this module's
      // own `formatAmount` output, so a plain "is it all zeros" test is exact
      // and cannot introduce a second decimal grammar.
      value: e.amount === null ? null : /^0(\.0*)?$/.test(e.amount) ? 0n : 1n,
    })),
    known,
  );
  if (hidden.length === 0) return entries;
  const ids = new Set(hidden.map((h) => h.eventId));
  return entries.map((e) => (ids.has(e.id) ? { ...e, spam: true as const } : e));
}

/**
 * Every confidential transaction for this account, newest first.
 *
 * `stored` is the account's full archived event history (the same pages
 * `recoverOpenings` reads). `code` is the display symbol of the wrapped asset.
 */
export function privateHistory(
  stored: StoredEvent[],
  keys: { vk: bigint; address: string },
  code: string,
): HistoryEntry[] {
  const decoded: DecodedEvent[] = [];
  for (const s of stored) {
    const event = decodeStored(s);
    if (!event) continue; // not a replay event.
    // close_time is UNIX seconds (indexer/src/ingest.ts); history speaks ms.
    decoded.push({ event, at: s.close_time * 1000, hash: s.tx_hash, ledger: s.ledger_seq });
  }
  return deriveHistory(decoded, keys, code);
}
