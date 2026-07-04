// Layout shift on data arrival.
//
// The home screen draws a named wait, then a balance. If the balance landing
// moves the buttons, a finger already on its way to Send arrives somewhere
// else. That is the whole risk, and it is a geometric question about ONE
// control, not an aggregate score.
//
// CLS is measured here too, and deliberately NOT used as the assertion. On a
// 360x600 popup the impact fraction is small enough that a shift moving the
// primary action by most of its own height still scores "good" by web
// standards. Grading this product by a number tuned for article pages would be
// the same mistake T1 named: an expected value produced by the same system that
// produces the actual one.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { intercept, restore, RPC_HOST } from "../support/stub";
import { installProbe, read, moved, trackOf, at } from "./probe";

const PASSWORD = "a-strong-test-password";

/**
 * How far the primary action may move while the user is looking at it.
 *
 * Four pixels is under the tolerance of a pointer already in flight and well
 * under any tap target. It is not an arbitrary tightening: the correct value is
 * zero, and four is the allowance for sub-pixel rounding in a rounded rect.
 */
const MAX_DRIFT_PX = 4;

test("the balance arriving does not move the Send button under the user's finger", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await installProbe(wallet.page);
  await wallet.page.bringToFront();

  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);

  // Held open, so the loading state is a state a person actually inhabits
  // rather than a frame that flickers past. This is what makes the misclick
  // real: at 237ms nobody has aimed yet, at four seconds everybody has.
  const HELD_MS = 4_000;
  await intercept(harness.context, RPC_HOST, async (route) => {
    await new Promise((r) => setTimeout(r, HELD_MS));
    await route.continue();
  });

  await wallet.page.reload();
  await expect(wallet.page.getByRole("button", { name: "Send", exact: true })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await expect(wallet.page.getByText("Reading the ledger")).toBeVisible();

  await expect(wallet.money().first()).toBeVisible({ timeout: WAITS.ledgerRead });
  const p = await read(wallet.page);
  await restore(harness.context, RPC_HOST);

  // From zero, not from `marks.home`. A mark is stamped on the frame AFTER the
  // DOM changed, and the position is recorded ON that DOM change, so a window
  // starting at the mark excludes the very reading it needs: the button's
  // position before the balance landed. Written that way first, this test
  // passed while the button was moving 29 pixels.
  const from = 0;
  const to = at(p, "balance") + 500;
  const tops = trackOf(p.positions, "Send", from, to);
  const readings = p.positions.filter((q) => q.name === "Send" && q.t <= to).length;

  // Not vacuous: the button has to have been measured on both sides of the
  // arrival, or "it did not move" would just mean "it was never seen".
  expect(readings, "the Send button must have been measured more than once").toBeGreaterThan(1);
  expect(
    at(p, "balance") - at(p, "home"),
    "the balance must have arrived after the buttons were already on screen",
  ).toBeGreaterThan(HELD_MS / 2);

  console.log(`  Send button top(s) while the balance arrived: ${tops.join(", ")}px`);
  expect(
    moved(p.positions, "Send", from, to),
    `the Send button moved between ${tops.join("px and ")}px while the balance arrived`,
  ).toBeLessThanOrEqual(MAX_DRIFT_PX);
});

test("no data arrival moves a control the user can press", async ({ harness, wallet }) => {
  test.setTimeout(4 * 60_000);
  await installProbe(wallet.page);
  await wallet.page.bringToFront();

  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);

  const HELD_MS = 3_000;
  await intercept(harness.context, RPC_HOST, async (route) => {
    await new Promise((r) => setTimeout(r, HELD_MS));
    await route.continue();
  });

  await wallet.page.reload();
  await expect(wallet.money().first()).toBeVisible({ timeout: WAITS.ledgerRead });
  const p = await read(wallet.page);
  await restore(harness.context, RPC_HOST);

  // The browser has to have been able to report shifts at all, or "no shift
  // moved a button" is a sentence about a missing API.
  expect(p.noLayoutShiftApi ?? false, "this browser must report layout-shift entries").toBe(false);

  const movedButtons = p.shifts
    .flatMap((s) => s.sources)
    .filter((s) => /^(Send|Receive|SendReceive|Set up the private pocket)/.test(s.text));

  const cls = p.shifts.reduce((t, s) => t + s.value, 0);
  console.log(`  CLS ${cls.toFixed(4)} over ${p.shifts.length} shift(s); moved controls: ${JSON.stringify(movedButtons)}`);
  expect(
    movedButtons,
    "an unprompted layout shift moved a control the user can press",
  ).toEqual([]);
});
