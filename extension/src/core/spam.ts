// Inbound spam presentation. Spec 18.7.
//
// Anyone can send a zero-value confidential transfer to any registered account.
// It cannot break correctness or invalidate a proof, but it costs the recipient
// replay work and archive storage, linear in inbound events.
//
// THE RULE: ingest everything, filter at DISPLAY only. Dropping at ingestion
// would break opening reconstruction, because replay must see every event in
// emission order to arrive at the right accumulators. A "spam" event still
// participates in the arithmetic.
export interface InboundTransfer {
  eventId: string;
  from: string;
  ledger: number;
  /**
   * Plaintext stroops, or null when this device could not determine them.
   *
   * This was the whole `Opening`, of which one field was ever read. It is the
   * value alone now so the real display path can call this with what it has:
   * `private-history.ts` has already turned each event into a decrypted amount
   * by the time anything is shown, and it has no opening to hand back. The
   * module was unreachable from any screen for as long as it demanded one.
   */
  value: bigint | null;
}

export interface DisplayPolicy {
  /** Hide zero-value transfers from senders not in the address book. */
  hideZeroValueFromUnknown: boolean;
  /** Collapse repeated inbound transfers from one address into a group. */
  groupBySender: boolean;
  /** Warn once an account's event count materially affects sync time. */
  eventCountWarnThreshold: number;
}

export const DEFAULT_DISPLAY_POLICY: DisplayPolicy = {
  hideZeroValueFromUnknown: true,
  groupBySender: true,
  eventCountWarnThreshold: 5_000,
};

export interface DisplayGroup {
  from: string;
  known: boolean;
  count: number;
  /** Total received from this sender. Zero-value transfers contribute nothing. */
  total: bigint;
  latestLedger: number;
}

/**
 * What to show in the default view.
 *
 * `hidden` is not discarded: the caller keeps it for the full-ledger view, so a
 * user who wants to see everything can, and nothing we filtered is unreachable.
 */
export function partitionForDisplay(
  transfers: InboundTransfer[],
  knownSenders: Set<string>,
  policy: DisplayPolicy = DEFAULT_DISPLAY_POLICY,
): { shown: InboundTransfer[]; hidden: InboundTransfer[]; groups: DisplayGroup[] } {
  const shown: InboundTransfer[] = [];
  const hidden: InboundTransfer[] = [];

  for (const t of transfers) {
    const isZero = t.value !== null && t.value === 0n;
    const unknown = !knownSenders.has(t.from);
    if (policy.hideZeroValueFromUnknown && isZero && unknown) hidden.push(t);
    else shown.push(t);
  }

  const byS = new Map<string, DisplayGroup>();
  for (const t of shown) {
    const g = byS.get(t.from) ?? {
      from: t.from,
      known: knownSenders.has(t.from),
      count: 0,
      total: 0n,
      latestLedger: 0,
    };
    g.count++;
    g.total += t.value ?? 0n;
    g.latestLedger = Math.max(g.latestLedger, t.ledger);
    byS.set(t.from, g);
  }

  return {
    shown,
    hidden,
    groups: [...byS.values()].sort((a, b) => b.latestLedger - a.latestLedger),
  };
}

/** True when the event count has grown enough to materially slow a sync. */
export function shouldWarnAboutVolume(
  eventCount: number,
  policy: DisplayPolicy = DEFAULT_DISPLAY_POLICY,
): boolean {
  return eventCount >= policy.eventCountWarnThreshold;
}
