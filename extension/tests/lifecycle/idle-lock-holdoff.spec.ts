// A9-01 / A1-03 / A7-04, converged by three lanes: a screen may not disable a
// security control the product claims.
//
// The move sheet polls while the private pocket is catching up, and the poll is
// built from `balances` and `privatePocket`, which are members of the idle-lock
// activity set. Held in a local, the countdown reset on every tick because the
// effect was re-created whenever the provider re-rendered and the provider
// re-renders on every refresh. The bound was never reached, the alarm was
// re-armed forever, and a popup left open on that sheet meant a wallet that
// never locked itself again.
//
// This asserts the bound in the only way that is not a reimplementation of the
// code: count the calls the popup actually makes over a window longer than the
// bound, and require them to stop.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

/** Fifteen polls at two seconds is thirty; anything past that is unbounded. */
const BOUND = 15;

test("the move sheet stops polling, so the idle lock is never held open", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // Counted at the worker, which is the only place that sees every message and
  // the only place the lock alarm is armed from.
  const worker = await harness.worker();
  await worker.evaluate(() => {
    const w = self as unknown as { __polls?: number };
    w.__polls = 0;
    const original = chrome.runtime.onMessage;
    void original;
  });

  // The popup is what sends them, so they are counted there: every call goes
  // through one function.
  await wallet.page.evaluate(() => {
    const w = window as unknown as { __polls?: Record<string, number> };
    w.__polls = {};
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = (msg: { type?: string }, ...rest: unknown[]) => {
      const type = msg?.type ?? "unknown";
      w.__polls![type] = (w.__polls![type] ?? 0) + 1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (send as any)(msg, ...rest);
    };
  });

  // The pocket is not ready on a brand new wallet, which is exactly the state
  // the poll exists for.
  await wallet.openMove();

  // Well past the bound: fifteen polls at two seconds is thirty, so fifty
  // seconds must show the counter flat rather than still climbing.
  await wallet.page.waitForTimeout(35_000);
  const atThirtyFive = await wallet.page.evaluate(
    () => (window as unknown as { __polls: Record<string, number> }).__polls.privatePocket ?? 0,
  );
  await wallet.page.waitForTimeout(15_000);
  const atFifty = await wallet.page.evaluate(
    () => (window as unknown as { __polls: Record<string, number> }).__polls.privatePocket ?? 0,
  );

  expect(
    atThirtyFive,
    "the sheet must poll at all while the pocket is catching up, or the bound is measuring nothing",
  ).toBeGreaterThan(0);
  expect(
    atThirtyFive,
    `the poll must stop at ${BOUND}, and it had made ${atThirtyFive} by thirty-five seconds`,
  ).toBeLessThanOrEqual(BOUND + 2);
  expect(
    atFifty - atThirtyFive,
    `the poll kept going: ${atFifty - atThirtyFive} more calls in the fifteen seconds after the bound, which is the wallet's idle lock being held open`,
  ).toBe(0);
});
