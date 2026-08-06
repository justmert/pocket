// First run: the two ways into the wallet, and the lock that guards it after.
//
// No funding and no chain writes here, so these are the fast specs. Everything
// they touch is real: a real Chromium, the real built extension, a real scrypt
// vault, and the real BIP-39 derivation behind the address they compare.
import { test, expect } from "../support/fixtures";
import { launchWallet } from "../support/extension";
import { Wallet, ADDRESS_RE, WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

test("the first screen offers both ways in", async ({ wallet }) => {
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });

  // This used to also assert "Pocket hides amounts, not addresses. Who you pay
  // stays public on the Stellar ledger, permanently." on this screen. The line
  // was removed as prose the first screen did not need. The claim itself is
  // still made where it bears on a decision: the private pocket hero says
  // "Hides amounts, never addresses. Who you pay stays public on the ledger."
  // (screens/Home.tsx) and the private send screen says "The amount is hidden.
  // Both addresses stay public on the ledger." (screens/Send.tsx). What is no
  // longer true is that it is on the splash, and an assertion that says
  // otherwise would be a test asserting a screen nobody ships.
  await expect(wallet.page.getByRole("button", { name: "Create a new wallet" })).toBeVisible();
  await expect(wallet.page.getByRole("button", { name: "I have a recovery phrase" })).toBeVisible();
});

test("creating a wallet shows 24 words once, then opens the home screen", async ({ wallet }) => {
  await wallet.page.getByRole("button", { name: "Create a new wallet" }).click();
  await wallet.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await wallet.page.getByLabel("Confirm password").fill(PASSWORD);
  await wallet.page.getByRole("button", { name: "Create wallet" }).click();

  await expect(wallet.page.getByText("Save your recovery phrase")).toBeVisible({
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

  // Who owns the funds if the words leak, and the instruction. This screen
  // used to promise "we cannot show them to you again", which stopped being
  // true when Settings grew a phrase door behind the password: a wallet that
  // CAN show them again must not say it cannot, so the sentence went and the
  // ownership one carries the weight.
  await expect(wallet.page.getByText(/anyone with these words owns your wallet/i)).toBeVisible();
  await expect(wallet.page.getByText(/write them down now/i)).toBeVisible();
  // The lifecycle fact, which the flow answers rather than warns about:
  // onboarding moves itself to a tab before it paints, and a tab survives the
  // user switching to a password manager to record the words. The screen may
  // only make that promise where it is true, so the popup's sentence must not
  // appear here.
  await expect(
    wallet.page.getByText(/this window closes the moment/i),
    "a tab told the user it was about to close",
  ).toHaveCount(0);

  const phrase = await wallet.readBackupPhrase();
  await wallet.page.getByRole("button", { name: "I have written it down" }).click();

  // The acknowledgement is a question, not a press. A wrong answer does not
  // open the wallet, because the whole point is that the phrase was recorded.
  //
  // The step is TAP CHIPS now, not typed fields: three blanks in the phrase,
  // filled in order from a pool. The property is unchanged and the mechanics
  // are not, so this drives the mechanics that exist.
  await expect(wallet.page.getByText("Confirm your recovery phrase")).toBeVisible();
  const blanks = wallet.page.getByTestId("verify-blank");
  await expect(blanks, "three words, chosen at random from the phrase").toHaveCount(3);

  // Answer it WRONG on purpose: fill the blanks in reverse, which is a real
  // arrangement of real chips and is the mistake the pool of decoys exists to
  // make possible.
  const words = phrase.split(" ");
  const asked: number[] = [];
  for (let i = 0; i < 3; i++) {
    asked.push(Number((await blanks.nth(i).getAttribute("data-position")) ?? "0"));
  }
  for (const n of [...asked].reverse()) {
    await wallet.page.getByRole("button", { name: words[n - 1]!, exact: true }).click();
  }
  await wallet.page.getByRole("button", { name: "Confirm", exact: true }).click();
  await expect(
    wallet.page.getByText(/wrong words/i),
    "a wrong answer must be refused, or the check is decoration",
  ).toBeVisible();
  await expect(wallet.homeMarker()).toHaveCount(0);

  // Clear the three wrong placements before answering properly.
  for (let i = 0; i < 3; i++) await blanks.nth(i).click();

  await wallet.answerBackupCheck(phrase);
  // The full-page flow ends on its own completion screen and leaves the wallet
  // to the toolbar popup; the helper does what a user does with it.
  await wallet.passOnboardingReady();
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
