// Roles, names, and whether anything is ANNOUNCED.
//
// A sighted user learns the balance arrived because a spinner became a number.
// A screen-reader user learns nothing unless the change is inside a live
// region. WCAG 2.1 SC 4.1.3 (Status Messages, Level AA) is the rule: a status
// that appears without taking focus must be programmatically determinable.
//
// Every wait in this wallet is a status message -- "Reading the ledger…",
// "Proving. This takes a moment…", "Submitting and waiting for the ledger…" --
// and so is every refusal.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { offline, hang, RPC_HOST } from "../support/stub";

const PASSWORD = "a-strong-test-password";

/** Does this element, or an ancestor, put it in a live region? */
async function inLiveRegion(locator: import("@playwright/test").Locator): Promise<{
  live: boolean;
  role: string;
  ariaLive: string;
}> {
  return locator.evaluate((el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const role = n.getAttribute("role") ?? "";
      const ariaLive = n.getAttribute("aria-live") ?? "";
      if (["status", "alert", "log", "progressbar"].includes(role) || ariaLive) {
        return { live: true, role, ariaLive };
      }
    }
    return { live: false, role: "", ariaLive: "" };
  });
}

test("every button has an accessible name", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // Read from the ACCESSIBILITY TREE, not from innerText.
  //
  // innerText reports a name for a button whose only content is `aria-hidden`,
  // which is precisely the case that leaves a screen-reader user with an
  // unlabelled control. The tree is what assistive technology consumes.
  //
  // Via `ariaSnapshot`, not `page.accessibility`: that API was removed in
  // Playwright 1.62, so calling it threw a TypeError. The test failed, which
  // looked like a finding and was not, and worse, it "failed" identically under
  // the mutation meant to prove it works. A test that throws is not a test that
  // asserts. Same family as T1's vacuous assertion, caught the same way -- by
  // asking why a result looked the way it did instead of accepting it.
  const snapshot = await wallet.page.locator("body").ariaSnapshot();
  const unnamed = snapshot
    .split("\n")
    // `- button "Lock"` is named; a bare `- button` or `- button:` is not.
    .filter((line) => /^\s*-\s+button\s*:?\s*$/.test(line));
  expect(
    unnamed,
    `buttons with no accessible name are unusable by voice or screen reader.\n${snapshot}`,
  ).toEqual([]);
});

test("every text field is programmatically labelled", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.openSend();

  // `getByLabel` resolving at all is the proof: it uses the accessibility
  // label, not the visual proximity of some text.
  await expect(wallet.page.getByLabel("Recipient")).toBeVisible();
  await expect(wallet.page.getByLabel("Amount (XLM)")).toBeVisible();
  await expect(wallet.page.getByLabel("Memo (optional)")).toBeVisible();

  const unlabelled = await wallet.page.evaluate(() =>
    Array.from(document.querySelectorAll("input, textarea"))
      .filter((el) => {
        const id = el.getAttribute("id");
        const byFor = id ? document.querySelector(`label[for="${id}"]`) : null;
        const wrapped = el.closest("label");
        return !el.getAttribute("aria-label") && !byFor && !wrapped;
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(unlabelled).toEqual([]);
});

/**
 * FAILING: finding 2 in `_test/T6-T7.md`.
 *
 * The wait that takes longest in this wallet is a confidential proof, and the
 * wait a user is most anxious about is a submission. Neither is announced.
 */
test("a wait is announced, not only drawn", async ({ harness, wallet }) => {
  await wallet.createWallet(PASSWORD);
  await hang(harness.context, RPC_HOST);
  await wallet.reopen();

  const waiting = wallet.page.getByText("Reading the ledger…");
  await expect(waiting).toBeVisible();

  const region = await inLiveRegion(waiting);
  expect(
    region.live,
    'the "Reading the ledger…" status is not in a live region, so a screen-reader ' +
      "user is told nothing between opening the wallet and the balance arriving",
  ).toBe(true);
});

/**
 * FAILING: finding 2 in `_test/T6-T7.md`.
 *
 * A refusal that is only drawn is a refusal a screen-reader user does not know
 * happened. They pressed Review, nothing was said, and the form still looks the
 * same to them.
 */
test("a refusal is announced, not only drawn", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.openSend();
  await wallet.composePayment({ to: "not-an-address", amount: "1" });

  const error = wallet.page.getByText(/does not look like a Stellar address/i);
  await expect(error).toBeVisible({ timeout: WAITS.ledgerRead });

  const region = await inLiveRegion(error);
  expect(
    region.live,
    "the address refusal is not in a live region and does not take focus, so it is " +
      "silent to a screen reader",
  ).toBe(true);
});

/**
 * FAILING: finding 2 in `_test/T6-T7.md`.
 *
 * The balance failing to load is the case where a silent UI is most dangerous:
 * the user is about to decide whether they have money.
 */
test("a failed balance read is announced", async ({ harness, wallet }) => {
  await wallet.createWallet(PASSWORD);
  await ledger.fund(await wallet.revealAddress());
  await offline(harness.context, RPC_HOST);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  const error = wallet.page.getByText(/Something went wrong|check your connection/i);
  await expect(error).toBeVisible({ timeout: WAITS.ledgerRead });
  const region = await inLiveRegion(error);
  expect(region.live, "the balance failure is not announced").toBe(true);
});

/**
 * FAILING: finding 3 in `_test/T6-T7.md`.
 *
 * Every screen title is a styled `div`. Screen-reader users navigate by
 * heading; with none, the only way through a screen is to read all of it.
 */
test("each screen has a heading a screen reader can navigate by", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const headings = await wallet.page.getByRole("heading").count();
  expect(headings, "the home screen exposes no heading at all").toBeGreaterThan(0);
});

test("the recovery phrase is real text, not an image or a canvas", async ({ wallet }) => {
  // The one screen whose content a user MUST be able to copy, read aloud, or
  // have read to them. Rendering it as anything but text would make it
  // unrecoverable for exactly the people who most need it read out.
  await wallet.page.getByRole("button", { name: "Create a new wallet" }).click();
  await wallet.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await wallet.page.getByLabel("Confirm password").fill(PASSWORD);
  await wallet.page.getByRole("button", { name: "Create wallet" }).click();
  await expect(wallet.page.getByText("Write this down")).toBeVisible({
    timeout: WAITS.onboarding,
  });

  await expect(wallet.backupWordCells()).toHaveCount(24);
  const phrase = await wallet.readBackupPhrase();
  expect(phrase.split(" ")).toHaveLength(24);
  await expect(wallet.page.locator("canvas, img")).toHaveCount(0);
});
