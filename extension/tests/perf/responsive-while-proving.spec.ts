// Does the popup stay alive while a proof is running?
//
// This is the load-bearing claim of the whole architecture. Proving lives in an
// offscreen document for a platform reason (bb.js spawns a Worker and an MV3
// service worker cannot nest one), but the reason it is ACCEPTABLE for the user
// is that a proof therefore cannot block the UI. If the popup stalls anyway,
// the justification is not being realised and the user is looking at a frozen
// wallet holding their money.
//
// The offscreen document and the popup are same-origin extension pages, so
// Chrome is free to put them in the same renderer process; cross-origin
// isolation is on, so bb.js takes its multi-threaded path and those threads
// compete for the same cores. Neither of those is a reason to assume anything.
// It is measured.
//
// Two independent measurements, because they fail differently:
//   PAINT - the longest gap between animation frames. A blocked main thread
//           queues rAF callbacks and shows up here as a stall.
//   INPUT - a real click on a real control, timed to the screen it produces.
//           A page can keep painting a CSS animation off the compositor while
//           its main thread is wedged, so paint alone is not enough.
//
// RUN THIS SLICE AT --workers=1. Not for parallel-safety: every test here owns
// its own browser, profile and account. Proving is CPU-bound and
// multi-threaded, and T4 measured three concurrent proofs turning a 15-second
// register into four minutes. A frame-gap bound measured against that is a
// measurement of the test runner. A red here from a multi-worker run of the
// whole tree is contention, not a finding, and should be re-run alone before it
// is believed.
import { test, expect } from "../support/fixtures";
import { WAITS, openMoveAction } from "../support/wallet";
import * as ledger from "../support/testnet";
import { installProbe, read, now, framesBetween, longestFrameGap } from "./probe";

const PASSWORD = "a-strong-test-password";

/**
 * The longest the popup may stop painting.
 *
 * Measured worst gap during a real register proof: 91.6ms, once, out of 1,006
 * frames in 8.4 seconds. 500ms is roughly five times that, which keeps a loaded
 * machine from reddening it, and is still nowhere near what a failure looks
 * like: proving on the popup's own thread would stall it for the entire
 * multi-second proof, not for half a second.
 */
const MAX_PAINT_GAP_MS = 500;

/**
 * Click to the screen it opens, WHILE a proof is running.
 *
 * A second is the point at which a user presses again because they think the
 * first press was ignored, which on a wallet means a second transaction. The
 * same interaction on an idle popup is a single frame, so this has three orders
 * of magnitude of headroom over the healthy case and still fails outright if
 * the main thread is held by proving.
 */
const MAX_INPUT_MS = 1_000;

/**
 * The label the move sheet shows while it is working, as a gate for "the proof
 * has started".
 *
 * This spec waited on /Building/, which the sheet has not said for some time:
 * it now draws `Progress title="Preparing" subtitle="Checking this against the
 * ledger."` (sheets/MoveSheet.tsx). The gate is only a starting pistol for the
 * measurement below, so a stale one does not weaken what is measured, it stops
 * the measurement happening at all.
 *
 * `.first()` at the call sites: the title and the subtitle both match, and two
 * matches is a strict-mode violation rather than a pass.
 */
const WORKING = /Preparing|Checking this against the ledger/;

async function fundedPocket(wallet: import("../support/wallet").Wallet): Promise<void> {
  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);
  await wallet.page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Not open yet").first()).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
}

test("the popup keeps painting while a proof runs in the offscreen document", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  await installProbe(wallet.page);
  // Foreground, and it matters: Chrome throttles requestAnimationFrame in a
  // background tab to about 1Hz and stops it in a hidden one. A throttled
  // measurement is indistinguishable from a frozen popup and would be a false
  // HIGH finding.
  await wallet.page.bringToFront();
  await fundedPocket(wallet);

  const t0 = await now(wallet.page);
  await openMoveAction(wallet.page, "Set up the private pocket");
  // The wait must be on screen, or what follows is not measuring a proof.
  await expect(wallet.page.getByText(WORKING).first()).toBeVisible();
  await expect(wallet.page.getByRole("button", { name: "What this does" })).toBeVisible({
    timeout: WAITS.proving,
  });
  const t1 = await now(wallet.page);
  const p = await read(wallet.page);

  // The offscreen document is the whole point: assert it actually exists, so a
  // build that quietly proved somewhere else could not pass this test by being
  // fast.
  const offscreen = await wallet.page.evaluate(async () => {
    const c = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });
    return c.length;
  });
  expect(offscreen, "the proof must have run in an offscreen document").toBe(1);

  const during = framesBetween(p.frames, t0, t1);
  expect(t1 - t0, "this must be a real proof, not a cached answer").toBeGreaterThan(500);
  expect(during.length, "the popup must have painted during the proof").toBeGreaterThan(20);
  console.log(
    `  proof ${(t1 - t0).toFixed(0)}ms, ${during.length} frames painted in the popup, worst gap ${longestFrameGap(during).toFixed(1)}ms`,
  );
  expect(
    longestFrameGap(during),
    "the popup stopped painting while a proof ran: the offscreen document is not buying what it is supposed to buy",
  ).toBeLessThan(MAX_PAINT_GAP_MS);

  void harness;
});

test("the popup still obeys a click while a proof runs", async ({ wallet }) => {
  test.setTimeout(10 * 60_000);
  await installProbe(wallet.page);
  await wallet.page.bringToFront();
  await fundedPocket(wallet);

  await openMoveAction(wallet.page, "Set up the private pocket");
  await expect(wallet.page.getByText(WORKING).first()).toBeVisible();

  // Nothing is signed yet, so leaving is a real thing a bored user does, and it
  // is the only control the screen offers while it is busy. Timed from inside
  // the page so the number is the user's, not the test runner's.
  const t0 = await now(wallet.page);
  await wallet.page.getByRole("button", { name: "Close" }).click();
  await expect(wallet.page.getByRole("button", { name: "Public Pocket", exact: true })).toBeVisible({
    timeout: WAITS.proving,
  });
  const t1 = await now(wallet.page);

  console.log(`  click to the next screen, mid-proof: ${(t1 - t0).toFixed(1)}ms`);
  expect(t1 - t0, "the popup did not respond to a press while a proof was running").toBeLessThan(
    MAX_INPUT_MS,
  );
});
