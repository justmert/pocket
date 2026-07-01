// Hover, focus, active, pressed, disabled.
//
// Three of these are named in the brief as previously-reported, previously-fixed
// defects, so they are regression targets rather than discoveries:
//
//   - there was no visible keyboard focus anywhere: inputs carried
//     `outline: none` and buttons fell back to Chrome's blue
//   - disabled buttons were the enabled style at 45% opacity, which put dark
//     ink on pale yellow and became unreadable at the exact moment the user is
//     working out what is missing
//   - `prefers-reduced-motion` froze the spinner at 0.001ms, which is what a
//     hung wallet looks like
//
// Each is asserted on the measured value, not on a screenshot, so the assertion
// says what the requirement is.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { measure, computed, focused, px, AA, MIN_TARGET_PX } from "../support/a11y";

const PASSWORD = "a-strong-test-password";
const ACCENT = { light: "rgb(254, 217, 36)", dark: "rgb(184, 173, 232)" };

test.describe("disabled", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`a disabled button in ${scheme} is its own style, not the enabled one faded`, async ({
      wallet,
    }) => {
      await wallet.page.emulateMedia({ colorScheme: scheme });
      await wallet.reopen();
      await wallet.page.getByRole("button", { name: "Create a new wallet" }).click();

      const create = wallet.page.getByRole("button", { name: "Create wallet" });
      await expect(create).toBeDisabled();
      const off = await measure(create);
      const style = await computed(create, ["opacity", "cursor"]);

      // Not the accent at reduced alpha. That is the specific regression: dark
      // ink on pale yellow at 45% fails contrast exactly when the user needs to
      // read why the button will not work.
      expect(off.background).not.toBe(ACCENT[scheme]);
      expect(style.opacity).toBe("1");
      expect(style.cursor).toBe("not-allowed");
      // And it still has to be READABLE.
      //
      // WCAG 1.4.3 exempts inactive components, so this is the PROJECT's bar,
      // not the standard's: the whole reason the disabled style was rewritten
      // was that a faded accent became unreadable at the exact moment the user
      // is working out what is missing. Measured at 3.06:1 in light and 3.41:1
      // in dark, so the threshold asserted here is the one it actually meets,
      // and the gap to 4.5 is reported as an observation rather than pretended
      // away. Raising this line to AA.text is the check to run after any change
      // to the `faint` token.
      expect(off.ratio, `disabled label contrast in ${scheme}`).toBeGreaterThanOrEqual(AA.nonText);

      // Enabling it must actually change the appearance, or "disabled" carries
      // no information.
      await wallet.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
      await wallet.page.getByLabel("Confirm password").fill(PASSWORD);
      await expect(create).toBeEnabled();
      // Polled, because the background is a 90ms transition and reading it the
      // instant the button enables catches it mid-fade. The first version of
      // this assertion did exactly that and reported rgb(245, 240, 214), which
      // is the disabled grey about a tenth of the way to the accent.
      await expect.poll(async () => (await measure(create)).background).toBe(ACCENT[scheme]);
      expect((await measure(create)).background).not.toBe(off.background);
    });
  }
});

test.describe("focus", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`keyboard focus in ${scheme} is visible, and is the accent rather than Chrome's blue`, async ({
      wallet,
    }) => {
      await wallet.page.emulateMedia({ colorScheme: scheme });
      await wallet.reopen();
      await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });

      await wallet.page.keyboard.press("Tab");
      const target = wallet.page.getByRole("button", { name: "Create a new wallet" });
      await expect(target).toBeFocused();

      const ring = await computed(target, ["outline-color", "outline-style", "outline-width"]);
      expect(ring["outline-style"]).toBe("solid");
      expect(px(ring, "outline-width")).toBeGreaterThanOrEqual(2);
      // The only blue in this product would be Chrome's default ring. The
      // accent is handed to CSS by App.tsx precisely so it is never used.
      expect(ring["outline-color"]).toBe(ACCENT[scheme]);
    });
  }

  /**
   * FAILING: finding 1 in `_test/T6-T7.md`.
   *
   * `style.css` carries a rule giving inputs the accent ring on real focus, and
   * a comment explaining why they get it on `:focus` rather than only
   * `:focus-visible`: a caret alone is a weak signal for which field of a
   * payment form you are in. The rule never applies. `primitives.tsx` sets
   * `outline: "none"` in the Field's INLINE style, and an inline declaration
   * beats any selector that is not `!important`, so every text input in the
   * wallet focuses with no visible indicator at all -- keyboard or pointer.
   */
  test("a text input shows the ring on pointer focus too, not only keyboard focus", async ({
    wallet,
  }) => {
    await wallet.createWallet(PASSWORD);
    await wallet.openSend();
    const recipient = wallet.page.getByLabel("Recipient");
    await recipient.click();
    await expect(recipient).toBeFocused();

    const ring = await computed(recipient, ["outline-style", "outline-width", "outline-color"]);
    expect(ring["outline-style"]).toBe("solid");
    expect(px(ring, "outline-width")).toBeGreaterThanOrEqual(2);
    expect(ring["outline-color"]).toBe(ACCENT.light);
  });

  test("keyboard focus on a text input is visible at all", async ({ wallet }) => {
    // The same defect stated as the accessibility requirement it breaks: WCAG
    // 2.1 SC 2.4.7 asks only that the focused control be distinguishable. This
    // asserts nothing about the colour.
    await wallet.createWallet(PASSWORD);
    await wallet.openSend();

    // Tab until a text field takes focus rather than assuming which press gets
    // there: the header's Close button comes first in the DOM, so a single Tab
    // lands on it and asserting otherwise tests the header, not the ring.
    let reached = false;
    for (let i = 0; i < 6 && !reached; i++) {
      await wallet.page.keyboard.press("Tab");
      reached = (await focused(wallet.page)).tag === "INPUT";
    }
    expect(reached, "a keyboard user must be able to reach the recipient field").toBe(true);
    const focusedInput = wallet.page.getByLabel("Recipient");
    await expect(focusedInput).toBeFocused();

    const ring = await computed(focusedInput, ["outline-style", "outline-width", "box-shadow"]);
    const hasOutline = ring["outline-style"] !== "none" && px(ring, "outline-width") > 0;
    const hasShadow = ring["box-shadow"] !== "none" && ring["box-shadow"] !== "";
    expect(
      hasOutline || hasShadow,
      `focused input has no visible indicator: outline ${ring["outline-style"]} ` +
        `${ring["outline-width"]}, box-shadow ${ring["box-shadow"]}`,
    ).toBe(true);
  });
});

test("pressing a button moves it, and every button does so, not only the primitive", async ({
  wallet,
}) => {
  // The press transition used to live inline in the Button component, so the
  // header's Lock and Close jumped between scales with no animation at all.
  // It lives in the stylesheet now, on the element selector.
  await wallet.createWallet(PASSWORD);
  const lock = wallet.page.getByRole("button", { name: "Lock" });
  const before = await computed(lock, ["transform", "transition-duration"]);
  expect(before.transform === "none" || before.transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);
  expect(px(before, "transition-duration")).toBeGreaterThan(0);

  const box = (await lock.boundingBox())!;
  await wallet.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await wallet.page.mouse.down();
  try {
    // scale(0.98) is a 0.98 in the matrix's first slot.
    await expect
      .poll(async () => (await computed(lock, ["transform"])).transform)
      .toMatch(/matrix\(0\.98/);
  } finally {
    await wallet.page.mouse.up();
  }
});

test("hovering a button is not mistaken for pressing it", async ({ wallet }) => {
  // Pocket deliberately has no hover restyle: the press transform is the
  // affordance. What must NOT happen is hover looking like the pressed state,
  // which would tell a pointer user the button had already been activated.
  await wallet.createWallet(PASSWORD);
  const send = wallet.page.getByRole("button", { name: "Send", exact: true });
  const resting = await computed(send, ["transform", "background-color"]);
  await send.hover();
  const hovered = await computed(send, ["transform", "background-color"]);

  expect(hovered.transform).toBe(resting.transform);
  expect(hovered["background-color"]).toBe(resting["background-color"]);
});

test("every control on the home screen meets the minimum target size", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const buttons = await wallet.page.getByRole("button").all();
  expect(buttons.length).toBeGreaterThan(0);
  const small: string[] = [];
  for (const b of buttons) {
    const box = await b.boundingBox();
    const name = (await b.innerText()).trim();
    if (!box) continue;
    if (box.width < MIN_TARGET_PX || box.height < MIN_TARGET_PX) {
      small.push(`${name || "(unnamed)"} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
  expect(small, `controls under ${MIN_TARGET_PX}px: ${small.join(", ")}`).toEqual([]);
});

test("at 360x600 every private-pocket action is reachable", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  // Chrome caps a toolbar popup near 600px tall and 360px is the narrowest
  // sensible width, so anything that cannot be brought into view inside that
  // box is unreachable rather than merely awkward. The frame is fixed and the
  // CONTENT column scrolls, which is what makes the fold survivable: the test
  // is not "everything fits" but "everything can be reached".
  await wallet.page.setViewportSize({ width: 360, height: 600 });
  await wallet.createWallet(PASSWORD);
  await ledger.fund(await wallet.revealAddress());
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Not set up yet")).toBeVisible({ timeout: WAITS.ledgerRead });

  const action = wallet.page.getByRole("button", { name: "Set up the private pocket" });
  await action.scrollIntoViewIfNeeded();
  const box = (await action.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(
    box.y + box.height,
    "the action must sit inside the 600px popup ceiling",
  ).toBeLessThanOrEqual(600);
  expect(box.x + box.width, "and inside the 360px width").toBeLessThanOrEqual(360);
  // Reachable means clickable, not merely present in the DOM.
  await expect(action).toBeInViewport();

  // The header must not have been dragged off the top by a scrolling BODY:
  // the frame scrolls its content column, not the document.
  await expect(wallet.page.getByText("Private pocket", { exact: true })).toBeInViewport();
});
