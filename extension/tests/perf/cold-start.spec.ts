// Cold start.
//
// MV3 evicts the service worker whenever it likes, so COLD is the normal case.
// It is also a LOCK, because the session lives only in worker memory
// (`core/session.ts`): the returning user's cold start ends at the password
// field, not at the home screen, and a spec measuring "time to home" after an
// eviction would be measuring the wrong screen.
//
// Every bound below is a number a user would notice, not a number that merely
// happens to hold today. The measured values are in `_test/T9.md` next to the
// reason each bound sits where it does.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { intercept, restore, RPC_HOST } from "../support/stub";
import { installProbe, read, at } from "./probe";
import { killWorker } from "./mv3";

const PASSWORD = "a-strong-test-password";

/**
 * One second is Nielsen's limit for a user's flow of thought staying
 * uninterrupted, and it is the point past which a toolbar popup that has drawn
 * nothing reads as a click that did not register. Measured at 48-50ms on this
 * machine over three consecutive evictions, so this is roughly twenty times the
 * observed value: loose enough that a machine running ten test suites cannot
 * redden it, tight enough that it still fails the moment the popup takes a
 * perceptible time to draw anything at all.
 */
const PAINT_MS = 1_000;

/**
 * To a usable control on a cold worker. This includes the whole MV3 path: the
 * popup boots, sends `status`, and Chrome has to start a service worker from
 * nothing to answer it. Measured 107-117ms. Two seconds is where a wallet stops
 * feeling like a button and starts feeling like a website.
 */
const INTERACTIVE_MS = 2_000;

test("a popup opened on a dead service worker paints the wallet, and says it is starting", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await installProbe(wallet.page);
  await wallet.page.bringToFront();

  // A wallet with a vault, which is what a returning user has.
  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);

  // The eviction MV3 performs on its own schedule, forced.
  await killWorker(harness.context, wallet.page);
  await wallet.page.reload();
  await expect(wallet.lockedNotice()).toBeVisible({ timeout: WAITS.ledgerRead });

  const p = await read(wallet.page);
  console.log(`  cold shell ${at(p, "shell")?.toFixed(0)}ms, "Starting" ${at(p, "starting")?.toFixed(0)}ms`);

  // The first frame carrying the wallet's own name. Stamped inside the page on
  // the frame AFTER the DOM changed, so it is a painted frame rather than a
  // React commit.
  expect(
    at(p, "shell"),
    "the popup must draw something the user recognises as Pocket, not a blank frame",
  ).toBeLessThan(PAINT_MS);

  // And it must NAME the wait rather than showing an empty shell. This is the
  // one wait in the product a user hits every single time they open the wallet.
  expect(
    at(p, "starting") ?? Number.POSITIVE_INFINITY,
    "the boot frame must say it is starting while the worker wakes",
  ).toBeLessThan(PAINT_MS);
});

test("a cold service worker still reaches a usable password field within a bound", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await installProbe(wallet.page);
  await wallet.page.bringToFront();

  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);

  // Three consecutive evictions, because the interesting number is the one a
  // user gets EVERY time and not the best of three.
  for (let i = 0; i < 3; i++) {
    await killWorker(harness.context, wallet.page);
    await wallet.page.reload();
    await expect(wallet.lockedNotice()).toBeVisible({ timeout: WAITS.ledgerRead });

    const p = await read(wallet.page);
    console.log(`  cold start ${i + 1}: shell ${at(p, "shell")?.toFixed(0)}ms, password field ${at(p, "locked")?.toFixed(0)}ms`);
    expect(
      at(p, "locked"),
      `cold start ${i + 1} of 3: the password field must be on screen`,
    ).toBeLessThan(INTERACTIVE_MS);

    // Not just present: usable. A field that has painted but cannot take a
    // keystroke is not interactive, and the mark alone cannot tell them apart.
    const field = wallet.page.getByLabel("Password", { exact: true });
    await field.fill("x");
    await expect(field).toHaveValue("x");
    await field.fill("");
  }
});

test("a slow ledger does not hold up the screen it is going to land on", async ({
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

  // Deliberately SLOW, not broken. Asserting the ordering against a fast local
  // network would be true by construction: the balance can only render inside
  // the home screen, so "balance after home" cannot fail no matter what the
  // wallet does. Holding RPC for four seconds is what makes the assertion mean
  // something. It fails the moment the wallet awaits a chain read before
  // painting.
  const HELD_MS = 4_000;
  await intercept(harness.context, RPC_HOST, async (route) => {
    await new Promise((r) => setTimeout(r, HELD_MS));
    await route.continue();
  });

  await wallet.page.reload();
  await expect(wallet.page.getByRole("button", { name: "Public pocket" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  // Feedback while it waits, not a blank space and not a fabricated zero.
  await expect(wallet.page.getByText("Reading the ledger…")).toBeVisible();
  await expect(wallet.money()).toHaveCount(0);

  const early = await read(wallet.page);
  expect(
    at(early, "home"),
    "Send and Receive must be on screen while the ledger is still being read",
  ).toBeLessThan(INTERACTIVE_MS);

  await expect(wallet.money().first()).toBeVisible({ timeout: WAITS.ledgerRead });
  const p = await read(wallet.page);
  console.log(`  home ${at(p, "home")?.toFixed(0)}ms, balance ${at(p, "balance")?.toFixed(0)}ms, RPC held ${HELD_MS}ms`);
  expect(
    at(p, "balance") - at(p, "home"),
    "the balance must have landed on a screen that was already up",
  ).toBeGreaterThan(HELD_MS / 2);

  await restore(harness.context, RPC_HOST);
});
