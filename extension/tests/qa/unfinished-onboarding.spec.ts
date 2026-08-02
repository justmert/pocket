// D-005: a second window does not tell the user setup is finished while the
// phrase is still unrecorded.
//
// `create` installs the vault before the words are drawn, so `status()` reports
// a complete, unlocked wallet from the instant it resolves. Every window except
// the one holding the phrase agreed. A toolbar click mid-transcription landed on
// Home — address, balance, both pockets — which is the most authoritative
// statement this product can make that setup is done, made while the only copy
// of the recovery phrase was on another screen and had never been written down.
//
// The user closes the tab, funds the address, and finds out months later.
//
// This is worse in kind than the bug the tab was built to fix. That one was
// silence; this one affirmatively tells the user they are finished.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

test("a second window does not present the wallet while a phrase is unconfirmed", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(5 * 60_000);
  const page = wallet.page;

  // Reach the backup screen and stop there, exactly as someone transcribing
  // twenty-four words would.
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({
    timeout: WAITS.onboarding,
  });

  // The wallet really is complete on disk by now — that is the premise, not an
  // assumption. If this ever stops being true the defect is gone and so is the
  // reason for this test.
  const status = await page.evaluate(
    () =>
      new Promise<{ initialised: boolean; locked: boolean }>((res) => {
        chrome.runtime.sendMessage(
          { type: "status" },
          (r: { data: { initialised: boolean; locked: boolean } }) => res(r.data),
        );
      }),
  );
  expect(status.initialised, "premise: create installs the vault before the phrase is shown").toBe(
    true,
  );
  expect(status.locked).toBe(false);

  // Now the second window, opened the way the toolbar opens one.
  const second = await harness.openPopup();
  await second.waitForLoadState("domcontentloaded");

  await expect(
    second.getByText(/still open in another tab|has not been confirmed/i),
    "a second window told the user their wallet was ready while the phrase was still unrecorded",
  ).toBeVisible({ timeout: WAITS.ledgerRead });

  // And none of the wallet is on it.
  await expect(
    second.getByRole("button", { name: "Public pocket" }),
    "the second window presented the wallet mid-backup",
  ).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Send" })).toHaveCount(0);
  await expect(
    second.getByRole("button", { name: "Copy your address" }),
    "the second window handed out an address for a wallet with no recorded phrase",
  ).toHaveCount(0);

  // It also does not start a second copy of the flow: two windows both showing
  // a phrase step would be its own defect.
  await expect(second.getByText("Save your recovery phrase")).toHaveCount(0);
  await expect(second.getByRole("button", { name: "Create a new wallet" })).toHaveCount(0);

  await second.close();
});

test("once the phrase is confirmed, a second window shows the wallet again", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(5 * 60_000);
  // The other half. A guard that never lets go would have replaced one wrong
  // answer with another: after the words are confirmed the wallet genuinely IS
  // finished and every window may say so.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const second = await harness.openPopup();
  await second.waitForLoadState("domcontentloaded");
  await expect(second.getByRole("button", { name: "Public pocket" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await expect(second.getByText(/still open in another tab/i)).toHaveCount(0);
  await second.close();
});

/**
 * The tab is GONE, and the wallet must not be locked behind a button that
 * cannot do anything.
 *
 * A closed onboarding tab leaves the "unfinished" flag in session storage with
 * nothing to raise. The one control on the blocking screen is "Go back to it",
 * and if that were the whole screen the only exit would be quitting Chrome:
 * every window, in every profile session, showing a notice about a tab that no
 * longer exists.
 */
test("a closed onboarding tab still leaves a way into the wallet", async ({ wallet, harness }) => {
  test.setTimeout(5 * 60_000);
  const page = wallet.page;

  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({
    timeout: WAITS.onboarding,
  });

  const second = await harness.openPopup();
  await second.waitForLoadState("domcontentloaded");
  await expect(second.getByRole("button", { name: "Go back to it" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // The tab holding the words goes away, as a middle-click on the tab strip or
  // a "close tabs to the right" does. `beforeunload` makes it deliberate, not
  // impossible.
  await page.close({ runBeforeUnload: false });

  await second.getByRole("button", { name: "Go back to it" }).click();

  // The screen has to admit the tab is gone AND offer a way on. Either half
  // alone is a dead end: silence leaves the button looking broken, and a
  // sentence with no control leaves the wallet unreachable until Chrome quits.
  await expect(
    second.getByText(/that tab is gone/i),
    "pressing the only control said nothing at all",
  ).toBeVisible({ timeout: WAITS.ledgerRead });
  const on = second.getByRole("button", { name: "Continue to the wallet" });
  await expect(on, "no way into the wallet from the blocking screen").toBeVisible();

  await on.click();
  await expect(second.getByRole("button", { name: "Public Pocket" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // ...and the wallet says the phrase was never confirmed, because it was not.
  // Continuing past a dead tab is not the user telling anyone they wrote the
  // words down.
  await expect(
    second.getByText(/recovery phrase was never confirmed/i),
    "the wallet forgot that the backup check had been skipped",
  ).toBeVisible({ timeout: WAITS.ledgerRead });

  await second.close();
});
