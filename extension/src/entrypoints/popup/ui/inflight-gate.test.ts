// When an unresolved submission is allowed to take the whole screen.
//
// The in-flight record is written BEFORE `sendTransaction` and cleared only on a
// terminal outcome, so it is on disk for the whole of every ordinary confirm.
// Chrome dismisses a toolbar popup the moment it loses focus, so reopening one
// mid-confirm re-mounts the tree, finds the record and, before this gate,
// replaced the wallet with the full-screen "Unfinished transaction" blocker.
// Nothing on that screen is false; it is written for the crash case, reads as
// one, contradicts the "this will continue in the background" the processing
// view promised seconds earlier, and removes every other control.
import { describe, it, expect } from "vitest";
import { blockingInFlight } from "./App";

const NOW = Date.now();

describe("an unresolved submission only blocks once nobody is watching it", () => {
  it("does not block during an ordinary confirm", () => {
    expect(blockingInFlight({ expired: false, at: NOW - 3_000 })).toBe(false);
  });

  it("does not block during a slow private one, which proves for up to 165s", () => {
    expect(blockingInFlight({ expired: false, at: NOW - 150_000 })).toBe(false);
  });

  it("blocks once the record outlives the longest honest confirm", () => {
    expect(blockingInFlight({ expired: false, at: NOW - 400_000 })).toBe(true);
  });

  it("blocks an EXPIRED record however recent, because it can never apply now", () => {
    // The other half of the rule, and the one the screen was actually built for.
    expect(blockingInFlight({ expired: true, at: NOW })).toBe(true);
  });

  it("blocks a record with no timestamp, because absent must read as old", () => {
    // Written by an earlier build. Guessing "recent" here would hide the blocker
    // in exactly the crash case it exists for.
    expect(blockingInFlight({ expired: false })).toBe(true);
  });
});
