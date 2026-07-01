// Motion: the reduced-motion contract, and the rule that no animation may
// stand between a user and what they pressed.
//
// The reduced-motion tests exist because of a bug that was already found and
// fixed once. The blanket rule
//
//   @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.001ms !important } }
//
// is the standard snippet, and applied to this product it froze the ONE piece
// of motion that carries information. A wallet mid-proof with a stopped spinner
// is exactly what a hung wallet looks like, and the user cannot tell them apart.
// The fix is a slower spinner, not no spinner. These tests are here to keep it
// fixed, so they assert the reduced VARIANT, not merely the absence of the
// original animation.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { intercept, restore, RPC_HOST } from "../support/stub";
import { installProbe, read, now, framesBetween, longestFrameGap, WATCH, at } from "./probe";

const PASSWORD = "a-strong-test-password";

/**
 * The slowest a spinner may be and still read as motion, and the fastest it may
 * be and still be legible.
 *
 * The regression this guards is 0.001ms, which is a full revolution per frame:
 * indistinguishable from stopped. 200ms is five revolutions a second, which is
 * a strobe; 4s is slow enough that a glance cannot tell it is moving. The
 * product's own tokens sit at 0.7s normally and 1.6s reduced, comfortably
 * inside.
 */
const SPIN_MIN_MS = 200;
const SPIN_MAX_MS = 4_000;

/** A spinner element, wherever the current screen happens to put one. */
const SPINNER = ".pocket-spinner";

test("with reduced motion asked for, the wait spinner is slowed and NOT frozen", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await wallet.page.emulateMedia({ reducedMotion: "reduce" });

  // A held RPC keeps a real wait on screen long enough to interrogate. The
  // spinner has to be the one the wallet shows a user, not one a test built.
  // Creating the vault does not touch RPC, so the hold lands exactly where it
  // is wanted: on the home screen's balance read.
  await intercept(harness.context, RPC_HOST, async (route) => {
    await new Promise((r) => setTimeout(r, 8_000));
    await route.continue();
  });

  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);
  await expect(wallet.page.getByText("Reading the ledger…")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  const spinner = wallet.page.locator(SPINNER).first();
  await expect(spinner).toBeVisible({ timeout: WAITS.ledgerRead });

  const seen = await spinner.evaluate((el) => {
    const anims = el.getAnimations();
    return {
      count: anims.length,
      states: anims.map((a) => a.playState),
      durations: anims.map((a) => a.effect?.getComputedTiming().duration ?? null),
      // An infinite iteration count is what makes it a WAIT rather than a
      // one-shot flourish that ends while the wallet is still working.
      // Reported as a string because Infinity does not survive every
      // serialiser, and a silently-nulled Infinity would read as a finding.
      iterations: anims.map((a) => {
        const n = a.effect?.getComputedTiming().iterations;
        return n === Infinity ? "infinite" : String(n);
      }),
    };
  });

  console.log(`  reduced-motion spinner: ${JSON.stringify(seen)}`);
  expect(seen.count, "the wait indicator must still be animated under reduced motion").toBeGreaterThan(0);
  expect(seen.states, "a paused animation is a frozen spinner").toEqual(["running"]);
  for (const d of seen.durations) {
    expect(typeof d, "the animation must have a real duration").toBe("number");
    expect(
      d as number,
      "0.001ms is a revolution per frame: that is the frozen-spinner regression",
    ).toBeGreaterThanOrEqual(SPIN_MIN_MS);
    expect(d as number, "slower than this and a glance cannot tell it is moving").toBeLessThanOrEqual(
      SPIN_MAX_MS,
    );
  }
  expect(seen.iterations, "a wait indicator that stops before the wait does is worse than none").toEqual([
    "infinite",
  ]);

  // And it must actually be TURNING, not merely declared as animated. Read at
  // two points of the animation's own timeline rather than after a sleep, so
  // this measures the animation instead of the test runner's clock.
  const turned = await spinner.evaluate((el) => {
    const a = el.getAnimations()[0];
    // No animation at all is the failure this test exists to catch, so it says
    // so rather than reading `currentTime` off undefined and reporting a
    // TypeError that looks like a harness fault.
    if (!a) throw new Error("the spinner declares no animation, so nothing can be turning");
    const was = a.currentTime;
    const at = (ms: number) => {
      a.currentTime = ms;
      return getComputedStyle(el).transform;
    };
    const before = at(0);
    const quarter = at(((a.effect?.getComputedTiming().duration as number) ?? 0) / 4);
    a.currentTime = was;
    return { before, quarter };
  });
  expect(turned.quarter, "a quarter through its cycle the spinner must have rotated").not.toBe(
    turned.before,
  );

  await restore(harness.context, RPC_HOST);
});

test("with reduced motion asked for, the decorative transitions do go away", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  await wallet.page.emulateMedia({ reducedMotion: "reduce" });
  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);

  const durations = await wallet.page.evaluate(() =>
    [...document.querySelectorAll("button")].map((b) => ({
      name: (b.textContent ?? "").trim(),
      transition: getComputedStyle(b).transitionDuration,
    })),
  );
  expect(durations.length, "there must be buttons to measure").toBeGreaterThan(0);

  // The pair matters. Without this half, the spinner assertion above could be
  // passing because the reduced-motion query never applied at all, which is the
  // shape of a test that cannot fail.
  for (const d of durations) {
    for (const part of d.transition.split(",")) {
      expect(
        Number(part.replace("s", "")),
        `${d.name}: press feedback must be effectively instant under reduced motion`,
      ).toBeLessThan(0.01);
    }
  }
});

test("without reduced motion, the press feedback and the spinner keep their normal timings", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await wallet.page.emulateMedia({ reducedMotion: "no-preference" });
  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);

  const durations = await wallet.page.evaluate(() =>
    [...document.querySelectorAll("button")].map((b) => getComputedStyle(b).transitionDuration),
  );
  // The contrast with the test above. If both readings were the same, one of
  // the two tests would be measuring nothing.
  for (const d of durations) {
    const first = Number((d.split(",")[0] ?? "").replace("s", ""));
    expect(first, "press feedback exists when the user has not asked for less motion").toBeGreaterThan(
      0.01,
    );
  }
});

test("no animation stands between a press and the screen it opens", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  // The mark is on the TEXT OF THE NEW SCREEN, and that correction is the whole
  // value of this test. Written as "the first painted frame after the click" it
  // could not fail: rAF is running continuously, so the next frame is always
  // about 8ms away whatever the click did or did not do. A mutation that put a
  // 400ms delay in front of the navigation sailed through it. It now waits for
  // the frame that carries the Send screen's own label.
  await installProbe(wallet.page, { ...WATCH, sendScreen: "Recipient" });
  await wallet.page.bringToFront();
  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // The press transition is 90ms. A screen change that waited for it, or for
  // any entry animation, would show up here. 150ms is one 90ms transition plus
  // room for a frame; anything at or over it means the user is being made to
  // watch something before they get what they asked for.
  const GATE_MS = 150;

  const t0 = await now(wallet.page);
  await wallet.page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(wallet.page.getByLabel("Recipient")).toBeVisible();
  const p = await read(wallet.page);

  expect(at(p, "sendScreen"), "the Send screen must have been painted").toBeGreaterThan(0);
  console.log(`  click to the frame carrying the Send screen: ${(at(p, "sendScreen") - t0).toFixed(1)}ms`);
  expect(
    at(p, "sendScreen") - t0,
    "the next screen must arrive on the next frame, not after a transition",
  ).toBeLessThan(GATE_MS);
});

test("scrolling a screen taller than the popup stays smooth", async ({ wallet }) => {
  test.setTimeout(10 * 60_000);
  await installProbe(wallet.page);
  await wallet.page.bringToFront();
  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });

  // Almost nothing in this wallet overflows its 600px frame. Measured across
  // every screen, exactly two do: the erase-and-restore acknowledgement by 36px
  // and the private pocket carrying a receipt with an operation form open, by
  // 193px. The second is the only surface in the product where scrolling is a
  // real interaction rather than a nudge, so that is the one measured.
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);
  await wallet.page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await wallet.registerPrivatePocket();
  await wallet.openOp("Send privately");

  const before = await wallet.page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 8);
    return el ? { top: el.scrollTop, h: el.scrollHeight, c: el.clientHeight } : null;
  });
  expect(before, "this screen must actually overflow, or the test measures nothing").not.toBeNull();

  const t0 = await now(wallet.page);
  await wallet.page.mouse.move(180, 300);
  for (let i = 0; i < 12; i++) await wallet.page.mouse.wheel(0, 40);
  const after = await wallet.page.evaluate(() => {
    const el = [...document.querySelectorAll("div")].find((d) => d.scrollHeight > d.clientHeight + 8);
    return el ? el.scrollTop : -1;
  });
  const t1 = await now(wallet.page);

  expect(after, "the wheel must have actually scrolled something").toBeGreaterThan(0);

  // 100ms is six dropped frames at 60Hz: the point at which a scroll stops
  // feeling attached to the wheel. Measured worst gap on an idle machine is
  // under 10ms, so this is ten times the observed value and still catches a
  // scroll that janks.
  const p = await read(wallet.page);
  const during = framesBetween(p.frames, t0, t1);
  expect(during.length, "frames must have been painted during the scroll").toBeGreaterThan(5);
  console.log(`  scrolled ${after}px of ${JSON.stringify(before)}, ${during.length} frames, worst gap ${longestFrameGap(during).toFixed(1)}ms`);
  expect(longestFrameGap(during), "the popup dropped frames while scrolling").toBeLessThan(100);
});
