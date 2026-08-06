// Zoom, reduced motion, and target sizes.
//
// The reduced-motion case is a named regression target: the rule used to freeze
// the spinner at 0.001ms alongside everything else, which is precisely how a
// hung wallet looks. The reduced variant has to stay MEANINGFUL, not absent.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { computed, horizontalOverflow, px, MIN_TARGET_PX } from "../support/a11y";
import { hang, RPC_HOST } from "../support/stub";

const PASSWORD = "a-strong-test-password";

/**
 * Every button on screen that is smaller than the minimum target, named.
 *
 * Named by `aria-label` first: the bar, the header and every close control are
 * icon-only, so `innerText` is empty for exactly the controls most likely to be
 * too small, and a report of `(unnamed) 17x17` is one nobody can act on.
 */
async function undersizedControls(page: import("@playwright/test").Page): Promise<string[]> {
  const small: string[] = [];
  for (const b of await page.getByRole("button").all()) {
    const box = await b.boundingBox();
    if (!box) continue;
    if (box.width >= MIN_TARGET_PX && box.height >= MIN_TARGET_PX) continue;
    const name =
      (await b.getAttribute("aria-label")) || (await b.innerText()).trim() || "(unnamed)";
    small.push(`"${name}" ${Math.round(box.width)}x${Math.round(box.height)}`);
  }
  return small;
}

test.describe("reduced motion", () => {
  test("transitions stop but the spinner keeps turning, slower", async ({ harness, wallet }) => {
    await wallet.page.emulateMedia({ reducedMotion: "reduce" });
    await wallet.createWallet(PASSWORD);

    // Hold the ledger read open so there is a spinner to measure. The refresh
    // control spins for as long as the read is outstanding, which is the one
    // spinner reachable on the home screen.
    await hang(harness.context, RPC_HOST);
    await wallet.reopen();
    const spinner = wallet.page.locator(".pocket-spinner").first();
    await expect(spinner).toBeVisible({ timeout: WAITS.ledgerRead });

    const anim = await computed(spinner, ["animation-duration", "animation-name"]);
    // NOT 0.001ms. A frozen spinner is indistinguishable from a hung wallet,
    // and this is the only thing on screen telling the user it is still working.
    expect(anim["animation-name"]).toBe("pocket-spin");
    expect(px(anim, "animation-duration")).toBeGreaterThan(1);
    expect(px(anim, "animation-duration")).toBeLessThan(5);

    // Everything else really does stop.
    const button = await computed(wallet.page.getByRole("menuitem", { name: "Lock" }), [
      "transition-duration",
    ]);
    expect(px(button, "transition-duration")).toBeLessThan(0.01);
  });

  test("the spinner really does move under reduced motion", async ({ harness, wallet }) => {
    // Reading `animation-duration` proves the RULE is right. This proves the
    // pixels move, which is what the user is actually relying on.
    await wallet.page.emulateMedia({ reducedMotion: "reduce" });
    await wallet.createWallet(PASSWORD);
    await hang(harness.context, RPC_HOST);
    await wallet.reopen();
    const spinner = wallet.page.locator(".pocket-spinner").first();
    await expect(spinner).toBeVisible({ timeout: WAITS.ledgerRead });

    const angle = async () => (await computed(spinner, ["transform"])).transform;
    const first = await angle();
    await expect.poll(angle, { timeout: 5_000 }).not.toBe(first);
  });

  test("without the preference, motion is the normal speed", async ({ harness, wallet }) => {
    // The control case. Without it, a rule that disabled animation everywhere
    // would satisfy the test above by accident.
    await wallet.page.emulateMedia({ reducedMotion: "no-preference" });
    await wallet.createWallet(PASSWORD);
    await hang(harness.context, RPC_HOST);
    await wallet.reopen();
    const spinner = wallet.page.locator(".pocket-spinner").first();
    await expect(spinner).toBeVisible({ timeout: WAITS.ledgerRead });

    const anim = await computed(spinner, ["animation-duration"]);
    expect(px(anim, "animation-duration")).toBeCloseTo(0.7, 2);
    // 140ms, from the press transition `style.css` puts on the element
    // selector so that every button answers a press, not only the ones built
    // out of the Button primitive.
    const button = await computed(wallet.page.getByRole("menuitem", { name: "Lock" }), [
      "transition-duration",
    ]);
    expect(px(button, "transition-duration")).toBeCloseTo(0.14, 2);
  });
});

test.describe("zoom", () => {
  test("at 200% the wallet does not overflow sideways and every control is reachable", async ({
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    await wallet.createWallet(PASSWORD);
    await ledger.fund(await wallet.revealAddress());

    // 200% browser zoom halves the CSS pixels available. The frame is a fixed
    // 384x600, so this is the case where a fixed width either survives or
    // clips: the popup has `overflow: hidden`, meaning horizontal overflow is
    // not a scrollbar, it is content nobody can reach.
    await wallet.page.setViewportSize({ width: 192, height: 300 });
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // WCAG 1.4.4 asks for 200% without loss of content. The frame is
    // `overflow: hidden`, so what does not fit is not scrolled to, it is gone.
    const overflow = await horizontalOverflow(wallet.page);
    expect(
      overflow,
      `clipped at 200% zoom, and the frame hides overflow rather than scrolling it:\n  ` +
        overflow.join("\n  "),
    ).toEqual([]);

    // Vertically it is allowed to scroll, but every action must still be
    // reachable by scrolling the content column.
    for (const name of ["Send", "Receive"] as const) {
      const control = wallet.nav(name);
      await control.scrollIntoViewIfNeeded();
      await expect(control).toBeInViewport();
    }
  });

  test("at 200% the send form is still usable", async ({ wallet }) => {
    await wallet.createWallet(PASSWORD);
    await wallet.page.setViewportSize({ width: 192, height: 300 });
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openSend();

    // Scoped to the sheet: the home screen stays mounted behind it, and an
    // unscoped `getByLabel` would happily resolve against something underneath.
    const sheet = wallet.page.getByRole("dialog", { name: "Send" });
    for (const label of ["To", "Amount (XLM)", "Memo"]) {
      const field = sheet.getByLabel(label, { exact: true });
      await field.scrollIntoViewIfNeeded();
      await expect(field).toBeInViewport();
    }
    expect(await horizontalOverflow(wallet.page)).toEqual([]);
  });
});

test("every control on every reachable screen meets the minimum target size", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  const small = new Map<string, string>();
  const check = async (where: string) => {
    for (const control of await undersizedControls(wallet.page)) {
      // Keyed on the control, so a button that appears on four screens is one
      // finding rather than four lines of the same thing.
      if (!small.has(control)) small.set(control, `${where}: ${control}`);
    }
  };

  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await check("onboarding");
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await check("home");
  await wallet.nav("Settings").click();
  await expect(wallet.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await check("settings");
  await wallet.nav("Home").click();
  await wallet.openSend();
  await check("send sheet");
  await wallet.page.keyboard.press("Escape");
  await wallet.nav("Receive").click();
  await expect(wallet.page.getByRole("dialog", { name: "Receive" })).toBeVisible();
  await check("receive sheet");
  await wallet.page.keyboard.press("Escape");
  await wallet.nav("Home").click();
  await wallet.lock();
  await check("unlock");
  // Not `Wallet.openRecover`: it waits for a heading the recover screen does
  // not have, which is reported as its own finding in `semantics.spec.ts`.
  await wallet.page.getByRole("button", { name: "Forgot your password?" }).click();
  await expect(wallet.page.getByText("This erases the wallet on this device.")).toBeVisible();
  await check("recover");

  // WCAG 2.2 SC 2.5.8 asks for 24x24 CSS px. The icon-only controls are the
  // ones at risk: they carry no text to give them height.
  expect(
    [...small.values()],
    `controls under ${MIN_TARGET_PX}px:\n  ${[...small.values()].join("\n  ")}`,
  ).toEqual([]);
});
