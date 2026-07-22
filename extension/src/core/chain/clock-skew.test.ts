// Expiry is the LEDGER's decision, so it has to be measured on the ledger's clock.
//
// `timeBounds` is enforced by the network against the ledger's close time. Every
// expiry decision in this wallet compared `Date.now()` against a maxTime that
// `Date.now()` had also produced: consistent with itself, and wrong about the
// only clock that matters.
//
// A clock S seconds FAST builds maxTime at realNow + S + 180, so the network
// keeps including the envelope until realNow + S + 180 while the wallet calls it
// dead at realNow + 180. That is S seconds in which the wallet believes a
// replacement is safe to build for a transaction the ledger will still apply.
// Measured on testnet with a clock one hour fast: sendTransaction returned
// PENDING and the envelope was accepted, with maxTime 3780 seconds ahead of the
// ledger's own now.
//
// A machine whose clock is wrong is not exotic. A laptop resuming from sleep,
// a VM, a fresh install before NTP has settled: all ordinary.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../../lib/polyfill";
import { chainNow, noteLedgerTime, resetLedgerTime, hasExpired } from "./submit";
import {
  TransactionBuilder,
  Account,
  Operation,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk/base";

const ACCOUNT = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";

/** An envelope whose maxTime is `seconds` from THIS machine's idea of now. */
function envelope(seconds: number) {
  return new TransactionBuilder(new Account(ACCOUNT, "1"), {
    fee: BASE_FEE,
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.bumpSequence({ bumpTo: "0" }))
    .setTimeout(seconds)
    .build();
}

beforeEach(() => {
  resetLedgerTime();
  vi.useFakeTimers();
  // A fixed local wall clock, so "skew" below is exact rather than racing.
  vi.setSystemTime(new Date("2026-08-09T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
  resetLedgerTime();
});

const localNow = () => Math.floor(Date.now() / 1000);

describe("before the ledger has said anything", () => {
  it("uses the local clock, which is the honest starting point", () => {
    // Nothing has been observed, so there is nothing better to use. This is
    // also exactly the old behaviour, which matters: the change must not alter
    // anything until it has learned something.
    expect(chainNow()).toBe(localNow());
  });
});

describe("once a reply has carried the ledger's own clock", () => {
  it("follows the ledger when this machine is running FAST", () => {
    // The dangerous direction. A fast clock makes the wallet declare an
    // envelope dead while the network will still include it.
    noteLedgerTime(localNow() - 3600);
    expect(chainNow()).toBe(localNow() - 3600);
  });

  it("follows the ledger when this machine is running SLOW", () => {
    noteLedgerTime(localNow() + 3600);
    expect(chainNow()).toBe(localNow() + 3600);
  });

  it("ignores a reply that carries no usable time", () => {
    // A missing or nonsense field must not move the offset to some arbitrary
    // place; it simply teaches nothing.
    noteLedgerTime(localNow() - 3600);
    const learned = chainNow();
    for (const junk of [undefined, null, "later", NaN, 0, -5]) {
      noteLedgerTime(junk);
      expect(chainNow(), `${String(junk)} moved the clock`).toBe(learned);
    }
  });
});

describe("the expiry verdict", () => {
  it("does NOT call an envelope dead that the ledger will still include", () => {
    // The whole defect. Local clock one hour fast: the envelope's maxTime is
    // an hour and three minutes ahead of the ledger, so it is very much alive,
    // and the local-clock verdict would have said otherwise the moment three
    // minutes had passed locally.
    const tx = envelope(180);
    noteLedgerTime(localNow() - 3600);
    // Move the LOCAL clock past the envelope's local maxTime.
    vi.advanceTimersByTime(200_000);
    expect(hasExpired(tx), "declared dead while the ledger would still have applied it").toBe(
      false,
    );
  });

  it("does call it dead once the LEDGER's clock has passed maxTime", () => {
    // The control. A verdict that never expires anything strands the wallet on
    // a transaction that can never land.
    const tx = envelope(180);
    noteLedgerTime(localNow() - 3600);
    vi.advanceTimersByTime(3_800_000);
    expect(hasExpired(tx)).toBe(true);
  });

  it("still expires normally when the two clocks agree", () => {
    const tx = envelope(180);
    noteLedgerTime(localNow());
    expect(hasExpired(tx)).toBe(false);
    vi.advanceTimersByTime(200_000);
    expect(hasExpired(tx)).toBe(true);
  });

  it("never expires an envelope with no upper bound", () => {
    const tx = envelope(0);
    noteLedgerTime(localNow() - 3600);
    vi.advanceTimersByTime(10_000_000);
    expect(hasExpired(tx)).toBe(false);
  });
});
