// Session 1, following two things the first pass turned up.
//
// Exploration is only worth anything if a thing that looked odd gets chased
// until it is either a defect or explained. Two:
//
//   A. on a brand new, unfunded account the PUBLIC hero read "Reading the
//      ledger" at the moment home appeared, while the PRIVATE side on the same
//      account already knew the account does not exist. either the public side
//      settles to something honest a moment later, or a newcomer's first sight
//      of their wallet is a permanent claim that it is still loading.
//
//   B. the bottom bar offers "Send privately" while the private pocket reads
//      "Not open yet — fund this account first". what does a newcomer get when
//      they press it? an explanation is fine. a dead end is a defect.
import { test } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "..", "qa", "exploration", "session1");
const PASSWORD = "correct horse battery staple";

async function look(page: Page, step: string): Promise<string> {
  mkdirSync(OUT, { recursive: true });
  const slug = step.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  writeFileSync(join(OUT, `${slug}.png`), await page.screenshot());
  const body = await page.evaluate(() =>
    (document.body.innerText ?? "").replace(/\n{2,}/g, "\n").trim(),
  );
  writeFileSync(join(OUT, `${slug}.txt`), `STEP: ${step}\n\n${body}\n`);
  return body;
}

test("session 1b: what the two odd things actually do", async ({ wallet }) => {
  test.setTimeout(14 * 60_000);
  const page = wallet.page;
  await page.setViewportSize({ width: 384, height: 600 });
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // A. Watch the public hero for a full ten seconds and record what it settles
  //    to. A newcomer does not press anything while they wait, so neither do we.
  const seen: string[] = [];
  for (let i = 0; i < 10; i++) {
    const hero = await page.evaluate(() => {
      const el = document.querySelector("#root");
      const t = (el as HTMLElement | null)?.innerText ?? "";
      const line = t.split("\n").find((l) => /Reading the ledger|^0|XLM|not exist/i.test(l.trim()));
      return (line ?? "(nothing matched)").trim();
    });
    if (seen[seen.length - 1] !== hero) seen.push(hero);
    await page.waitForTimeout(1000);
  }
  writeFileSync(
    join(OUT, "A-public-hero-over-ten-seconds.txt"),
    `what the public balance said, in order, over ten seconds on a brand new unfunded account:\n\n` +
      seen.map((s, i) => `  ${i + 1}. ${s}`).join("\n") +
      `\n`,
  );
  await look(page, "A settled home unfunded");

  // B. Press "Send privately" on a pocket that does not exist.
  await page.getByRole("button", { name: "Private", exact: true }).click();
  await page.waitForTimeout(400);
  const nav = page.getByRole("button", { name: "Send privately" });
  const reachable = await nav.isVisible().catch(() => false);
  writeFileSync(
    join(OUT, "B-send-privately-reachable.txt"),
    `is "Send privately" offered while the private pocket reads "Not open yet"? ${reachable}\n`,
  );
  if (reachable) {
    await nav.click();
    await page.waitForTimeout(600);
    const body = await look(page, "B send privately on an unopened pocket");
    writeFileSync(
      join(OUT, "B-result.txt"),
      `pressing "Send privately" with no private pocket produced:\n\n${body}\n`,
    );
  }
});
