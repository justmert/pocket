// Does the network stub actually reach the wallet's traffic?
//
// This tests the HARNESS, not the wallet, and it belongs in the suite rather
// than in a one-off script for one reason: every chain call in this extension
// happens in the service worker, not on the popup page. A stub scoped to the
// page would see none of it. Every failure-injection test in T3's slice would
// then keep passing while injecting nothing, and the suite would report a
// wallet that degrades honestly without ever having made it degrade. That is
// the worst outcome available to this pass, so it gets a spec.
//
// Two separate things are asserted, because either one alone is satisfiable
// without the other:
//
//   1. OBSERVED  -- the route handler saw a request AND `request.serviceWorker()`
//                   was non-null for it, so the interception reached the worker
//                   rather than only the page.
//   2. EFFECTIVE -- an injected failure changes what the wallet does. A stub
//                   that is seen but cannot alter behaviour is decoration.
//
// MEASURED, not assumed: PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS turns
// out NOT to be load-bearing on Playwright 1.62. Running this spec with the
// variable explicitly set to 0 still intercepted worker traffic and still
// passed. The config sets it anyway as cheap insurance for other versions, but
// nothing here asserts on the flag, because an assertion about a variable that
// does not change the outcome is a test that cannot tell you anything.
import { test, expect } from "./fixtures";
import { WAITS } from "./wallet";
import * as ledger from "./testnet";
import { offline, watch, RPC_HOST } from "./stub";

const PASSWORD = "a-strong-test-password";

test("a network stub sees traffic from the SERVICE WORKER, not just from the page", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(4 * 60_000);

  const rpc = await watch(harness.context, RPC_HOST);

  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);

  // Reopening makes the popup mount and ask the worker for balances, and the
  // worker reads them over RPC. Nothing on the page fetches RPC itself, so
  // every hit below came from the worker.
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.publicBalance();

  expect(rpc.total, "the route handler must have seen the wallet's RPC calls").toBeGreaterThan(0);
  // The assertion that matters, and the one that catches a stub scoped to the
  // page instead of the context. `request.serviceWorker()` is non-null only for
  // a request a service worker made, so page traffic to the same host cannot
  // satisfy it.
  expect(
    rpc.fromServiceWorker,
    `saw ${rpc.total} RPC requests but none from a service worker, so the stub does not reach ` +
      "where this wallet does its networking and every failure-injection test is vacuous",
  ).toBeGreaterThan(0);
});

test("an injected failure actually changes what the wallet shows", async ({ harness, wallet }) => {
  test.setTimeout(4 * 60_000);

  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  const funded = await ledger.fund(address);

  // Prove the balance is readable first, so the refusal below cannot be
  // mistaken for an account that was never funded.
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  expect(await wallet.publicBalance()).toBeCloseTo(funded - 1, 7);

  await offline(harness.context, RPC_HOST);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  // Degrading honestly: an error the user can act on, and NO number. A stale or
  // invented balance here would be worse than the error, which is the property
  // T3's whole slice exists to check and which this proves is reachable.
  await expect(wallet.page.getByText(/Something went wrong|check your connection/i)).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await expect(wallet.money()).toHaveCount(0);
});
