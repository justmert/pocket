// The rate on Home's Yield header is a chip, not a sentence.
//
// The measurement window reaches the popup only inside `apy.sentence`, because
// `describeApy` interpolates it there, and the window is what makes the figure
// honest: 14.67% over 7 days and 14.67% over 30 days are different claims. The
// chip lifts it back out, so this test is what keeps the two files' wording in
// step. A silent regex miss would drop the window and leave a bare percentage,
// which is the presentation `describeApy` exists to prevent.
import { describe, it, expect } from "vitest";
import { apyChip } from "./Home";
import { describeApy } from "../../../../core/integrations/defindex";

describe("the yield rate chip", () => {
  it("carries the figure and its window", () => {
    expect(apyChip(describeApy(14.67, 7))).toBe("14.67% · 7d");
  });

  it("reads the window out of the worker's own sentence", () => {
    expect(apyChip(describeApy(20.5, 30))).toBe("20.50% · 30d");
  });

  it("falls back to the bare figure when no window is stated", () => {
    expect(apyChip({ figure: "9.00%", sentence: "9.00%" })).toBe("9.00%");
  });
});
