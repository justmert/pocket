// The yield surface, in whichever configuration the artifact under test was
// built with.
//
// `_test/T6-T7.md` records the success branch as NOT TESTABLE, because
// `VITE_DEFINDEX_API_KEY` and `VITE_DEFINDEX_VAULT` are unset in a normal build
// and `yieldPosition` then answers without touching the network. That was true
// and it left the only branch a user with a position would ever see unexercised
// by anything: the shares figure came back from a field the API does not send
// (`shares`; the live endpoint answers `dfTokens`), so the row would have
// rendered an APY with nothing beside it. A unit test now covers the mapping;
// this covers the whole path, worker to screen.
//
// So the test asks the wallet which configuration it is in rather than guessing
// from the bundle, and then holds it to the right promise:
//
//   not configured  the sentence must say the vault is missing, not that the
//                   position could not be read. "Nothing is at risk" is the
//                   part the user needs.
//   configured      a real APY and a real share count, both from the live API,
//                   both on the screen.
//
// Neither branch is skipped, so this file is meaningful in the shipped build
// and in a build made with a vault, and it fails if either one starts lying.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import type { YieldPosition } from "../../src/core/messages";

const PASSWORD = "a-strong-test-password";

test("the yield row states the configuration it is actually in", async ({ wallet }) => {
  test.setTimeout(5 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const res = await page.evaluate(
    () =>
      new Promise<{ ok: boolean; data?: YieldPosition; error?: string }>((r) => {
        chrome.runtime.sendMessage({ type: "yieldPosition" }, r);
      }),
  );
  expect(res.ok, `the worker refused to answer about yield: ${res.error ?? ""}`).toBe(true);
  const y = res.data!;

  // Which configuration this run actually held the wallet to. A test that
  // adapts to the artifact has to say which half of itself ran, or a green tick
  // means nothing.
  console.log(
    y.available
      ? `yield configured: vault ${y.vault}, apy "${y.apy}", shares ${y.balance}`
      : "yield not configured in this artifact",
  );

  // The overline is sentence case in the DOM; the capitals are a
  // `text-transform`, so matching "YIELD" would be matching the paint.
  await expect(page.getByText("Yield", { exact: true })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  if (!y.available) {
    // The distinction this sentence has to carry: there is no vault, which is a
    // fact about the build, not about the user's money.
    expect(y.reason ?? "", "an absent vault must not be reported as a failed read").toMatch(
      /not available on this network/i,
    );
    await expect(page.getByText(/Not available on this network/)).toBeVisible();
    await expect(
      page.getByText(/shares/),
      "a build with no vault must not show a position",
    ).toHaveCount(0);
    return;
  }

  // Configured. Everything below came off the live API a moment ago.
  expect(y.vault, "an available position must name the vault it is in").toMatch(/^C[A-Z2-7]{55}$/);
  // describeApy's exact sentence. The window is labelled because the API
  // reports different windows on different endpoints.
  //
  // `apy` is a PAIR now: a bare `figure` for a table cell and the full `sentence`
  // for a tip. It used to be one string, and every caller regexed the figure back
  // out of it and dropped the window, which is the definition of the number.
  expect(y.apy?.sentence ?? "", "the APY must be reported with its window and its warning").toMatch(
    /^\d+\.\d{2}% over the last 7 days, variable and not guaranteed$|^Yield not reported$/,
  );
  // and the figure has to agree with the sentence it was split from.
  if (y.apy?.figure) {
    expect(y.apy.figure).toMatch(/^\d+\.\d{2}%$/);
    expect(y.apy.sentence.startsWith(y.apy.figure), "the pair must not disagree").toBe(true);
  }
  // The share count, which is what the mapping bug erased. A digit string, not
  // undefined and not an XLM amount.
  expect(y.balance, "the position came back with no share count").toBeDefined();
  expect(y.balance ?? "", "shares must be an integral count").toMatch(/^\d+$/);

  await expect(page.getByText("Deposited")).toBeVisible();
  await expect(page.getByText(`${y.balance} shares`)).toBeVisible();
  // the header CHIP draws the bare figure and its window; the caveat sentence is
  // gone. it used to draw the whole sentence with the word "reported" appended,
  // producing "...variable and not guaranteed reported".
  if (y.apy?.figure) {
    await expect(page.getByText(y.apy.figure, { exact: false })).toBeVisible();
  }
});
