// First run: the two ways into the wallet, and the lock that guards it after.
//
// No funding and no chain writes here, so these are the fast specs. Everything
// they touch is real: a real Chromium, the real built extension, a real scrypt
// vault, and the real BIP-39 derivation behind the address they compare.
import { test, expect } from "../support/fixtures";
import { launchWallet } from "../support/extension";
import { Wallet, ADDRESS_RE, WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

test("the first screen offers both ways in and states what Pocket does not hide", async ({
  wallet,
}) => {
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });

  // The honest framing belongs on the first screen a user ever sees, not in a
  // settings page they will never open. Confidential transfers hide amounts;
  // both addresses stay public on the ledger, permanently.
  await expect(wallet.page.getByText(/hides.*amounts.*not addresses/i)).toBeVisible();

  await expect(wallet.page.getByRole("button", { name: "Create a new wallet" })).toBeVisible();
  await expect(wallet.page.getByRole("button", { name: "I have a recovery phrase" })).toBeVisible();
});

test("creating a wallet shows 24 words once, then opens the home screen", async ({ wallet }) => {
  await wallet.page.getByRole("button", { name: "Create a new wallet" }).click();
  await wallet.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await wallet.page.getByLabel("Confirm password").fill(PASSWORD);
  await wallet.page.getByRole("button", { name: "Create wallet" }).click();

  await expect(wallet.page.getByText("Write this down")).toBeVisible({
    timeout: WAITS.onboarding,
  });

  // The words start hidden. Someone creating a wallet in an open-plan office or
  // on a screen share chooses the moment they appear, because they cannot be
  // shown again and so must stay up long enough to transcribe.
  await expect(
    wallet.page.getByRole("button", { name: "Show the phrase" }),
    "the phrase must not appear unannounced",
  ).toBeVisible();
  await expect(
    wallet.page.getByRole("button", { name: "I have written it down" }),
    "there is nothing to acknowledge until the words have been seen",
  ).toBeDisabled();
  await wallet.showPhrase();

  // 256 bits of entropy is 24 words. A 12-word phrase here would be a silent
  // halving of the security of every account the wallet ever derives.
  await expect(wallet.backupWordCells()).toHaveCount(24);

  // The two facts a user has to be told at the only moment the phrase is ever
  // on screen.
  await expect(wallet.page.getByText(/only way to recover/i)).toBeVisible();
  await expect(wallet.page.getByText(/cannot show them to you again/i)).toBeVisible();
  // The lifecycle fact, which the flow now answers rather than warns about:
  // onboarding moves itself to a tab before it paints, and a tab survives the
  // user switching to a password manager to record the words. The screen may
  // only make this promise where it is true, so the warning it replaced must be
  // gone from the same screen.
  await expect(wallet.page.getByText(/do not close this tab until you have confirmed the words/i)).toBeVisible();
  await expect(
    wallet.page.getByText(/this window closes the moment/i),
    "a tab told the user it was about to close",
  ).toHaveCount(0);

  const phrase = await wallet.readBackupPhrase();
  await wallet.page.getByRole("button", { name: "I have written it down" }).click();

  // The acknowledgement is a question, not a press. A wrong answer does not
  // open the wallet, because the whole point is that the phrase was recorded.
  await expect(wallet.page.getByText("Check what you wrote")).toBeVisible();
  const fields = wallet.page.getByLabel(/^Word \d+$/);
  await expect(fields, "three words, chosen at random from the phrase").toHaveCount(3);
  await fields.first().fill("wrong");
  await wallet.page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    wallet.page.getByText(/does not match what Pocket generated/i),
    "a wrong answer must be refused, or the check is decoration",
  ).toBeVisible();
  await expect(wallet.homeMarker()).toHaveCount(0);

  await wallet.answerBackupCheck(phrase);
  await wallet.waitForHome();

  const address = await wallet.revealAddress();
  expect(address).toMatch(ADDRESS_RE);
  // 56 characters, every time. Truncation is the defect the address layer
  // exists to prevent: grinding a matching first and last four costs about an
  // hour on a laptop, so an abbreviation is not a safe way to confirm anything.
  expect(address).toHaveLength(56);
  expect(address).not.toContain("…");
});

test("the phrase on the backup screen restores the same account on a clean device", async ({
  wallet,
}) => {
  const phrase = await wallet.createWallet(PASSWORD);
  expect(phrase.split(" ")).toHaveLength(24);
  const original = await wallet.revealAddress();

  // A second Chromium with its own profile: no shared storage, no shared vault,
  // nothing carried over but the words a user wrote down.
  const second = await launchWallet();
  try {
    const restored = new Wallet(second.popup);
    await restored.importPhrase(phrase, "a-different-password-entirely");
    const address = await restored.revealAddress();

    // The phrase is the only recovery material there is. If what the backup
    // screen shows does not reproduce this address, the words are decoration.
    expect(address).toBe(original);
  } finally {
    await second.close();
  }
});

test("locking clears the session and the password opens it again", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();

  await wallet.lock();
  // Locked means locked: no balance, no address, no send button on screen.
  await expect(wallet.page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
  await expect(wallet.page.getByText(ADDRESS_RE)).toHaveCount(0);

  await wallet.unlock(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  expect(await wallet.revealAddress()).toBe(address);
});
