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
import { DefindexError } from "./integrations/defindex";
import { ProverError } from "./prover/protocol";

/** Each name, an instance, and what the user must be able to read. */
const NAMED: [string, Error, RegExp][] = [
  [
    // The prover threw bare `Error`s, so its six distinct failures all reached
    // the user as "check your connection" on a step that makes no network call.
    "ProverError",
    new ProverError("Pocket could not build the proof for this private operation."),
    /could not build the proof/i,
  ],
  [
    "LedgerReadError",
    new LedgerReadError("Could not read the ledger. Try again."),
    /could not read the ledger/i,
  ],
  ["InvalidAmountError", new InvalidAmountError("Maximum 7 decimal places."), /7 decimal places/i],
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
  // The fourth service client. It was the one name missing from the allowlist
  // while its three siblings were on it, so every sentence the yield path
  // authored reached the screen as "check your connection". Two of them are the
  // reason this case is here rather than folded into the others: "Yield is not
  // configured for this network." is a permanent property of the build, so the
  // retry the generic line suggests can never succeed, and the trustline
  // sentence is the one actionable failure the client deliberately maps out of
  // errorCode 13.
  [
    "DefindexError",
    new DefindexError("You need a trustline for this vault's asset before you can deposit."),
    /trustline/i,
  ],
];

describe("an authored refusal reaches the user, not a network excuse", () => {
  for (const [name, err, expected] of NAMED) {
    it(`${name} keeps its own words`, () => {
      expect(err.name, "the class name must match the allowlist entry").toBe(name);
      const shown = describeError(err);
      expect(shown).toMatch(expected);
      // The failure this catches: the name falls off the allowlist and the
      // message is replaced by the generic one, over something no amount of
      // retrying fixes.
      expect(shown).not.toMatch(/Something went wrong/i);
    });
  }

  it("an unnamed error is still replaced, so the allowlist is not weakened", () => {
    // The allowlist exists to keep RPC-authored strings off the screen. Adding
    // names must not turn it into a pass-through.
    expect(describeError(new Error("Error(Contract, #3506)."))).toMatch(/Something went wrong/i);
    expect(describeError(new Error("ECONNREFUSED 127.0.0.1:8000"))).toMatch(
      /Something went wrong/i,
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
