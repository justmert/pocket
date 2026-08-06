// A holding too small for the display cap is not nothing.
//
// The visible figure shows four fraction digits, truncated: Stellar's seven
// make a long tail on every balance. A holding of 0.00009 XLM has nothing in
// those four digits, so the screen rendered "0.0000", which is the screen
// asserting the account holds nothing when it holds something.
//
// History already got this right through `displayAmount`, so the SAME balance
// read "0.0000" on Home and "<0.0001" one tap away.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Amount } from "./Amount";
import { displayAmount } from "../../../core/chain/balances";
import { theme } from "./theme";

const t = theme("public");

/** What a sighted reader sees: everything the exact-value span does not carry. */
function drawn(html: string): string {
  return (
    html
      .replace(/<span style="position:absolute[^>]*>[^<]*<\/span>/, "")
      .replace(/<[^>]+>/g, "")
      // React escapes the "<" in "<0.0001", so the rendered text carries the
      // entity. Decoded here, because what the test is about is what a person
      // reads on the screen.
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
  );
}

describe("a balance below the display cap", () => {
  it("says it is small rather than saying it is zero", () => {
    const html = renderToStaticMarkup(<Amount t={t} value="0.0000900" code="XLM" reveal />);
    expect(drawn(html), "a real holding was drawn as nothing").not.toMatch(/0\.0000(?!\d)/);
    expect(drawn(html)).toContain("<0.0001");
  });

  it("still announces the exact figure", () => {
    // The cap is a display choice. What the account holds is what a screen
    // reader is told, and it is what the worker signs.
    const html = renderToStaticMarkup(<Amount t={t} value="0.0000900" code="XLM" reveal />);
    expect(html).toContain("0.0000900 XLM");
  });

  it("agrees with History, which is where the same balance is shown again", () => {
    expect(displayAmount("0.0000900")).toBe("<0.0001");
  });

  it("leaves a real zero as a zero", () => {
    // "You hold nothing" is a true and useful thing to say; only a non-zero
    // holding may not be drawn as one.
    const html = renderToStaticMarkup(<Amount t={t} value="0.0000000" code="XLM" reveal />);
    expect(drawn(html)).not.toContain("<0.0001");
  });

  it("leaves an ordinary balance alone", () => {
    const html = renderToStaticMarkup(<Amount t={t} value="12.3456789" code="XLM" reveal />);
    expect(drawn(html)).toContain("12");
    expect(drawn(html)).not.toContain("<0.0001");
  });

  it("does not shorten a figure the screen exists to state exactly", () => {
    // `full` is the confirm and the receipt, where the exact number IS the
    // point and a "<" would be a refusal to say what is being signed.
    const html = renderToStaticMarkup(<Amount t={t} value="0.0000900" code="XLM" full reveal />);
    expect(drawn(html)).not.toContain("<0.0001");
  });

  it("does not leak a magnitude through the mask", () => {
    // A hidden balance must not say "this one is very small".
    const html = renderToStaticMarkup(<Amount t={t} value="0.0000900" code="XLM" hidden />);
    expect(drawn(html)).not.toContain("<0.0001");
  });
});
