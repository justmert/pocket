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
//
// The palette is chosen by the POCKET now, not by `prefers-color-scheme`, so
// the dark cases are opened in the private pocket rather than emulated. And the
// primary fill is a gradient rather than a flat colour, which `background-color`
// reports as `rgba(0, 0, 0, 0)`: reading it would have quietly compared the
// page behind the button against itself and passed for any fill at all.
import { test, expect } from "../support/fixtures";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { computed, focused, measure, px, tabTo, AA, MIN_TARGET_PX } from "../support/a11y";
import { stubReadyPrivatePocket } from "../support/private-pocket";

const PASSWORD = "a-strong-test-password";
const POCKETS = ["public", "private"] as const;
type PocketName = (typeof POCKETS)[number];

/** The flat accent, which is what the focus ring is painted in. */
const ACCENT = { public: "rgb(254, 217, 36)", private: "rgb(184, 173, 232)" } as const;

/**
 * The focus ring, which is deliberately NOT the accent in the public pocket.
 *
 * Yellow on a near-white surface cannot reach the 3:1 WCAG 1.4.11 asks of a
 * non-text indicator, and every control here is built with `all: unset`, so the
 * ring is the only focus signal there is. The private pocket's lilac clears it
 * against its own dark surfaces and keeps it.
 */
const RING = { public: "rgb(20, 21, 26)", private: "rgb(184, 173, 232)" } as const;

/**
 * The two stops of each pocket's primary fill.
 *
 * A primary button is a gradient, so the thing to assert is the gradient. Both
 * stops, because a fill that kept one and lost the other is exactly the kind of
 * half-applied token change this file exists to catch.
 */
const FILL = {
  public: ["rgb(255, 228, 92)", "rgb(245, 196, 0)"],
  private: ["rgb(201, 191, 240)", "rgb(164, 147, 221)"],
} as const;

/** Fill as the compositor sees it: the flat colour AND the gradient. */
async function paint(target: import("@playwright/test").Locator) {
  const s = await computed(target, ["background-color", "background-image", "opacity", "cursor"]);
  return {
    color: s["background-color"] ?? "",
    image: s["background-image"] ?? "",
    opacity: s["opacity"] ?? "",
    cursor: s["cursor"] ?? "",
  };
}

/**
 * A wallet sitting in the given pocket, with a DISABLED primary button on
 * screen and the means to enable it.
 *
 * The public pocket's is the onboarding Create button, which is the one the
 * original regression was found on. The private pocket has no pre-wallet
 * screen, so its case is the send sheet's Review, disabled until there is
 * something to review -- the same primitive, the same disabled style, drawn on
 * the private surface.
 */
async function disabledPrimary(
  w: Wallet,
  pocket: PocketName,
): Promise<{ button: import("@playwright/test").Locator; enable: () => Promise<void> }> {
  if (pocket === "public") {
    await w.page.getByRole("button", { name: "Create a new wallet" }).click();
    return {
      button: w.page.getByRole("button", { name: "Create wallet" }),
      enable: async () => {
        await w.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
        await w.page.getByLabel("Confirm password").fill(PASSWORD);
      },
    };
  }
  // the private compose form only exists for a pocket that is open. before
  // D-002 this screen was reachable without one, which is the path that let a
  // user fill in a payment for an account that did not exist.
  await stubReadyPrivatePocket(w.page);
  await w.createWallet(PASSWORD);
  await w.page.reload();
  await w.waitForHome(WAITS.ledgerRead);
  await w.openPrivatePocket();
  await w.nav("Send privately").click();
  const sheet = w.page.getByRole("dialog", { name: "Send privately" });
  await expect(sheet).toBeVisible();
  return {
    button: sheet.getByRole("button", { name: "Review" }),
    enable: async () => {
      await sheet.getByLabel("To", { exact: true }).fill("GBHEDQ5XUXCWK5I32NVDSGAL6BIX2X7DUWQYC2MLXV27N44JLDQFGT73");
      await sheet.getByLabel("Amount (XLM)").fill("1");
    },
  };
}

test.describe("disabled", () => {
  for (const pocket of POCKETS) {
    test(`a disabled button in the ${pocket} pocket is its own style, not the enabled one faded`, async ({
      wallet,
    }) => {
      test.setTimeout(4 * 60_000);
      const { button, enable } = await disabledPrimary(wallet, pocket);

      await expect(button).toBeDisabled();
      const off = await paint(button);
      const measured = await measure(button);

      // Not the accent at reduced alpha. That is the specific regression: dark
      // ink on pale yellow at 45% fails contrast exactly when the user needs to
      // read why the button will not work.
      expect(off.image, "the disabled button is still wearing the accent fill").toBe("none");
      expect(off.opacity).toBe("1");
      expect(off.cursor).toBe("not-allowed");
      // And it still has to be READABLE.
      //
      // WCAG 1.4.3 exempts inactive components, so this is the PROJECT's bar,
      // not the standard's: the whole reason the disabled style was rewritten
      // was that a faded accent became unreadable at the exact moment the user
      // is working out what is missing. Raising this line to AA.text is the
      // check to run after any change to the `faint` token.
      expect(
        measured.ratio,
        `disabled label contrast in the ${pocket} pocket: ` +
          `${measured.color} on ${measured.background}`,
      ).toBeGreaterThanOrEqual(AA.nonText);

      // Enabling it must actually change the appearance, or "disabled" carries
      // no information.
      await enable();
      await expect(button).toBeEnabled();
      // Polled, because the fill arrives on a transition and reading it the
      // instant the button enables catches it mid-fade.
      for (const stop of FILL[pocket]) {
        await expect
          .poll(async () => (await paint(button)).image, { timeout: 5_000 })
          .toContain(stop);
      }
      expect((await paint(button)).color).not.toBe(off.color);
    });
  }
});

test.describe("focus", () => {
  for (const pocket of POCKETS) {
    test(`keyboard focus in the ${pocket} pocket is the product's ring rather than Chrome's blue`, async ({
      wallet,
    }) => {
      test.setTimeout(4 * 60_000);
      // Both cases are on the Button primitive, so this is a question about the
      // PALETTE and nothing else. Whether the ring reaches the icon buttons is
      // a separate question, asked separately below, because it has a separate
      // answer.
      let target: import("@playwright/test").Locator;
      if (pocket === "public") {
        await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
        await wallet.page.keyboard.press("Tab");
        target = wallet.page.getByRole("button", { name: "Create a new wallet" });
      } else {
        // as above: the compose form belongs to an open pocket.
        await stubReadyPrivatePocket(wallet.page);
        await wallet.createWallet(PASSWORD);
        await wallet.page.reload();
        await wallet.waitForHome(WAITS.ledgerRead);
        await wallet.openPrivatePocket();
        await wallet.nav("Send privately").click();
        const sheet = wallet.page.getByRole("dialog", { name: "Send privately" });
        await expect(sheet).toBeVisible();
        await sheet.getByLabel("To", { exact: true }).fill("G");
        await sheet.getByLabel("Amount (XLM)").fill("1");
        expect(await tabTo(wallet.page, "Review")).toBe(true);
        target = sheet.getByRole("button", { name: "Review" });
      }
      await expect(target).toBeFocused();

      const ring = await computed(target, ["outline-color", "outline-style", "outline-width"]);
      expect(ring["outline-style"]).toBe("solid");
      expect(px(ring, "outline-width")).toBeGreaterThanOrEqual(2);
      // The only blue in this product would be Chrome's default ring. The ring
      // colour is handed to CSS by `WalletProvider` precisely so the default is
      // never used, and it follows the pocket.
      expect(ring["outline-color"]).toBe(RING[pocket]);
    });
  }

  test("every control on the home screen shows a focus ring, not only the ones built from Button", async ({
    wallet,
  }) => {
    // `style.css` re-asserts the accent ring on `:focus-visible` for every
    // button, because most tappables here strip the native outline. A rule in a
    // stylesheet cannot beat an inline declaration, and every icon control in
    // this UI is built with `all: "unset"` in its inline style, which resets
    // `outline` to `none`. Tabbed rather than focused programmatically:
    // `:focus-visible` is exactly the thing under test.
    await wallet.createWallet(PASSWORD);
    await wallet.waitForHome(WAITS.ledgerRead);

    const ringless: string[] = [];
    for (let i = 0; i < 10; i++) {
      await wallet.page.keyboard.press("Tab");
      const who = await focused(wallet.page);
      if (who.tag === "BODY") break;
      const ring = await wallet.page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el) return null;
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: s.outlineWidth, shadow: s.boxShadow };
      });
      if (!ring) continue;
      const visible =
        (ring.style !== "none" && parseFloat(ring.width) > 0) ||
        (ring.shadow !== "none" && ring.shadow !== "");
      if (!visible) ringless.push(`${who.text || who.tag} (outline ${ring.style} ${ring.width})`);
    }

    expect(
      ringless,
      `controls a keyboard user cannot see the focus on:\n  ${ringless.join("\n  ")}`,
    ).toEqual([]);
  });

  /**
   * FAILING: `style.css` carries a rule giving inputs the accent ring on real
   * focus, and a comment explaining why they get it on `:focus` rather than
   * only `:focus-visible`: a caret alone is a weak signal for which field of a
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
    const recipient = wallet.page
      .getByRole("dialog", { name: "Send" })
      .getByLabel("To", { exact: true });
    await recipient.click();
    await expect(recipient).toBeFocused();

    const ring = await computed(recipient, ["outline-style", "outline-width", "outline-color"]);
    expect(ring["outline-style"]).toBe("solid");
    expect(px(ring, "outline-width")).toBeGreaterThanOrEqual(2);
    expect(ring["outline-color"]).toBe(RING.public);
  });

  test("keyboard focus on a text input is visible at all", async ({ wallet }) => {
    // The same defect stated as the accessibility requirement it breaks: WCAG
    // 2.1 SC 2.4.7 asks only that the focused control be distinguishable. This
    // asserts nothing about the colour.
    await wallet.createWallet(PASSWORD);
    await wallet.openSend();

    // The sheet autofocuses its first field, so the recipient input is already
    // where a keyboard user's next keystroke goes. Tabbing "until an INPUT" is
    // what the old version did and it landed on the SECOND field, which tested
    // the amount box and reported it as the recipient.
    const focusedInput = wallet.page
      .getByRole("dialog", { name: "Send" })
      .getByLabel("To", { exact: true });
    await expect(focusedInput).toBeFocused();
    expect((await focused(wallet.page)).tag).toBe("INPUT");

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
  // It lives in the stylesheet now, on the element selector -- which only holds
  // if nothing inline overrides it, and every icon button in this UI is built
  // with `all: unset`.
  await wallet.createWallet(PASSWORD);
  const lock = wallet.page.getByRole("button", { name: "Lock wallet" });
  const before = await computed(lock, ["transform", "transition-duration"]);
  expect(before.transform === "none" || before.transform === "matrix(1, 0, 0, 1, 0, 0)").toBe(true);

  // Both facts gathered before either is asserted, so the failure names the
  // whole defect rather than the first half of it.
  const box = (await lock.boundingBox())!;
  await wallet.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await wallet.page.mouse.down();
  let pressed = "";
  try {
    // scale(0.96) is a 0.96 in the matrix's first slot.
    await expect
      .poll(
        async () => {
          pressed = (await computed(lock, ["transform"])).transform ?? "";
          return pressed;
        },
        { timeout: 2_000 },
      )
      .toMatch(/matrix\(0\.96/);
  } catch {
    // The poll timing out IS the reading; `pressed` holds what it last saw.
  } finally {
    await wallet.page.mouse.up();
  }

  expect(
    px(before, "transition-duration"),
    `the icon button has no press transition, so it snaps between scales ` +
      `(transform under the press: ${pressed || "unread"})`,
  ).toBeGreaterThan(0);
  expect(pressed, "the icon button does not move under a press at all").toMatch(/matrix\(0\.96/);
});

test("hovering a button is not mistaken for pressing it", async ({ wallet }) => {
  // Pocket deliberately has no hover restyle: the press transform is the
  // affordance. What must NOT happen is hover looking like the pressed state,
  // which would tell a pointer user the button had already been activated.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  const send = wallet.nav("Send");
  const resting = await computed(send, ["transform", "background-image"]);
  await send.hover();
  const hovered = await computed(send, ["transform", "background-image"]);

  expect(hovered.transform).toBe(resting.transform);
  expect(hovered["background-image"]).toBe(resting["background-image"]);
});

test("every control on the private pocket's home screen meets the minimum target size", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  // The bar restyles per pocket and the private body is a different set of
  // controls from the public one, so the private pocket is swept on its own
  // rather than assumed to match.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();

  const buttons = await wallet.page.getByRole("button").all();
  expect(buttons.length).toBeGreaterThan(0);
  const small: string[] = [];
  for (const b of buttons) {
    const box = await b.boundingBox();
    if (!box) continue;
    const name = (await b.getAttribute("aria-label")) || (await b.innerText()).trim() || "(unnamed)";
    if (box.width < MIN_TARGET_PX || box.height < MIN_TARGET_PX) {
      small.push(`"${name}" ${Math.round(box.width)}x${Math.round(box.height)}`);
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
  await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // Set-up lives one sheet in, so reaching it means both the prompt's own
  // control and the sheet's fit inside the box.
  await wallet.openMove();
  const action = wallet.page
    .getByRole("dialog", { name: "Move" })
    .getByRole("button", { name: "Set up the private pocket" });
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

  // The sheet must not have pushed its own header off the top: a sheet whose
  // title has left the frame is one nobody can tell apart from the next.
  await expect(wallet.page.getByRole("dialog", { name: "Move" })).toBeInViewport();
});
