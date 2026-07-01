// Every async surface, in all four of loading / empty / error / success.
//
// The states are produced at the NETWORK boundary, never by mocking wallet
// code: `hang` holds the RPC connection open so the loading state persists, and
// `offline` refuses it so the error state is a real refusal rather than a prop.
//
// The assertion that repeats on every surface is the one that matters: while
// loading, and while failing, there must be NO NUMBER on screen. A stale or
// invented balance is worse than an error, because the user cannot tell it is
// wrong.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { offline, hang, restore, RPC_HOST } from "../support/stub";

const PASSWORD = "a-strong-test-password";

test.describe("home balance", () => {
  test("loading: names the wait and shows no figure", async ({ harness, wallet }) => {
    await wallet.createWallet(PASSWORD);
    await hang(harness.context, RPC_HOST);
    await wallet.reopen();

    // A wait that says what it is waiting for, and stays that way: this is the
    // state a hung wallet and a slow one share, so the label is the only thing
    // distinguishing them.
    await expect(wallet.page.getByText("Reading the ledger…")).toBeVisible();
    await expect(wallet.page.locator(".pocket-spinner")).toBeVisible();
    await expect(wallet.money()).toHaveCount(0);
    await expect(wallet.page.getByText(/Something went wrong/)).toHaveCount(0);
  });

  test("empty: an account the ledger has never seen reads zero, and says nothing else", async ({
    wallet,
  }) => {
    // The one case where a zero is honest: the ledger genuinely has no such
    // account, which `balances()` distinguishes from every other failure.
    await wallet.createWallet(PASSWORD);
    await wallet.waitForHome(WAITS.ledgerRead);
    await expect(wallet.money().first()).toHaveText(/^0\.0000000\s*XLM$/);
    // No reserve line: an account that does not exist holds no reserve.
    await expect(wallet.page.getByText(/locked by the network as a reserve/)).toHaveCount(0);
  });

  test("success: the figure is the ledger's, with the reserve named", async ({ wallet }) => {
    await wallet.createWallet(PASSWORD);
    const funded = await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    expect(await wallet.publicBalance()).toBeCloseTo(funded - 1, 7);
    await expect(
      wallet.page.getByText("Plus 1.0000000 XLM locked by the network as a reserve."),
    ).toBeVisible();
    await expect(wallet.page.locator(".pocket-spinner")).toHaveCount(0);
  });

  test("error: refuses to show a figure, and recovers when the ledger comes back", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    await wallet.createWallet(PASSWORD);
    const funded = await ledger.fund(await wallet.revealAddress());

    await offline(harness.context, RPC_HOST);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await expect(wallet.page.getByText(/Something went wrong|check your connection/i)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    // The whole point. A funded account showing 0.0000000 because the network
    // hiccuped is the failure this state exists to prevent.
    await expect(wallet.money()).toHaveCount(0);
    await expect(wallet.page.locator(".pocket-spinner")).toHaveCount(0);

    // And it must come back on its own once the dependency does.
    await restore(harness.context, RPC_HOST);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    expect(await wallet.publicBalance()).toBeCloseTo(funded - 1, 7);
    await expect(wallet.page.getByText(/Something went wrong/)).toHaveCount(0);
  });
});

test.describe("private pocket", () => {
  test("loading: names the wait, invents no balance", async ({ harness, wallet }) => {
    await wallet.createWallet(PASSWORD);
    await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await hang(harness.context, RPC_HOST);
    await wallet.page
      .getByRole("button", { name: /private pocket/i })
      .first()
      .click();

    await expect(wallet.page.getByText("Reading the ledger…")).toBeVisible();
    await expect(wallet.money()).toHaveCount(0);
    await expect(wallet.page.getByText("SPENDABLE")).toHaveCount(0);
  });

  test("error: says so, and shows neither a balance nor a state it cannot verify", async ({
    harness,
    wallet,
  }) => {
    await wallet.createWallet(PASSWORD);
    await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await offline(harness.context, RPC_HOST);
    await wallet.page
      .getByRole("button", { name: /private pocket/i })
      .first()
      .click();

    await expect(wallet.page.getByText(/Something went wrong|check your connection/i)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(wallet.money()).toHaveCount(0);
    await expect(wallet.page.getByText("Not set up yet")).toHaveCount(0);
  });

  test("unfunded: a state, not a failure", async ({ wallet }) => {
    // A brand-new wallet has no account on chain. That is normal, and the
    // screen has to say what to do about it rather than showing an error.
    await wallet.createWallet(PASSWORD);
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPrivatePocket();

    await expect(wallet.page.getByText("Fund this account first")).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(wallet.page.getByText(/Receive some XLM first/)).toBeVisible();
    await expect(wallet.money()).toHaveCount(0);
  });

  test("unregistered: offers set-up, states the permanent facts, invents no balance", async ({
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    await wallet.createWallet(PASSWORD);
    await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPrivatePocket();

    await expect(wallet.page.getByText("Not set up yet")).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(
      wallet.page.getByRole("button", { name: "Set up the private pocket" }),
    ).toBeVisible();
    await expect(wallet.money()).toHaveCount(0);
  });
});

test.describe("send", () => {
  test("loading: the recipient check names itself and hides the button it replaces", async ({
    harness,
    wallet,
  }) => {
    await wallet.createWallet(PASSWORD);
    await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openSend();

    await hang(harness.context, RPC_HOST);
    await wallet.composePayment({
      to: "GBHEDQ5XUXCWK5I32NVDSGAL6BIX2X7DUWQYC2MLXV27N44JLDQFGT73",
      amount: "1",
    });

    await expect(wallet.page.getByText("Checking the recipient…")).toBeVisible();
    // Review is replaced by the spinner rather than sitting there clickable, so
    // a second press cannot build a second envelope.
    await expect(wallet.page.getByRole("button", { name: "Review" })).toHaveCount(0);
  });

  test("error: a refusal the user can act on, and the form is still there", async ({ wallet }) => {
    await wallet.createWallet(PASSWORD);
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openSend();
    await wallet.composePayment({ to: "not-an-address", amount: "1" });

    await expect(wallet.page.getByText(/does not look like a Stellar address/i)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    // Still on compose, with what was typed intact: an error that clears the
    // form makes the user retype an address they were told was wrong.
    await expect(wallet.page.getByLabel("Recipient")).toHaveValue("not-an-address");
    await expect(wallet.page.getByRole("button", { name: "Review" })).toBeVisible();
  });

  test("success: the confirm screen states everything about to be signed", async ({ wallet }) => {
    test.setTimeout(4 * 60_000);
    await wallet.createWallet(PASSWORD);
    await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openSend();
    await wallet.composePayment({
      to: "GBHEDQ5XUXCWK5I32NVDSGAL6BIX2X7DUWQYC2MLXV27N44JLDQFGT73",
      amount: "1.5",
      memo: "state-check",
    });

    await expect(wallet.page.getByText("Sending to")).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money().first()).toHaveText(/^1\.5000000\s*XLM$/);
    await expect(wallet.page.getByText("state-check", { exact: true })).toBeVisible();
    await expect(wallet.page.getByRole("button", { name: "Confirm and send" })).toBeEnabled();
  });
});

test.describe("yield", () => {
  // A new async surface, added in `a81bdc3` while this pass was running, and
  // found by the home-screen snapshots rather than by anyone mentioning it.
  //
  // Only the unavailable branch is reachable here: `VITE_DEFINDEX_API_KEY` and
  // `VITE_DEFINDEX_VAULT` are unset in a normal build, so `yieldPosition`
  // answers without touching the network. That means there is no loading state
  // to drive and no success state to assert. Both are NOT TESTABLE in this
  // build and are marked so in `_test/T6-T7.md` rather than faked.

  test("says it is not configured, rather than that it could not be read", async ({ wallet }) => {
    test.setTimeout(4 * 60_000);
    await wallet.createWallet(PASSWORD);
    await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await expect(wallet.page.getByText("YIELD", { exact: true })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });

    // The distinction the whole codebase cares about: "there is nothing here"
    // is permanent and benign, "it could not be read" is transient and asks the
    // user to retry. Collapsing them is the same class of defect as a
    // fabricated balance, so the specific sentence is asserted rather than
    // either-or.
    await expect(
      wallet.page.getByText(
        "Yield is not configured for this network. Nothing is at risk; there is simply no vault to deposit into.",
      ),
    ).toBeVisible();
    await expect(wallet.page.getByText(/could not be read/)).toHaveCount(0);

    // And an unavailable yield puts no number on screen. A zero here would be
    // a claim about money.
    await expect(wallet.page.getByText(/\d+(\.\d+)?\s*shares/)).toHaveCount(0);
  });
});
