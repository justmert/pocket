// The idle deadline has to be enforced where requests arrive.
//
// The mirror is gated by `lockAt`, and the two enforcers the module named both
// sit off the request path: `readPersistedUnlock` is authoritative on worker
// START, and the chrome.alarms auto-lock fires while a worker is alive. Chrome
// throttles and coalesces alarms, so a worker that stays alive through a
// throttled one kept answering with the keys in memory, past the window that is
// the only thing standing in front of a wallet left open on a shared machine.
import { describe, it, expect, vi } from "vitest";

// `setSession` fires a best-effort write into the RAM mirror. There is no
// browser here, so the stub keeps that write from surfacing as an unhandled
// rejection; nothing in this file asserts on the mirror.
vi.stubGlobal("chrome", { storage: { session: { set: async () => undefined } } });

const { setSession, clearSession, isUnlocked } = await import("./session");

describe("a deadline that has passed", () => {
  // Two enforcers were named and neither runs on the request path:
  // `readPersistedUnlock` is authoritative on worker START, and the alarm fires
  // while a worker is alive. Chrome throttles and coalesces alarms, so a worker
  // that stays alive through a throttled one answered every request past its
  // own auto-lock deadline with the keys still in memory.
  const S = (lockAt: number) => ({
    dek: new Uint8Array(32) as never,
    seed: new Uint8Array(64) as never,
    address: "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF",
    unlockedAt: 1_000,
    lockAt,
  });

  it("reads as locked even though the session object is still there", () => {
    setSession(S(5_000));
    expect(isUnlocked(4_999)).toBe(true);
    expect(isUnlocked(5_001), "answered past its own auto-lock deadline").toBe(false);
    clearSession();
  });

  it("is not tripped exactly on the deadline", () => {
    // The boundary belongs to the user: the window is "this long", not "this
    // long minus one millisecond".
    setSession(S(5_000));
    expect(isUnlocked(5_000)).toBe(true);
    clearSession();
  });

  it("treats a zero deadline as no deadline, not as long expired", () => {
    // Zero is the shape a record with no window carries. Reading it as
    // "expired in 1970" would lock a wallet that was never given a window.
    setSession(S(0));
    expect(isUnlocked(Date.now())).toBe(true);
    clearSession();
  });

  it("still reads as locked when there is no session at all", () => {
    clearSession();
    expect(isUnlocked()).toBe(false);
  });
});
