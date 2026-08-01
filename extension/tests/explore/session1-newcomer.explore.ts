// Session 1 — the newcomer.
//
// Fresh profile, fresh install, no prior knowledge. Use only what the interface
// tells you. The output is not a pass or a fail: it is a screenshot at every
// point where a person would have to decide something, plus the accessibility
// tree at that moment, so the write-up in qa/exploration/ can say what was
// actually on screen rather than what I remember being there.
//
// What this is looking for is not breakage. It is hesitation: every moment a
// newcomer would have to guess, every screen where it is unclear what pressing
// the button will do, every point where they would wonder whether something
// worked. Those are defects even when nothing throws, and a scripted test that
// always knows the right selector can never see them.
import { test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "..", "qa", "exploration", "session1");
const PASSWORD = "correct horse battery staple";

/** capture what is on screen and what a listener would be told about it. */
async function look(page: Page, step: string): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const slug = step.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  writeFileSync(join(OUT, `${slug}.png`), await page.screenshot());
  const text = await page.evaluate(() => {
    const visible = (el: Element) => {
      const s = getComputedStyle(el);
      return s.display !== "none" && s.visibility !== "hidden" && Number(s.opacity) > 0.05;
    };
    const controls = Array.from(document.querySelectorAll("button, [role='button'], input, textarea"))
      .filter(visible)
      .map((el) => {
        const tag = el.tagName.toLowerCase();
        const name =
          el.getAttribute("aria-label") ??
          (el as HTMLInputElement).labels?.[0]?.textContent?.trim() ??
          (el.textContent ?? "").trim().slice(0, 60);
        const disabled = (el as HTMLButtonElement).disabled ? " [disabled]" : "";
        return `${tag}: ${name}${disabled}`;
      });
    return { body: (document.body.innerText ?? "").replace(/\n{2,}/g, "\n").trim(), controls };
  });
  writeFileSync(
    join(OUT, `${slug}.txt`),
    `STEP: ${step}\n\nWHAT IS ON SCREEN\n${text.body}\n\nWHAT CAN BE PRESSED\n${text.controls.map((c) => "  " + c).join("\n")}\n`,
  );
}

test("session 1: a newcomer sets up a wallet reading nothing but the screen", async ({ wallet }) => {
  test.setTimeout(14 * 60_000);
  const page = wallet.page;
  await page.setViewportSize({ width: 384, height: 600 });

  // 1. The very first thing anyone sees. Does it say what this is, and are the
  //    two ways in distinguishable without prior knowledge?
  await look(page, "01 first run");

  // 2. "Create a new wallet" — what does a newcomer expect, and what happens?
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await look(page, "02 after choosing create");

  // 3. The password screen. Two fields. Is it clear what this password is for,
  //    and what it is not for?
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await look(page, "03 password typed, before confirm");
  await page.getByLabel("Confirm password").fill(PASSWORD);
  await look(page, "04 both password fields filled");

  await page.getByRole("button", { name: "Create wallet" }).click();

  // 4. The phrase. This is the screen the whole product turns on.
  await page.getByText("Save your recovery phrase").waitFor({ timeout: WAITS.onboarding });
  await look(page, "05 phrase screen, words still hidden");

  await page.getByRole("button", { name: "Show the phrase" }).click();
  await look(page, "06 phrase revealed");

  const phrase = await wallet.readBackupPhrase();
  await page.getByRole("button", { name: "I have written it down" }).click();
  await look(page, "07 the check, before answering");

  await wallet.answerBackupCheck(phrase);
  await wallet.waitForHome(WAITS.ledgerRead);

  // 5. Home, on a brand new account with no funds. This is where a newcomer
  //    finds out whether the product tells them what to do next.
  await look(page, "08 home, unfunded");

  // 6. The first thing a newcomer wants: how do I get money in?
  await page.getByRole("button", { name: "Receive" }).click();
  await look(page, "09 receive");
  await page.keyboard.press("Escape");
  await page.locator("[role='dialog']").waitFor({ state: "detached" }).catch(() => undefined);

  // 7. And the thing they will try before they have any: send.
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Send", exact: true }).click();
  await look(page, "10 send, empty form on an empty wallet");

  // What does it do if a newcomer just presses the primary button?
  const review = page.getByRole("button", { name: "Continue" });
  if (await review.isEnabled().catch(() => false)) {
    await review.click();
    await look(page, "11 review pressed with nothing typed");
  } else {
    await look(page, "11 review is disabled with nothing typed");
  }
  await page.keyboard.press("Escape");
  await page.locator("[role='dialog']").waitFor({ state: "detached" }).catch(() => undefined);

  // 8. The other pocket, which is the product's whole point and which a
  //    newcomer has been told nothing about yet.
  await page.getByRole("button", { name: "Private pocket" }).click();
  await look(page, "12 private pocket, never set up");

  await page.getByRole("button", { name: "Move" }).click();
  await look(page, "13 move sheet on a pocket that does not exist yet");
  await page.keyboard.press("Escape");
  await page.locator("[role='dialog']").waitFor({ state: "detached" }).catch(() => undefined);

  // 9. Settings, which is where a newcomer goes when they are unsure.
  await page.getByRole("button", { name: "Settings" }).click();
  await look(page, "14 settings");

  writeFileSync(join(OUT, "phrase-used.txt"), `${phrase}\n`);
});
