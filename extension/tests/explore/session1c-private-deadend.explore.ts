// Session 1c — following B to the end.
//
// The private pocket says "Not open yet. This account does not exist on the
// network yet." and the bottom bar still offers "Send privately", which opens a
// full compose form with To, Amount and Review. So a newcomer can fill in a
// payment for a pocket that does not exist.
//
// The question that decides the severity is what happens when they press
// Review. A clear refusal naming the reason is a bad-but-survivable flow. A
// generic error, or a hang, is worse: the user has typed a destination and an
// amount and is told nothing they can act on.
import { test } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "..", "qa", "exploration", "session1");
const PASSWORD = "correct horse battery staple";
const TO = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

test("session 1c: pressing Review on a private pocket that does not exist", async ({ wallet }) => {
  test.setTimeout(14 * 60_000);
  const page = wallet.page;
  await page.setViewportSize({ width: 384, height: 600 });
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  await page.getByRole("button", { name: "Private", exact: true }).click();
  await page.getByRole("button", { name: "Send privately" }).click();
  await page.getByRole("textbox", { name: "To", exact: true }).fill(TO);
  await page.getByRole("textbox", { name: /Amount/ }).fill("1");

  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "C-filled-form.png"), await page.screenshot());

  const before = Date.now();
  await page.getByRole("button", { name: "Continue" }).click();

  // Watch for up to thirty seconds and record everything it says, in order.
  const seen: string[] = [];
  for (let i = 0; i < 30; i++) {
    const body = await page.evaluate(
      () => (document.querySelector("[role='dialog']") as HTMLElement | null)?.innerText ?? "",
    );
    const line = body.replace(/\s+/g, " ").trim();
    if (seen[seen.length - 1] !== line) seen.push(line);
    await page.waitForTimeout(1000);
    if (/error|cannot|not |refus|fail/i.test(line) && i > 2) break;
  }
  const elapsed = Date.now() - before;
  writeFileSync(join(OUT, "C-after-review.png"), await page.screenshot());
  writeFileSync(
    join(OUT, "C-what-review-did.txt"),
    `pressed Review on a private pocket that does not exist.\n` +
      `elapsed before it settled or gave up: ${elapsed}ms\n\n` +
      seen.map((s, i) => `  ${i + 1}. ${s.slice(0, 400)}`).join("\n\n") +
      `\n`,
  );
});
