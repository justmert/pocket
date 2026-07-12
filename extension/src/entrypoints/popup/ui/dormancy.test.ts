// The dormancy warning must not tell someone to do a thing that does not work.
//
// It was written in two places and both said "opening the wallet before then
// keeps it alive". Opening the wallet performs a SIMULATED read, and
// `chain/confidential.ts` says in its own words that a simulated read does not
// bump the entry: only a submitted transaction does. So a user could follow the
// instruction exactly, to the letter, on the day, and still lose access to
// their private pocket.
//
// What is true is one step removed: Pocket submits a keep-alive ITSELF when the
// wallet is unlocked near the deadline. Opening it is sufficient, but not for
// the reason the sentence gave, and the difference is the whole warning.
import { describe, it, expect } from "vitest";
import { dormancyWarning } from "./copy";

describe("what the wallet says about a pocket going dormant", () => {
  it("names the number of days it was given", () => {
    expect(dormancyWarning(6)).toContain("6 days");
  });

  it("does not say a day is days", () => {
    expect(dormancyWarning(1)).toContain("1 day");
    expect(dormancyWarning(1)).not.toContain("1 days");
  });

  it("says a TRANSACTION is what resets the clock", () => {
    expect(dormancyWarning(6)).toMatch(/transaction/i);
  });

  it("says explicitly that looking at it is not enough", () => {
    // The correction. Without this line the sentence still reads as "open the
    // wallet and you are fine", which is what it used to mean and was wrong.
    expect(dormancyWarning(6)).toMatch(/viewing a balance alone is not/i);
  });

  it("still tells the user the one thing they can actually do", () => {
    // Not just a denial: opening the wallet IS sufficient, because that is what
    // lets Pocket send the transaction. A warning with no action is worse.
    expect(dormancyWarning(6)).toMatch(/opening it once before then is enough/i);
  });
});
