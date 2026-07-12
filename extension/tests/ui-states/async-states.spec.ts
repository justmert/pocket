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
//
// The rebuild changed how "loading" LOOKS but not what it must promise. There
// is no "Reading the ledger" sentence any more; a value that has not arrived
// is a shimmer, with the same fact spelled out for a screen reader beside it.
// A shimmer is still not a number, which is the whole point.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { offline, hang, restore, RPC_HOST } from "../support/stub";

const PASSWORD = "a-strong-test-password";

test.describe("home balance", () => {
  test("loading: stands a shimmer in for the figure, and shows no figure", async ({
    harness,
    wallet,
  }) => {
    await wallet.createWallet(PASSWORD);
    await hang(harness.context, RPC_HOST);
    await wallet.reopen();

    // A wait that stays a wait: this is the state a hung wallet and a slow one
    // share, so what is on screen is the only thing distinguishing them from a
    // wallet that has answered.
    await expect(wallet.page.locator(".pocket-skeleton").first()).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    // And the same fact, in the accessibility tree, for the reader who gets
    // nothing at all out of a shimmer.
    await expect(wallet.page.getByText("Reading the ledger", { exact: true })).toBeVisible();
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
    await expect(wallet.page.getByText(/by the network as a reserve/)).toHaveCount(0);
  });

  test("success: the figure is the ledger's, with the reserve named", async ({ wallet }) => {
    await wallet.createWallet(PASSWORD);
    const funded = await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    expect(await wallet.publicBalance()).toBeCloseTo(funded - 1, 7);
    // "locked", not "held". The migration map says this line was reworded to
    // "held by the network as a reserve" and `Home.tsx:59` says "locked", so the
    // code wins: it is also the word the worker's own effect line uses for the
    // same reserve, and the two saying different things about one number is the
    // thing worth avoiding.
    await expect(
      wallet.page.getByText("Plus 1.0000000 XLM locked by the network as a reserve."),
    ).toBeVisible();
    await expect(wallet.page.locator(".pocket-skeleton")).toHaveCount(0);
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

    // And it must come back on its own once the dependency does.
    await restore(harness.context, RPC_HOST);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    expect(await wallet.publicBalance()).toBeCloseTo(funded - 1, 7);
    await expect(wallet.page.getByText(/Something went wrong/)).toHaveCount(0);
  });
});

test.describe("private pocket", () => {
  test("loading: invents no balance and claims no state", async ({ harness, wallet }) => {
    await wallet.createWallet(PASSWORD);
    await ledger.fund(await wallet.revealAddress());
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await hang(harness.context, RPC_HOST);
    await wallet.openPrivatePocket();

    await expect(wallet.page.locator(".pocket-skeleton").first()).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(wallet.money()).toHaveCount(0);
    // The hero carries no label at all now, so the check is that no state has
    // been claimed either: an unread pocket must not be described as set up,
    // dormant, or anything else.
    for (const claim of ["Private pocket not set up", "Private pocket is dormant", "Receiving"]) {
      await expect(wallet.page.getByText(claim, { exact: true })).toHaveCount(0);
    }
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
    await wallet.openPrivatePocket();

    await expect(wallet.page.getByText(/Something went wrong|check your connection/i)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(wallet.money()).toHaveCount(0);
    await expect(wallet.page.getByText("Private pocket not set up")).toHaveCount(0);
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
    // Nothing to press. An unfunded pocket has no action that would work.
    await expect(wallet.page.getByRole("alert")).toHaveCount(0);
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

    await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(wallet.money()).toHaveCount(0);

    // Set-up itself lives in the Move sheet, and the permanent facts are stated
    // there, at the point of no return rather than a screen earlier.
    await wallet.openMove();
    const move = wallet.page.getByRole("dialog", { name: "Move" });
    await expect(move.getByRole("button", { name: "Set up the private pocket" })).toBeVisible();
    await expect(move.getByText(/It is bound permanently/)).toBeVisible();
    await expect(move.getByText(/Setting up is public/)).toBeVisible();
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

    const sheet = wallet.page.getByRole("dialog", { name: "Send" });
    await expect(sheet.getByText("Checking")).toBeVisible();
    // Review is replaced by the spinner rather than sitting there clickable, so
    // a second press cannot build a second envelope.
    await expect(sheet.getByRole("button", { name: "Review", exact: true })).toHaveCount(0);
  });

  test("error: a refusal the user can act on, and the form is still there", async ({ wallet }) => {
    await wallet.createWallet(PASSWORD);
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openSend();
    await wallet.composePayment({ to: "not-an-address", amount: "1" });

    const sheet = wallet.page.getByRole("dialog", { name: "Send" });
    await expect(sheet.getByText(/does not look like a Stellar address/i)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    // Still on compose, with what was typed intact: an error that clears the
    // form makes the user retype an address they were told was wrong.
    await expect(sheet.getByLabel("To", { exact: true })).toHaveValue("not-an-address");
    await expect(sheet.getByRole("button", { name: "Review" })).toBeVisible();
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

    // Scoped to the sheet throughout. The funded home screen is still mounted
    // behind it and carries a balance of its own, so an unscoped `money()`
    // would read the hero and pass while the review said anything at all.
    const sheet = wallet.page.getByRole("dialog", { name: "Send" });
    await expect(sheet.getByText("Sending", { exact: true })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(sheet.getByText("To", { exact: true })).toBeVisible();
    await expect(sheet.getByText(/^1\.5000000\s*XLM$/)).toBeVisible();
    await expect(sheet.getByText("state-check", { exact: true })).toBeVisible();
    await expect(
      sheet.getByText("GBHEDQ5XUXCWK5I32NVDSGAL6BIX2X7DUWQYC2MLXV27N44JLDQFGT73"),
    ).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Confirm" })).toBeEnabled();
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

    // Sentence case in the DOM; the caps are `text-transform` on the overline,
    // so a `String.includes("YIELD")` would be looking at the paint rather than
    // the markup.
    await expect(wallet.page.getByText("Yield", { exact: true })).toBeVisible({
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
