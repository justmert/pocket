// Sentences about ONE asset must name the asset they are about.
//
// The private pocket held only XLM for most of the project's life, so several
// messages were written with the symbol typed into the string. They are still
// correct for XLM and wrong for everything else, and a wrong symbol in a
// receipt is not cosmetic: after a half-completed shield it is the only
// sentence that tells the user where their money went.
//
// This is a source read rather than a behavioural test because the branches
// concerned are reached by a SECOND transaction failing after a first one
// succeeded, which no unit harness reproduces cheaply. What it pins is the
// thing that actually regressed: a literal where an interpolation belongs.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

/**
 * Sentences that are ABOUT one confidential asset, and the expression each one
 * must use to name it.
 *
 * Keyed by a distinctive fragment of the sentence rather than a line number, so
 * ordinary edits above them do not turn this red for no reason. A fragment that
 * stops matching fails the liveness check below, which is what stops this list
 * from quietly excusing code that no longer exists.
 */
const PER_ASSET_SENTENCES = [
  {
    file: "src/core/controller.ts",
    fragment: "is in the receiving balance",
    names: "${symbol}",
    why: "the half-landed shield: the deposit applied and the merge did not, so this sentence is the user's only record of what is sitting where",
  },
];

describe("a sentence about one asset", () => {
  it("names the asset it is about, rather than the one that shipped first", () => {
    const wrong: string[] = [];
    for (const s of PER_ASSET_SENTENCES) {
      const line = read(s.file)
        .split("\n")
        .find((l) => l.includes(s.fragment));
      if (!line) continue; // liveness is the next test's job
      if (!line.includes(s.names)) {
        wrong.push(`${s.file}: "${s.fragment}" does not interpolate ${s.names} -- ${s.why}`);
      }
      // And no bare symbol on the same line, which is the exact shape the
      // interpolation replaced: `Your ${deposited} XLM is in the receiving
      // balance` for a USDC shield.
      if (/\bXLM\b/.test(line.replace(/\/\/.*$/, ""))) {
        wrong.push(`${s.file}: "${s.fragment}" still hardcodes XLM -- ${s.why}`);
      }
    }
    expect(wrong, wrong.join("\n")).toEqual([]);
  });

  it("is a live list: every fragment still exists in the source", () => {
    const missing = PER_ASSET_SENTENCES.filter((s) => !read(s.file).includes(s.fragment)).map(
      (s) => `${s.file}: ${s.fragment}`,
    );
    expect(missing, `a guarded sentence has moved or gone:\n${missing.join("\n")}`).toEqual([]);
  });
});
