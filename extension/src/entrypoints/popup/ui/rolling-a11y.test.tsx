// A rolling figure has to say ONE number.
//
// `Rolling` renders a full 0..9 column per digit and clips nine of the ten with
// `overflow: hidden` on the parent. That hides them from the eye and not from
// the accessibility tree, so an unwrapped `<Rolling>` is announced as every
// column of every digit: a 70-character run of numerals where a price belongs.
//
// The guard used to live at each call site as a hand-written `<span
// aria-hidden>`, and of the five call sites in the tree, four had it. The one
// that did not was the asset detail sheet's per-unit price.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RollingFigure, Rolling, Amount } from "./Amount";
import { theme } from "./theme";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The text a screen reader would read: everything not inside aria-hidden. */
function announced(html: string): string {
  return html.replace(/<span aria-hidden[^>]*>[\s\S]*?<\/span>\s*$/, "").replace(/<[^>]+>/g, "");
}

describe("a rolling price", () => {
  it("announces the figure once, not every digit column", () => {
    const html = renderToStaticMarkup(<RollingFigure value="$0.165568" />);
    // The decoration really is there (this is not a test that passes by
    // rendering nothing).
    expect(html).toContain("aria-hidden");
    expect(announced(html)).toBe("$0.165568");
  });

  it("is a real problem being solved, not a hypothetical one", () => {
    // The bare component, so the property under test is visible rather than
    // asserted about. Ten columns per digit is what makes the wrapper matter.
    const bare = renderToStaticMarkup(<Rolling value="$0.16" />);
    const digits = (bare.match(/\d/g) ?? []).length;
    expect(digits).toBeGreaterThan(10);
  });

  it("does not leak the columns through Amount either", () => {
    // `Amount` pairs the exact string with an aria-hidden run of its own, and
    // its rolling digits live inside that run. Asserted by rendering rather
    // than by reading, because this is the component the whole wallet draws
    // balances with.
    const html = renderToStaticMarkup(
      <Amount t={theme("public")} value="1234.5678" code="XLM" reveal />,
    );
    expect(announced(html)).toContain("1234.5678 XLM");
  });

  it("has no bare <Rolling> outside the component that defines the pairing", () => {
    // The failure mode is a NEW call site written without the wrapper, which no
    // render of the existing ones can catch. `Amount.tsx` is the definition
    // site and is covered by the render above; everywhere else must either use
    // `RollingFigure` or put the roll inside an `aria-hidden` of its own,
    // within sight of the call.
    const files = ["./sheets/AssetDetailSheet.tsx", "./AmountComposer.tsx"];
    const unguarded: string[] = [];
    for (const rel of files) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      for (const m of src.matchAll(/<Rolling\b/g)) {
        const at = m.index;
        const line = src.slice(src.lastIndexOf("\n", at) + 1, src.indexOf("\n", at));
        if (/^\s*[*/]/.test(line)) continue;
        if (/RollingFigure/.test(line)) continue;
        if (/aria-hidden/.test(src.slice(Math.max(0, at - 200), at))) continue;
        unguarded.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(unguarded, `an unguarded <Rolling>:\n${unguarded.join("\n")}`).toEqual([]);
  });
});
