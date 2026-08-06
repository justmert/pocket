// What a spent handle is told, one press after an unresolved submission.
//
// The measured sequence on the most dangerous screen in the product:
//
//   1. Confirm -> "It has not confirmed yet. It may still land, so do not
//      resend: check the hash a536c85b... before trying again."
//   2. Confirm -> "That transaction is no longer pending confirmation. Build it
//      again and review it."
//   3. Build it again -> "A transaction submitted earlier has not resolved yet.
//      Reopen Pocket and check it before sending anything else."
//
// Three sentences, and the middle one contradicts both its neighbours: it tells
// the user to do the exact thing the first forbade, and the wallet then refuses
// it. "Build it again" is right for an ordinary expired handle and wrong here.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";

const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) =>
        k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
    },
  },
});

const { WalletController } = await import("./controller");
const { describeError } = await import("./dispatch");
const { KEYS } = await import("../lib/storage");
const { resetLedgerTime } = await import("./chain/submit");

/** Seconds; the in-flight record's own last valid moment. */
const NOW = Math.floor(Date.now() / 1000);

beforeEach(() => {
  store.clear();
  resetLedgerTime();
});

async function worker() {
  const c = new WalletController();
  await c.init();
  await c.create("pw");
  return c;
}

/** An unresolved submission on disk, exactly as `inFlightSink.record` writes one. */
function holding(maxTime: number, answered?: boolean) {
  store.set(KEYS.inFlight, {
    hash: "a".repeat(64),
    maxTime,
    at: Date.now(),
    ...(answered === undefined ? {} : { answered }),
  });
}

describe("a spent handle while a submission is unresolved", () => {
  it("does not tell the user to build it again", async () => {
    const c = await worker();
    holding(NOW + 120); // still inside its own window

    const err = await c.confirmPayment("deadbeef").catch((e: unknown) => e);
    const said = describeError(err);
    expect(said, "told to resend, one press after being told not to").not.toMatch(
      /build it again/i,
    );
    expect(said).toMatch(/do not send another one/i);
  });

  it("says the same thing on the private path", async () => {
    // The two paths threw different sentences for the same situation.
    const c = await worker();
    holding(NOW + 120);
    const err = await c.confirmPrivateOp("deadbeef").catch((e: unknown) => e);
    expect(describeError(err)).toMatch(/do not send another one/i);
  });

  it("still says build it again when nothing is in flight", async () => {
    // The ordinary expired handle. The advice was right for this case and must
    // stay right: a user with nothing outstanding should just rebuild.
    const c = await worker();
    const err = await c.confirmPayment("deadbeef").catch((e: unknown) => e);
    expect(describeError(err)).toMatch(/build it again/i);
  });

  it("says build it again once the held record is decidably expired", async () => {
    // Expired means the ledger can never include it: `answered` records that a
    // poll really did get "not here", and the window has passed. Rebuilding is
    // then both safe and the right advice.
    const c = await worker();
    holding(NOW - 600, true);
    const err = await c.confirmPayment("deadbeef").catch((e: unknown) => e);
    expect(describeError(err)).toMatch(/build it again/i);
  });

  it("does NOT say build it again when the window passed but nothing ever answered", async () => {
    // `answered: false` means no poll ever got through, which is evidence of
    // nothing at all. Reading that as "expired, safe to rebuild" is how a
    // landed transaction gets sent a second time.
    const c = await worker();
    holding(NOW - 600, false);
    const err = await c.confirmPayment("deadbeef").catch((e: unknown) => e);
    expect(describeError(err)).not.toMatch(/build it again/i);
  });
});
