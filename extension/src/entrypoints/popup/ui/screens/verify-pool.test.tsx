// The backup check has to check something.
//
// The Verify step asks for three words by position and offers chips to place
// into the blanks. The pool held ONLY the three correct words, so it asked the
// user to put three chips in an order rather than to know anything: 3! = 6
// arrangements, unlimited retries, and every answer visible on screen. Someone
// who had written nothing down was through it in a few taps.
//
// It is the only gate asserting the phrase was written down, and the only
// caller of `clearOnboardingUnfinished`. Past it, the wallet stops warning that
// onboarding is unfinished, and the phrase is never shown again without the
// password.
import { describe, it, expect } from "vitest";
import { withDecoys, VERIFY_POOL_SIZE } from "./Onboarding";

const PHRASE =
  "abandon ability able about above absent absorb abstract absurd abuse access accident".split(" ");

describe("the chips offered on the backup check", () => {
  it("offers more than just the answers", () => {
    // The defect, stated as the property. With three chips for three blanks the
    // step has no wrong answer available to give.
    const pool = withDecoys(PHRASE, [0, 5, 9]);
    expect(pool.length).toBeGreaterThan(3);
    expect(pool.length).toBe(VERIFY_POOL_SIZE);
  });

  it("still contains every word it is going to ask for", () => {
    // A pool missing an answer is unanswerable, which locks out the one user
    // this step exists to serve.
    const asked = [2, 4, 11];
    const pool = withDecoys(PHRASE, asked);
    for (const n of asked) expect(pool).toContain(PHRASE[n]);
  });

  it("takes its decoys from the phrase, so every chip is plausible", () => {
    const pool = withDecoys(PHRASE, [0, 1, 2]);
    for (const chip of pool) expect(PHRASE).toContain(chip);
  });

  it("never offers the same word twice, which would be unanswerable", () => {
    // Two identical chips are indistinguishable to a user, so one of them is a
    // guess whatever they know.
    const pool = withDecoys(PHRASE, [3, 7, 10]);
    expect(new Set(pool).size).toBe(pool.length);
  });

  it("makes guessing impractical rather than merely awkward", () => {
    // Three ordered choices from the pool. Six arrangements is a step a user
    // brute-forces without noticing; this is the number that has to move.
    const pool = withDecoys(PHRASE, [0, 5, 9]);
    const n = pool.length;
    const arrangements = n * (n - 1) * (n - 2);
    expect(arrangements).toBeGreaterThan(100);
  });

  it("does not loop or pad when the phrase cannot supply enough decoys", () => {
    // A short list yields a smaller pool. Returning duplicates or spinning
    // forever would both be worse than three honest chips.
    const tiny = ["one", "two", "three", "four"];
    const pool = withDecoys(tiny, [0, 1, 2]);
    expect(new Set(pool).size).toBe(pool.length);
    expect(pool.length).toBeLessThanOrEqual(tiny.length);
    for (const n of [0, 1, 2]) expect(pool).toContain(tiny[n]);
  });

  it("keeps a repeated word from becoming an impossible chip", () => {
    // A BIP-39 phrase can legally repeat a word. The answers are matched by
    // TEXT, so a decoy equal to an answer must not be offered as a second chip.
    const repeated = ["alpha", "beta", "alpha", "gamma", "delta", "epsilon", "zeta", "eta"];
    const pool = withDecoys(repeated, [0, 1, 3]);
    expect(new Set(pool).size).toBe(pool.length);
    expect(pool.filter((w) => w === "alpha")).toHaveLength(1);
  });
});

describe("the step as it actually renders", () => {
  // The owner's call: the confirm shows the whole phrase (dots + three blanks)
  // and offers exactly the three answer words as chips, matching the common
  // seed-confirm pattern rather than padding the pool with decoys. This is a
  // deliberate trade -- three chips for three blanks is 3! = 6 orderings -- and
  // this test pins that intended shape so a future change back to decoys is a
  // visible decision, not a silent drift.
  it("offers exactly the three words being asked for, and no decoys", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Verify } = await import("./Onboarding");
    const { theme } = await import("../theme");
    const html = renderToStaticMarkup(
      <Verify
        t={theme("private")}
        words={PHRASE}
        fullPage={false}
        onBack={() => undefined}
        onDone={() => undefined}
      />,
    );
    // Every chip is a button carrying one word from the phrase; there are three.
    const chips = PHRASE.filter((w) => html.includes(`>${w}</button>`));
    expect(chips.length).toBe(3);
  });

  it("marks each blank with the position it is asking for", async () => {
    // The browser tier reads these to know which word to tap. Without them the
    // helper has to guess an order, which is how it came to drive fields that
    // no longer existed.
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { Verify } = await import("./Onboarding");
    const { theme } = await import("../theme");
    const html = renderToStaticMarkup(
      <Verify
        t={theme("private")}
        words={PHRASE}
        fullPage={false}
        onBack={() => undefined}
        onDone={() => undefined}
      />,
    );
    expect((html.match(/data-testid="verify-blank"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/data-position="\d+"/);
  });
});
