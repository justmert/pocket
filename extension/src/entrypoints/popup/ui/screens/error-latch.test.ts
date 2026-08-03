// A refusal must not outlive the input that caused it.
//
// Every compose screen disables its primary action while an error stands, which
// is right: the last attempt was refused and nothing has changed. What was
// wrong is that the error was cleared in ONE input's handler, so changing any
// other input left it set and the button dead. Correct a mistyped EVM address
// and Continue stays grey; change the swap pair after "no route was found for
// that pair and amount" and Continue stays grey. Nothing on screen says why,
// and the only way out is leaving the flow.
//
// The rule is one effect keyed on the inputs, so an input added later cannot
// forget it. This checks that every compose screen has one and that it names
// every input the screen has.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (f: string) => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), "utf8");

/**
 * Every compose screen, the inputs it takes, and whether its primary action is
 * disabled while an error stands.
 *
 * `gated` is where the LATCH lives: a stale error there kills the button. On a
 * screen that is not gated the same stale error is still wrong, because it is a
 * sentence about inputs the user has since changed, so both get the reset and
 * only the gated ones get the second assertion.
 */
const SCREENS: { file: string; inputs: string[]; gated: boolean }[] = [
  { file: "CctpSend.tsx", inputs: ["domain", "recipient", "amount"], gated: true },
  { file: "CctpClaim.tsx", inputs: ["domain", "txHash"], gated: false },
  { file: "Swap.tsx", inputs: ["inId", "outId", "amount", "slippageBps"], gated: true },
  { file: "Send.tsx", inputs: ["to", "amount", "memo"], gated: true },
  { file: "Yield.tsx", inputs: ["kind", "amount"], gated: true },
  { file: "Move.tsx", inputs: ["amount"], gated: true },
];

/** The dependency list of the screen's input-keyed error reset, if it has one. */
function clearedOn(src: string): string[] | null {
  const m = /useEffect\(\(\) => \{\s*setError\(null\);\s*\}, \[([^\]]*)\]\)/.exec(src);
  if (!m) return null;
  return m[1]!
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
}

describe("a refusal on a compose screen", () => {
  for (const { file, inputs } of SCREENS) {
    it(`is cleared by any input changing on ${file}`, () => {
      const deps = clearedOn(read(file));
      expect(deps, `${file} has no input-keyed error reset, so an error latches`).not.toBeNull();
      for (const input of inputs) {
        expect(deps, `${file} does not clear its error when ${input} changes`).toContain(input);
      }
    });
  }

  it("is a real gate on the screens that have one", () => {
    // The premise. If a screen stopped disabling its action on error the latch
    // there would be harmless, and this file would be testing nothing about it.
    for (const { file, gated } of SCREENS.filter((s) => s.gated)) {
      expect(read(file), `${file} does not gate its action on error after all`).toMatch(
        /disabled=\{[^}]*\berror\b/,
      );
      expect(gated).toBe(true);
    }
  });
});
