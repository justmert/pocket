// Forgot password: erase this device and restore from the recovery phrase.
//
// The only destructive path reachable while locked, and the only route out of a
// lost password that does not involve removing the extension by hand. What it
// must do is restore the public pocket exactly; what it must SAY is that it
// cannot restore private balances, before the user types twenty-four words.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";

const PASSWORD = "the-password-that-gets-forgotten";
const NEW_PASSWORD = "a-completely-different-password";

test("the erase screen states what comes back and what does not, and offers the way out first", async ({
  wallet,
}) => {
  await wallet.createWallet(PASSWORD);
  await wallet.lock();
  await wallet.openRecover();

  await expect(wallet.page.getByText("This erases the wallet on this device.")).toBeVisible();
  await expect(wallet.page.getByText(/public pocket/).first()).toBeVisible();
  await expect(wallet.page.getByText(/comes back from the phrase/)).toBeVisible();
  // The fact that costs money if it is missing: a phrase restores KEYS, not the
  // openings that make confidential commitments spendable.
  await expect(wallet.page.getByText(/private pocket balances.*are gone/)).toBeVisible();

  // Nothing is erased until a second, explicit tap, and the way out is on
  // screen next to it.
  await expect(wallet.page.getByRole("button", { name: "Go back" })).toBeVisible();
  await expect(wallet.page.getByRole("button", { name: "I understand, continue" })).toBeVisible();
  await expect(wallet.page.getByLabel(/Recovery phrase/)).toHaveCount(0);

  await wallet.page.getByRole("button", { name: "Go back" }).click();
  await expect(wallet.lockedNotice()).toBeVisible();
});

test("a forgotten password is recovered by the phrase, and the money is still there", async ({
  wallet,
}) => {
  test.setTimeout(5 * 60_000);

  const phrase = await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  const funded = await ledger.fund(address);

  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  expect(await wallet.publicBalance()).toBeCloseTo(funded - 1, 7);

  await wallet.lock();
  await wallet.openRecover();
  await wallet.eraseAndRestore(phrase, NEW_PASSWORD);

  // Restored, unlocked, and on the home screen: the flow finishes by itself
  // rather than dropping the user back at a lock screen they cannot open.
  await wallet.waitForHome(WAITS.onboarding);
  expect(await wallet.revealAddress()).toBe(address);

  // The public pocket comes back in full, which is exactly what the screen
  // promised. Checked against Horizon, not against the wallet's own number.
  const onChain = await ledger.nativeBalance(address);
  expect(onChain).toBeCloseTo(funded, 7);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  expect(await wallet.publicBalance()).toBeCloseTo(onChain - 1, 7);

  // And the new password is the password now.
  await wallet.lock();
  await wallet.unlock(NEW_PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
});
