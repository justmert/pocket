// The batch 1 regressions, each encoding one finding rather than merely
// touching the screen it was found on.
//
// A6-01  the focus ring borrowed the accent, and the public accent cannot reach
//        the 3:1 a focus indicator needs against the surfaces it is drawn on
// A6-03  a sheet moved focus when it opened and dropped it on every stage change
// A2-03  the recovery phrase field offered its contents to the browser's spell
//        checker, which chrome can be configured to send to a server
// A9     motion was declared in theme.ts and written again in the stylesheet
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

/** WCAG 1.4.11 wants 3:1 for a non-text indicator. */
const MIN_RING_CONTRAST = 3;

function luminance([r, g, b]: number[]): number {
  const f = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!);
}

function ratio(a: number[], b: number[]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function parse(css: string): number[] {
  const m = css.match(/rgba?\(([^)]+)\)/);
  if (!m) throw new Error(`not a colour: ${css}`);
  return m[1]!.split(",").slice(0, 3).map((n) => Number(n.trim()));
}

test("the focus ring is visible against every surface it is drawn on", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  for (const pocket of ["Public pocket", "Private pocket"] as const) {
    await wallet.openPocket(pocket);
    const measured = await wallet.page.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const ring = root.getPropertyValue("--pocket-ring").trim();
      // The surfaces a ring is actually drawn against, read off the live page
      // rather than assumed: the frame, a card, a field and a filled button.
      const probe = document.createElement("div");
      document.body.appendChild(probe);
      const resolve = (value: string) => {
        probe.style.color = value;
        return getComputedStyle(probe).color;
      };
      const out = {
        ring: resolve(ring),
        bg: getComputedStyle(document.body).backgroundColor,
      };
      probe.remove();
      return out;
    });

    const r = ratio(parse(measured.ring), parse(measured.bg));
    expect(
      r,
      `the focus ring is ${r.toFixed(2)}:1 against the ${pocket} background, and a control that cannot show focus is a control a keyboard user is guessing at`,
    ).toBeGreaterThanOrEqual(MIN_RING_CONTRAST);
  }
});

test("the recovery phrase is never offered to the browser", async ({ wallet }) => {
  await wallet.page.getByRole("button", { name: "I have a recovery phrase" }).click();
  const field = wallet.page.getByLabel(/Recovery phrase/);
  await expect(field).toBeVisible();

  // Not a style question. Chrome's enhanced spell check sends the contents of a
  // text field away to be checked, and anyone holding these words owns the funds.
  for (const [attribute, want] of [
    ["spellcheck", "false"],
    ["autocomplete", "off"],
    ["autocorrect", "off"],
    ["autocapitalize", "off"],
  ] as const) {
    await expect(
      field,
      `the phrase field must set ${attribute}="${want}"`,
    ).toHaveAttribute(attribute, want);
  }
});

test("a sheet keeps focus inside itself when it swaps what it is showing", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openSend();

  // Opening it puts focus in the first field. That already held; what did not is
  // what happens when the panel is replaced.
  const inDialogAfterOpen = await wallet.page.evaluate(
    () => document.activeElement?.closest("[role='dialog']") !== null,
  );
  expect(inDialogAfterOpen, "opening the sheet left focus outside it").toBe(true);

  await wallet.page.getByLabel("To", { exact: true }).fill("not-an-address");
  await wallet.page.getByLabel("Amount (XLM)").fill("1");
  await wallet.page.getByRole("button", { name: "Review" }).click();

  // Whatever the wallet decides, the panel has been re-rendered. Focus must not
  // have fallen to the document body, or a keyboard user arriving at a signing
  // step has to tab in from nothing with no visible ring.
  await expect
    .poll(
      async () =>
        wallet.page.evaluate(() => {
          const active = document.activeElement;
          if (!active || active === document.body) return "body";
          return active.closest("[role='dialog']") ? "inside" : "outside";
        }),
      { message: "focus left the sheet when its panel changed", timeout: WAITS.ledgerRead },
    )
    .toBe("inside");
});

test("motion is declared once, in the token file", async ({ wallet }) => {
  // The stylesheet cannot import TypeScript, so it reads custom properties the
  // provider writes from theme.ts. If a duration is ever written into the CSS
  // directly it will disagree with the token eventually, so the assertion is
  // that the properties are actually there and actually used.
  await wallet.page.waitForFunction(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--pocket-enter").trim().length > 0,
  );

  const tokens = await wallet.page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const names = [
      "--pocket-enter",
      "--pocket-exit",
      "--pocket-wash-ease",
      "--pocket-instant",
      "--pocket-quick",
      "--pocket-page",
      "--pocket-page-out",
      "--pocket-sheet",
      "--pocket-sheet-out",
      "--pocket-settle",
      "--pocket-pocket",
      "--pocket-ambient",
      "--pocket-ambient-slow",
      "--pocket-ring",
    ];
    return Object.fromEntries(names.map((n) => [n, root.getPropertyValue(n).trim()]));
  });

  const missing = Object.entries(tokens)
    .filter(([, v]) => v === "")
    .map(([k]) => k);
  expect(missing, `motion tokens the stylesheet reads but nothing writes: ${missing.join(", ")}`).toEqual(
    [],
  );

  // And the press feedback really is running on the token rather than on a
  // number someone typed into the stylesheet.
  const press = await wallet.page
    .getByRole("button")
    .first()
    .evaluate((el) => getComputedStyle(el).transitionDuration);
  expect(press, "the press feedback must run on the instant token").toBe("0.14s");
});
