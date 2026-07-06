// T2's driving helpers, on top of T1's shared harness.
//
// This file replaced a local `launch.ts` and `probe.ts` that a dead earlier run
// left behind. Everything to do with starting a browser, a profile or a wallet
// now comes from tests/support/**, which T1 owns; what is left here is only the
// part specific to feeding a form bad input and reading back what the wallet
// said about it.
//
// The reading half matters more than it looks. A test that greps for the
// message it HOPES to find cannot report the message that was really shown, so
// `review()` takes everything on screen that is not the screen's own furniture
// and hands it back verbatim. That is how three inherited tests turned out to
// be red for a real reason rather than green for a comfortable one.
import { expect, type Page } from "@playwright/test";
import { answerBackupCheck } from "../support/wallet";

export { test, expect, Wallet } from "../support/fixtures";
export { fund, account, nativeBalance, payments, transactions, waitFor } from "../support/testnet";

/** Long enough for scrypt on a loaded box, short enough that a hang fails. */
export const SLOW = 60_000;

export const PASSWORD = "a-strong-password";

/**
 * The message `describeError` gives an error whose NAME is not allowlisted.
 *
 * Matching it is how this slice tells "the wallet explained the problem" from
 * "the wallet gave up and blamed the network". Anything a user typed that comes
 * back as this is a finding: no amount of retrying fixes a typo, and the
 * sentence sends them to their router instead of to the field they got wrong.
 */
export const GENERIC_FAILURE = /Something went wrong\. Try again, and check your connection\./;
export const BLAMES_THE_NETWORK = /check your connection/i;

/** Create a wallet and land on home. Returns the 24 words. */
export async function onboard(page: Page, password = PASSWORD): Promise<string> {
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(password);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Write this down")).toBeVisible({ timeout: SLOW });
  await page.getByRole("button", { name: "Show the phrase" }).click();
  const cells = await page
    .locator("span")
    .filter({ hasText: /^\d+\.\s\w+\s*$/ })
    .allInnerTexts();
  const phrase = cells.map((c) => c.replace(/^\d+\.\s*/, "").trim()).join(" ");
  await page.getByRole("button", { name: "I have written it down" }).click();
  await answerBackupCheck(page, phrase);
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: SLOW });
  return phrase;
}

/** The wallet's own address, read off the receive sheet the way a user does. */
export async function receiveAddress(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Receive" })).toBeVisible();
  const shown = await page
    .getByText(/^G[A-Z2-7]{55}$/)
    .first()
    .innerText();
  await page.getByRole("button", { name: "Close" }).click();
  return shown.replace(/\s/g, "");
}

/**
 * Open Send and fill the compose form. Does NOT press Review.
 *
 * Separate from T1's `composePayment`, which fills and submits in one call:
 * half of this slice is about what the form does BEFORE anything is submitted,
 * such as whether Review is enabled at all.
 */
export async function compose(
  page: Page,
  fields: { to?: string; amount?: string; memo?: string },
): Promise<void> {
  // send is a sheet now, and a sheet that is closing is still on screen for the
  // length of its exit. asking "is the field visible" during that window said
  // yes, so nothing reopened it and the fill landed on a form that was about to
  // detach. the open sheet is the thing to wait on.
  const dialog = page.getByRole("dialog", { name: /^Send/ });
  if ((await dialog.count()) === 0) {
    await page.getByRole("button", { name: "Send", exact: true }).click();
  }
  await expect(dialog).toBeVisible();
  const recipient = page.getByLabel("To", { exact: true });
  await expect(recipient).toBeVisible();
  if (fields.to !== undefined) await recipient.fill(fields.to);
  if (fields.amount !== undefined) await page.getByLabel("Amount (XLM)").fill(fields.amount);
  if (fields.memo !== undefined) await page.getByLabel("Memo (optional)").fill(fields.memo);
}

/** Furniture on the compose screen: present whatever the wallet decides. */
const COMPOSE_CHROME = new Set([
  "Send",
  "Close",
  "To",
  "Amount (XLM)",
  "Memo (optional)",
  "Review",
]);

/**
 * Every line the open sheet says that is not its own furniture.
 *
 * Scoped to the sheet, not to the body: send is a sheet over the home screen
 * now, so the home screen's own text is still in the document behind it and
 * reading the body would count a balance as something the send form said.
 */
export async function saidBeyond(page: Page, chrome: Set<string>): Promise<string> {
  return beyond(await surfaceText(page), chrome);
}

/** The topmost sheet if one is open, otherwise the whole screen. */
export async function surfaceText(page: Page): Promise<string> {
  const dialog = page.getByRole("dialog").last();
  if ((await dialog.count()) > 0) return dialog.innerText();
  return page.locator("body").innerText();
}

/** The same, from text already read. Reading twice is a race: see `review`. */
function beyond(text: string, chrome: Set<string>): string {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((l) => !chrome.has(l))
    .join(" ");
}

export type ReviewOutcome =
  | { stage: "confirm"; text: string }
  | { stage: "error"; message: string };

/**
 * Press Review and wait for the wallet to finish deciding.
 *
 * Waits on the real end condition, a verdict being on screen, never on a clock.
 */
export async function review(page: Page): Promise<ReviewOutcome> {
  await page.getByRole("button", { name: "Review" }).click();
  let out: ReviewOutcome | null = null;
  await expect
    .poll(
      async () => {
        // ONE read per poll. Reading the body again for the error branch was a
        // race that reported the confirm screen as an error message: the first
        // read landed a frame before the verdict and the second a frame after.
        const body = await surfaceText(page);
        // the label is authored in sentence case and displayed in caps, so the
        // comparison is on the rendered text, case folded.
        if (body.toLowerCase().includes("what this does")) {
          out = { stage: "confirm", text: body };
          return "done";
        }
        const said = beyond(body, COMPOSE_CHROME);
        // The named wait is a verdict in progress, not a verdict.
        if (said && !said.includes("Checking")) {
          out = { stage: "error", message: said };
          return "done";
        }
        return "waiting";
      },
      { timeout: SLOW, message: "the wallet never answered the Review press" },
    )
    .toBe("done");
  return out!;
}

/**
 * Wait until the screen has stopped adding chrome of its own.
 *
 * Home fills in from several independent reads: the balance, the private
 * pocket's state, the yield position. Each can add legitimate markup, so a
 * baseline taken before they land counts one thing and the comparison counts
 * another, and the difference looks like something was injected.
 */
export async function settled(page: Page): Promise<void> {
  let last = -1;
  let runs = 0;
  await expect
    .poll(
      async () => {
        const now = await page.evaluate(() => document.querySelectorAll("svg").length);
        runs = now === last ? runs + 1 : 0;
        last = now;
        // three agreeing samples, not two: home fills in from several
        // independent reads and two of them can land inside one interval.
        return runs >= 2;
      },
      { timeout: SLOW, intervals: [600], message: "the screen never stopped changing" },
    )
    .toBe(true);
}

/** Back to home from wherever a verdict left us. */
export async function closeSend(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Close" }).click();
  // waits for the sheet to be GONE, not merely for home to be behind it: home
  // is behind it the whole time.
  await expect(page.getByRole("dialog")).toHaveCount(0);
}

/**
 * Click a control twice as fast as the browser can dispatch, without waiting
 * for the first click to be handled.
 *
 * `dblclick` is not the same thing and would not catch this: it is one CDP call
 * that also sets `detail: 2`, and a handler can read that. Two independent
 * clicks issued without an await in between are what a user with a trackpad
 * produces, and what a duplicate submission actually needs.
 */
export async function clickTwiceFast(page: Page, name: string): Promise<void> {
  const button = page.getByRole("button", { name, exact: true });
  await Promise.all([
    button.click({ noWaitAfter: true }).catch(() => undefined),
    button.click({ noWaitAfter: true, force: true }).catch(() => undefined),
  ]);
}

/**
 * Two clicks on the same button inside ONE task, so the second is dispatched
 * before the test can wait for anything.
 *
 * `clickTwiceFast` is the realistic version and is also the one that can
 * silently do nothing: if the first click's re-render wins the race, the second
 * hits a button that is gone, the test passes, and nothing was ever tested.
 * This one cannot dispatch fewer than two, and it says so.
 *
 * It also reports whether the second click actually LANDED, which is a
 * different question and the interesting one. React flushes a discrete click
 * synchronously, so a control that disables itself in its own handler is
 * already out of reach by the second call and `.click()` on it is a no-op.
 * That is a real duplicate-submission defence and a test should be able to
 * assert it; without this the test would be asserting the absence of an error
 * on a screen that had already unmounted, which is an assertion that cannot
 * fail.
 *
 * The button is found by its visible text, which is what a user reads.
 */
export interface DoubleClick {
  /** Always 2, or the helper throws. */
  dispatched: number;
  /** True when the button was still live and enabled for the second click. */
  secondLanded: boolean;
}

export async function clickTwiceInOneTask(page: Page, label: string): Promise<DoubleClick> {
  const result = await page.evaluate((text) => {
    const button = [...document.querySelectorAll("button")].find(
      (b) => b.textContent?.trim() === text && !b.disabled,
    );
    if (!button) return { dispatched: 0, secondLanded: false };
    button.click();
    // Read BETWEEN the two clicks. After this point the answer is history.
    const secondLanded = !button.disabled && button.isConnected;
    button.click();
    return { dispatched: 2, secondLanded };
  }, label);
  expect(
    result.dispatched,
    `"${label}" had to be clickable twice for this test to mean anything`,
  ).toBe(2);
  return result;
}
