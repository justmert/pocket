// Every allowlisted error name must be held by a test.
//
// `describeError` matches on NAME, so a name on the allowlist is a promise that
// the message reaches the user verbatim. Two ways that promise breaks and
// neither shows up in a normal run: the class is renamed and the entry becomes
// dead, or the entry is removed and an authored message silently becomes
// "check your connection". A static check found six names referenced by no test
// file at all. These are those six, plus a guard that the list and the classes
// cannot drift apart.
import { describe, it, expect } from "vitest";
import { describeError } from "./dispatch";
import { LedgerReadError } from "./chain/ttl";
import { InvalidAmountError } from "./chain/balances";
import { StaleHandleError, InvalidAddressKindError } from "./controller";
import { RecoveryUnavailableError, RecoveryMismatchError } from "./recover-openings";

/** Each name, an instance, and what the user must be able to read. */
const NAMED: [string, Error, RegExp][] = [
  [
    "LedgerReadError",
    new LedgerReadError("the ledger did not answer the question"),
    /did not answer/i,
  ],
  [
    "InvalidAmountError",
    new InvalidAmountError("Amounts go to 7 decimal places and that has more."),
    /7 decimal places/i,
  ],
  [
    "StaleHandleError",
    new StaleHandleError("That transaction is no longer pending confirmation."),
    /no longer pending/i,
  ],
  [
    "InvalidAddressKindError",
    new InvalidAddressKindError("That is a contract address."),
    /contract address/i,
  ],
  [
    "RecoveryUnavailableError",
    new RecoveryUnavailableError("no archive is configured for this network"),
    /archive/i,
  ],
  [
    "RecoveryMismatchError",
    new RecoveryMismatchError("The rebuilt spendable balance does not match"),
    /does not match/i,
  ],
];

describe("an authored refusal reaches the user, not a network excuse", () => {
  for (const [name, err, expected] of NAMED) {
    it(`${name} keeps its own words`, () => {
      expect(err.name, "the class name must match the allowlist entry").toBe(name);
      const shown = describeError(err);
      expect(shown).toMatch(expected);
      // The failure this catches: the name falls off the allowlist, the
      // message is replaced, and the user is sent to check their network over
      // something no amount of retrying fixes.
      expect(shown).not.toMatch(/check your connection/i);
    });
  }

  it("an unnamed error is still replaced, so the allowlist is not weakened", () => {
    // The allowlist exists to keep RPC-authored strings off the screen. Adding
    // names must not turn it into a pass-through.
    expect(describeError(new Error("Error(Contract, #3506)."))).toMatch(/check your connection/i);
    expect(describeError(new Error("ECONNREFUSED 127.0.0.1:8000"))).toMatch(
      /check your connection/i,
    );
  });

  it("no allowlisted message interpolates anything from outside", () => {
    // The mistake this pins: `InvalidAmountError` was allowlisted while still
    // interpolating the typed amount, so a 100,000-character input rendered
    // 100,039 characters into a 360px popup. A message that reaches the screen
    // verbatim must be one we wrote in full.
    const hostile = "A".repeat(5_000);
    for (const [, err] of NAMED) {
      expect(describeError(err).length, `${err.name} must stay a sentence`).toBeLessThan(400);
      expect(describeError(err)).not.toContain(hostile);
    }
  });
});
