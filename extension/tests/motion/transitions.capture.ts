// Frame sequences for every transition the pass introduced or changed.
//
// Run with `npx playwright test -c playwright.motion.config.ts`. It writes into
// ux/motion/ and asserts only that each sequence actually captured frames; the
// judgement about whether the choreography is right is made by looking at them,
// which is the point of producing them.
//
// Every transition is captured twice: once normally and once under
// `prefers-reduced-motion: reduce`. The pair is the information-parity check the
// brief asks for — anything a user learns from the motion has to still be
// learnable when the motion is gone, and the reduced sequence is where that is
// visible rather than asserted.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PASSWORD = "a-strong-test-password";
const OUT = join(process.cwd(), "..", "ux", "motion");
const FRAME = { width: 384, height: 600 };

/**
 * capture `count` frames while `act` plays out.
 *
 * the screenshots are taken from the page rather than from a video because a
 * fixed 384x600 frame with no remote assets renders deterministically, so a
 * strip of stills is reproducible in a way a video is not.
 */
async function film(
  page: Page,
  name: string,
  act: () => Promise<void>,
  { count = 10, everyMs = 45 }: { count?: number; everyMs?: number } = {},
): Promise<number> {
  mkdirSync(join(OUT, name), { recursive: true });
  const shots: Promise<Buffer>[] = [];
  const started = Date.now();
  void act();
  for (let i = 0; i < count; i++) {
    shots.push(page.screenshot({ animations: "allow" }));
    await page.waitForTimeout(everyMs);
  }
  const frames = await Promise.all(shots);
  frames.forEach((buf, i) => {
    const at = String(i * everyMs).padStart(4, "0");
    writeFileSync(join(OUT, name, `t${at}ms.png`), buf);
  });
  writeFileSync(
    join(OUT, name, "README.md"),
    `# ${name}\n\n${frames.length} frames, ${everyMs}ms apart, ${Date.now() - started}ms of wall clock.\n` +
      `Captured from the built extension at ${FRAME.width}x${FRAME.height}.\n`,
  );
  return frames.length;
}

for (const reduced of [false, true] as const) {
  const suffix = reduced ? "-reduced" : "";

  test(`transitions${suffix}`, async ({ wallet }) => {
    test.setTimeout(9 * 60_000);
    const page = wallet.page;
    await page.setViewportSize(FRAME);
    if (reduced) await page.emulateMedia({ reducedMotion: "reduce" });

    // 1. onboarding's first step arriving.
    expect(await film(page, `onboarding-choose${suffix}`, async () => {
      await page.reload();
    })).toBeGreaterThan(0);

    await expect(page.getByRole("button", { name: "Create a new wallet" })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });

    // 2. the phrase step revealing itself, which is the one screen in the
    //    product where motion sits between a user and a secret.
    await page.getByRole("button", { name: "Create a new wallet" }).click();
    await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
    await page.getByLabel("Confirm password").fill(PASSWORD);
    await page.getByRole("button", { name: "Create wallet" }).click();
    await expect(page.getByText("Save your recovery phrase")).toBeVisible({ timeout: WAITS.onboarding });
    expect(await film(page, `phrase-reveal${suffix}`, async () => {
      await page.getByRole("button", { name: "Show the phrase" }).click();
    })).toBeGreaterThan(0);

    const phrase = await wallet.readBackupPhrase();
    await page.getByRole("button", { name: "I have written it down" }).click();
    await wallet.answerBackupCheck(phrase);
    await wallet.waitForHome(WAITS.ledgerRead);

    // 3. the home list arriving, which is what ROW_STAGGER_MS times.
    expect(await film(page, `home-arrival${suffix}`, async () => {
      await page.reload();
    }, { count: 12 })).toBeGreaterThan(0);
    await wallet.waitForHome(WAITS.ledgerRead);

    // 4. a sheet coming up.
    expect(await film(page, `sheet-open${suffix}`, async () => {
      await page.getByRole("button", { name: "Actions", exact: true }).click();
      await page.getByRole("menuitem", { name: "Send", exact: true }).click();
    })).toBeGreaterThan(0);
    // `film` starts its action without awaiting it, so the sheet must be seen
    // gone before the next sequence begins or it films the wrong thing.
    await page.keyboard.press("Escape");
    await expect(page.locator("[role='dialog']")).toHaveCount(0, { timeout: WAITS.ledgerRead });

    // 5. the pocket switch, the one piece of motion that is the product's
    //    identity rather than its feedback.
    expect(await film(page, `pocket-switch${suffix}`, async () => {
      await wallet.openPocket("Private pocket");
    }, { count: 14, everyMs: 50 })).toBeGreaterThan(0);
  });
}
