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

test.describe("reduced motion", () => {
  test("transitions stop but the spinner keeps turning, slower", async ({ harness, wallet }) => {
    await wallet.page.emulateMedia({ reducedMotion: "reduce" });
    await wallet.createWallet(PASSWORD);

    // Hold the ledger read open so there is a spinner to measure.
    await hang(harness.context, RPC_HOST);
    await wallet.reopen();
    const spinner = wallet.page.locator(".pocket-spinner");
    await expect(spinner).toBeVisible();

    const anim = await computed(spinner, ["animation-duration", "animation-name"]);
    // NOT 0.001ms. A frozen spinner is indistinguishable from a hung wallet,
    // and this is the only thing on screen telling the user it is still working.
    expect(anim["animation-name"]).toBe("pocket-spin");
    expect(px(anim, "animation-duration")).toBeGreaterThan(1);
    expect(px(anim, "animation-duration")).toBeLessThan(5);

    // Everything else really does stop.
    const button = await computed(wallet.page.getByRole("button", { name: "Lock" }), [
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
    const spinner = wallet.page.locator(".pocket-spinner");
    await expect(spinner).toBeVisible();

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
    const spinner = wallet.page.locator(".pocket-spinner");
    await expect(spinner).toBeVisible();

    const anim = await computed(spinner, ["animation-duration"]);
    expect(px(anim, "animation-duration")).toBeCloseTo(0.7, 2);
    const button = await computed(wallet.page.getByRole("button", { name: "Lock" }), [
      "transition-duration",
    ]);
    expect(px(button, "transition-duration")).toBeCloseTo(0.09, 2);
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

    // FAILING: finding 5 in `_test/T6-T7.md`. WCAG 1.4.4 asks for 200% without
    // loss of content. The frame is `overflow: hidden`, so what does not fit is
    // not scrolled to, it is gone.
    const overflow = await horizontalOverflow(wallet.page);
    expect(
      overflow,
      `clipped at 200% zoom, and the frame hides overflow rather than scrolling it:\n  ` +
        overflow.join("\n  "),
    ).toEqual([]);

    // Vertically it is allowed to scroll, but every action must still be
    // reachable by scrolling the content column.
    for (const name of ["Send", "Receive"]) {
      const control = wallet.page.getByRole("button", { name, exact: true });
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

    for (const label of ["Recipient", "Amount (XLM)", "Memo (optional)"]) {
      const field = wallet.page.getByLabel(label);
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
  const small: string[] = [];
  const check = async (where: string) => {
    for (const b of await wallet.page.getByRole("button").all()) {
      const box = await b.boundingBox();
      if (!box) continue;
      if (box.width < MIN_TARGET_PX || box.height < MIN_TARGET_PX) {
        const name = (await b.innerText()).trim() || "(unnamed)";
        small.push(`${where}: "${name}" ${Math.round(box.width)}x${Math.round(box.height)}`);
      }
    }
  };

  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await check("onboarding");
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await check("home");
  await wallet.openSend();
  await check("send");
  await wallet.page.getByRole("button", { name: "Close" }).click();
  await wallet.lock();
  await check("unlock");
  await wallet.openRecover();
  await check("recover");

  // WCAG 2.2 SC 2.5.8 asks for 24x24 CSS px. The header's text buttons are the
  // ones at risk: they are 12px captions with a 6px pad.
  expect(small, `controls under ${MIN_TARGET_PX}px:\n  ${small.join("\n  ")}`).toEqual([]);
});
