// Three primitives whose documented behaviour and real behaviour differed.
//
//   Button    `busy` is documented as "blocks a second press". It dropped the
//             React handler, which stops a mouse click and does nothing about
//             the browser: a `type="submit"` button keeps its default action,
//             and the HTML spec's implicit submission fires a click on the
//             default button when Enter is pressed in a field. The gate held
//             for the mouse only.
//   Field     accepts `onSubmit`, typed and documented, and wired it to the
//             single-line branch alone. A multiline caller got no error, no
//             warning, and no behaviour.
//   Spinner   `color` painted the GAP. `borderColor` was pinned to
//             currentColor and the caller's colour went to `borderTopColor`,
//             which is the quarter left out to make the ring look like it
//             spins, so a caller passing a theme colour got the opposite of
//             what it asked for.
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Button, Field, Spinner } from "./primitives";
import { theme } from "./theme";

const t = theme("public");

/**
 * `primitives.tsx` itself.
 *
 * Two of the properties below are browser behaviours a static render cannot
 * show: the default action of a submit button, and which key a textarea treats
 * as "send". What regressed in each case is one expression, and this is the
 * assertion that pins it.
 */
const SOURCE = readFileSync(fileURLToPath(new URL("./primitives.tsx", import.meta.url)), "utf8");

describe("a busy Button", () => {
  it("keeps its submit type rather than falling out of the form", () => {
    // `disabled` would drop a focused control to the document body, which is
    // exactly where the user was left every time they pressed the button that
    // starts the slow work.
    const html = renderToStaticMarkup(
      <Button t={t} busy type="submit">
        Continue
      </Button>,
    );
    expect(html).toContain('type="submit"');
    // `aria-disabled` says so without leaving the tab order; the real
    // `disabled` attribute is what drops focus, and it must not be here.
    expect(html, "a busy button left the tab order").not.toMatch(/(^|[^-])\bdisabled=""/);
  });

  it("says it is unavailable to assistive technology", () => {
    const html = renderToStaticMarkup(
      <Button t={t} busy>
        Continue
      </Button>,
    );
    expect(html).toContain('aria-disabled="true"');
  });

  it("cancels the press rather than merely not handling it", () => {
    // A source read: the default action is a browser behaviour, and no static
    // render can show it. What regressed is one expression.
    const src = SOURCE;
    expect(src, "a busy submit could still be driven from the keyboard").toMatch(
      /off\s*\?\s*\(e\) => \{\s*e\.preventDefault\(\);/,
    );
  });
});

describe("a multiline Field", () => {
  it("wires onSubmit, like every other Field", () => {
    const html = renderToStaticMarkup(
      <Field
        t={t}
        label="Recovery phrase"
        value=""
        onChange={() => undefined}
        multiline
        onSubmit={() => undefined}
      />,
    );
    expect(html).toContain("<textarea");
    // The handler is not visible in static markup, so the property under test
    // is read from source; the render above is what proves the branch exists.
    const textarea = SOURCE.slice(SOURCE.indexOf("<textarea"));
    expect(textarea, "onSubmit is accepted and silently dropped here").toMatch(/onSubmit\(\)/);
  });

  it("keeps bare Enter for a newline, because this is where a phrase is typed", () => {
    const textarea = SOURCE.slice(SOURCE.indexOf("<textarea"));
    expect(textarea.slice(0, 1200)).toMatch(/e\.metaKey \|\| e\.ctrlKey/);
  });
});

describe("a Spinner given a colour", () => {
  it("paints the ring with it", () => {
    const html = renderToStaticMarkup(<Spinner color="#ff0000" />);
    expect(html, "the colour went to the gap").toMatch(/border-color:\s*#ff0000/);
    expect(html).toMatch(/border-top-color:\s*transparent/);
  });

  it("is unchanged when given none", () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).toMatch(/border-color:\s*currentColor/i);
    expect(html).toMatch(/border-top-color:\s*transparent/);
  });
});
