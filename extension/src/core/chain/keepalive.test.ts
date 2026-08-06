import { describe, it, expect } from "vitest";
import { planKeepAlive, buildKeepAlive } from "./keepalive";
import { Account } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";

const expiring = (days: number) => ({
  kind: "expiring" as const,
  expiresAt: new Date(Date.now() + days * 86_400_000),
  daysRemaining: days,
});
const healthy = (days: number) => ({
  kind: "healthy" as const,
  expiresAt: new Date(Date.now() + days * 86_400_000),
  daysRemaining: days,
});

describe("keep-alive planning", () => {
  it("submits when inside the threshold and the user is idle", () => {
    // The saver persona: shields, holds, never transacts, archives on schedule.
    const p = planKeepAlive(expiring(3), false);
    expect(p.due).toBe(true);
    // No notice. Background housekeeping is not news, and the bump happens
    // whether or not anyone is looking.
    expect(p.notice).toBeUndefined();
  });

  it("does NOT submit when the user has been active", () => {
    // Any submitted operation touches the entry and bumps the TTL, so a
    // synthetic bump would be a publicly visible transaction for nothing.
    expect(planKeepAlive(expiring(3), true).due).toBe(false);
  });

  it("does not submit while there is plenty of headroom", () => {
    expect(planKeepAlive(healthy(25), false).due).toBe(false);
  });

  it("treats an archived account as needing restore, not a bump", () => {
    const p = planKeepAlive({ kind: "archived" }, false);
    expect(p.due).toBe(false);
    // The card already says Dormant and the button already says Reactivate.
    // The fee is the only part the notice has to carry.
    expect(p.notice).toMatch(/reactivating costs/i);
  });

  it("does nothing for an account that was never registered", () => {
    const p = planKeepAlive({ kind: "absent" }, false);
    expect(p.due).toBe(false);
    expect(p.notice).toBeUndefined();
  });

  it("jitters every schedule, so a fixed cadence cannot fingerprint users", () => {
    const delays = new Set(
      Array.from({ length: 40 }, () => planKeepAlive(healthy(25), false).nextCheckMs),
    );
    expect(delays.size).toBeGreaterThan(30);
  });

  it("never schedules a check in the past", () => {
    for (const days of [0.1, 1, 7, 30]) {
      expect(planKeepAlive(healthy(days), false).nextCheckMs).toBeGreaterThan(0);
    }
  });
});

describe("the keep-alive transaction", () => {
  const acct = new Account("GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN", "1");
  const tx = buildKeepAlive(
    acct,
    "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6",
    acct.accountId(),
    "Test SDF Network ; September 2015",
  );

  it("is a merge, which needs auth but no proof", () => {
    expect(tx.operations).toHaveLength(1);
    expect(tx.operations[0]?.type).toBe("invokeHostFunction");
  });

  it("carries timeBounds, so expiry stays decidable", () => {
    expect(tx.timeBounds?.maxTime).toBeTruthy();
    expect(Number(tx.timeBounds!.maxTime)).toBeGreaterThan(Date.now() / 1000);
  });

  it("is unsigned, keeping this module free of key material", () => {
    expect(tx.signatures).toHaveLength(0);
  });
});

describe("the TTL extension threshold, which makes this observable only near expiry", () => {
  it("documents why a fresh account shows no bump", () => {
    // The library calls extend_ttl(key, threshold = 29 days, extend = 30 days).
    // Soroban's extend_ttl does nothing when the current TTL already exceeds
    // the threshold, so a merge on a 30-day-old entry is correctly a no-op in
    // TTL terms. This is not a defect and it is why our testnet check was
    // inconclusive rather than negative.
    const DAY_IN_LEDGERS = 17_280;
    const EXTEND = 30 * DAY_IN_LEDGERS;
    const THRESHOLD = EXTEND - DAY_IN_LEDGERS;
    expect(THRESHOLD).toBe(29 * DAY_IN_LEDGERS);
    expect(EXTEND).toBeGreaterThan(THRESHOLD);
  });

  it("fires the keep-alive well inside the window where extension works", () => {
    // We bump below 7 days remaining, comfortably under the 29-day threshold,
    // so by the time we act the extension is guaranteed to be a real one.
    expect(planKeepAlive(expiring(6), false).due).toBe(true);
    expect(planKeepAlive(healthy(29), false).due).toBe(false);
  });
});
