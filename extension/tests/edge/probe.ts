// Reading what the wallet actually told the user.
//
// The error is whatever the screen says that is not part of the screen. Doing
// it this way rather than matching an expected string keeps the assertion
// honest: a test that greps for the message it hopes to find cannot report the
// message that was really shown.
import { expect, type Page } from "@playwright/test";

const COMPOSE_CHROME = new Set([
  "Send",
  "Close",
  "Recipient",
  "Amount (XLM)",
  "Memo (optional)",
  "Review",
]);

/** Every line on screen that is not part of the screen's own furniture. */
export async function saidBeyond(page: Page, chrome: Set<string>): Promise<string> {
  const text = await page.locator("body").innerText();
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
 * Waits on the real end condition (a verdict is on screen), never on a clock.
 */
export async function review(page: Page): Promise<ReviewOutcome> {
  await page.getByRole("button", { name: "Review" }).click();
  let out: ReviewOutcome | null = null;
  await expect
    .poll(
      async () => {
        const body = await page.locator("body").innerText();
        if (body.includes("Sending to")) {
          out = { stage: "confirm", text: body };
          return "done";
        }
        const said = await saidBeyond(page, COMPOSE_CHROME);
        // The named wait is a verdict-in-progress, not a verdict.
        if (said && !said.includes("Checking the recipient")) {
          out = { stage: "error", message: said };
          return "done";
        }
        return "waiting";
      },
      { timeout: 60_000, message: "the wallet never answered the Review press" },
    )
    .toBe("done");
  return out!;
}

/** True when a message blames the network for what the user typed. */
export const BLAMES_THE_NETWORK = /check your connection/i;
