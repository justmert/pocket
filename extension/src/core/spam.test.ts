import { describe, it, expect } from "vitest";
import { partitionForDisplay, shouldWarnAboutVolume, DEFAULT_DISPLAY_POLICY } from "./spam";
import type { InboundTransfer } from "./spam";

const t = (id: string, from: string, value: bigint | null, ledger = 1): InboundTransfer => ({
  eventId: id,
  from,
  ledger,
  value,
});

const SPAMMER = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const FRIEND = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";

describe("spam is hidden, never dropped", () => {
  it("hides zero-value transfers from unknown senders by default", () => {
    const { shown, hidden } = partitionForDisplay(
      [t("a", SPAMMER, 0n), t("b", FRIEND, 500n)],
      new Set([FRIEND]),
    );
    expect(shown.map((x) => x.eventId)).toEqual(["b"]);
    expect(hidden.map((x) => x.eventId)).toEqual(["a"]);
  });

  it("keeps hidden transfers reachable, so a full ledger view can show them", () => {
    // Nothing filtered may be unreachable: a user who wants to see everything
    // must be able to.
    const all = [t("a", SPAMMER, 0n), t("b", SPAMMER, 0n), t("c", FRIEND, 1n)];
    const { shown, hidden } = partitionForDisplay(all, new Set([FRIEND]));
    expect(shown.length + hidden.length).toBe(all.length);
  });

  it("shows a zero-value transfer from someone you know", () => {
    // A known sender's zero-value transfer is probably deliberate.
    const { shown } = partitionForDisplay([t("a", FRIEND, 0n)], new Set([FRIEND]));
    expect(shown).toHaveLength(1);
  });

  it("shows a real payment from a stranger", () => {
    // Filtering by sender alone would hide legitimate first-time payments.
    const { shown } = partitionForDisplay([t("a", SPAMMER, 100n)], new Set());
    expect(shown).toHaveLength(1);
  });

  it("shows a transfer we could not decrypt, rather than assuming it is spam", () => {
    // opening === null means it was not addressed to us OR we could not read
    // it. Hiding it would mask a real problem.
    const { shown } = partitionForDisplay([t("a", SPAMMER, null)], new Set());
    expect(shown).toHaveLength(1);
  });
});

describe("grouping", () => {
  it("collapses repeated senders and totals what they sent", () => {
    const { groups } = partitionForDisplay(
      [t("a", FRIEND, 100n, 5), t("b", FRIEND, 50n, 9), t("c", SPAMMER, 7n, 3)],
      new Set([FRIEND]),
    );
    const friend = groups.find((g) => g.from === FRIEND)!;
    expect(friend.count).toBe(2);
    expect(friend.total).toBe(150n);
    expect(friend.latestLedger).toBe(9);
    expect(friend.known).toBe(true);
  });

  it("orders groups by recency", () => {
    const { groups } = partitionForDisplay(
      [t("a", FRIEND, 1n, 2), t("b", SPAMMER, 1n, 99)],
      new Set(),
    );
    expect(groups[0]?.from).toBe(SPAMMER);
  });
});

describe("volume warning", () => {
  it("warns once sync time is materially affected", () => {
    // Storage and replay cost grow linearly in inbound events, so a user whose
    // account has been targeted deserves to know why it got slow.
    expect(shouldWarnAboutVolume(10)).toBe(false);
    expect(shouldWarnAboutVolume(DEFAULT_DISPLAY_POLICY.eventCountWarnThreshold)).toBe(true);
  });
});
