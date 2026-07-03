// The recovery phrase, on both screens that take one.
//
// The phrases here are the official BIP-39 all-zero-entropy test vectors, typed
// out rather than generated with the wallet's own library. A phrase generated
// by `@scure/bip39` and then validated by `@scure/bip39` agrees with itself
// whatever either of them does; a published vector does not.
//
// The wallet normalises `.trim().toLowerCase().replace(/\s+/g, " ")` before
// validating, so case, padding and odd whitespace are all supposed to survive.
// That is a promise, and a promise is a thing to test.
import type { Page } from "@playwright/test";
import { test, expect, onboard, PASSWORD, SLOW } from "./edge";

// Every action gets a bound. Playwright's default `actionTimeout` is 0, meaning
// "wait until the test times out", so a `fill()` on a field that never appears
// hangs for the config's 15 minutes (45 with `test.slow()`) instead of failing.
// A mutation run found this the expensive way: a mutation that let every bad
// phrase import left the next `fill()` looking for a field on the home screen,
// and the run sat there for a quarter of an hour. A test that hangs instead of
// failing is a test nobody will run.
test.use({ actionTimeout: SLOW });

/** 128 bits of zero entropy. The canonical 12-word vector. */
const TWELVE = `${"abandon ".repeat(11)}about`;
/** 256 bits of zero entropy. The canonical 24-word vector, and what Pocket makes. */
const TWENTY_FOUR = `${"abandon ".repeat(23)}art`;

/** U+00A0. Invisible, carried by a paste out of a PDF or a chat client. */
const NBSP = " ";

const words = (p: string) => p.trim().split(/\s+/).filter(Boolean);

const CHROME = new Set([
  "Pocket",
  "Restore wallet",
  "Enter your recovery phrase.",
  "Recovery phrase",
  "New password",
  "Import wallet",
  "Importing",
  "Back",
  "Use at least eight characters.",
]);

/** Open the import screen from the very first run. */
async function openImport(page: Page): Promise<void> {
  await page.getByRole("button", { name: "I have a recovery phrase" }).click();
  await expect(page.getByLabel(/Recovery phrase/)).toBeVisible();
}

/** Fill the import form and press the button. Returns what the screen said. */
async function tryImport(page: Page, phrase: string): Promise<string> {
  await page.getByLabel(/Recovery phrase/).fill(phrase);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  const button = page.getByRole("button", { name: "Import wallet" });
  if (await button.isDisabled()) return "BUTTON DISABLED";
  await button.click();
  // Either the home screen arrives or a notice does. Wait on whichever comes,
  // never on a clock.
  let said = "";
  await expect
    .poll(
      async () => {
        const body = await page.locator("body").innerText();
        if (body.includes("Public pocket")) {
          said = "IMPORTED";
          return "done";
        }
        const notice = body
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          // the phrase field labels itself with a live word count, so it is
          // furniture whatever number it is carrying.
          .filter((l) => !CHROME.has(l) && !/^Recovery phrase \(\d+ words?\)$/.test(l))
          .filter((l) => l !== "12 or 24 words, separated by spaces")
          .join(" ");
        if (notice) {
          said = notice;
          return "done";
        }
        return "waiting";
      },
      { timeout: SLOW, message: "the import screen never answered" },
    )
    .toBe("done");
  return said;
}

test("a phrase the wallet cannot use is refused, and no wallet is created", async ({ wallet }) => {
  const page = wallet.page;
  await openImport(page);

  const bad = [
    { name: "11 words", phrase: words(TWELVE).slice(0, 11).join(" ") },
    { name: "13 words", phrase: `${TWELVE} abandon` },
    { name: "23 words", phrase: words(TWENTY_FOUR).slice(0, 23).join(" ") },
    { name: "25 words", phrase: `${TWENTY_FOUR} abandon` },
    { name: "12 wordlist words with a bad checksum", phrase: `${"abandon ".repeat(11)}abandon` },
    { name: "a word that is not in the wordlist", phrase: `${"abandon ".repeat(11)}zzzzzz` },
    { name: "the right words in the wrong order", phrase: `about ${"abandon ".repeat(11)}`.trim() },
    { name: "one word", phrase: "abandon" },
    { name: "an injection payload", phrase: "<img src=x onerror=alert(1)>" },
    { name: "emoji", phrase: "\u{1f642} ".repeat(12).trim() },
  ];

  const accepted: string[] = [];
  for (const c of bad) {
    const said = await tryImport(page, c.phrase);
    if (said === "IMPORTED") accepted.push(c.name);
  }
  expect(accepted, `these phrases created a wallet: ${accepted.join(", ")}`).toEqual([]);

  // Nothing was written on the way through, so the very next attempt with a
  // GOOD phrase must still work. A half-written vault would refuse it with
  // "a wallet already exists on this device", and a typo would have locked the
  // user out of their own device.
  expect(await tryImport(page, TWENTY_FOUR)).toBe("IMPORTED");
});

test("an unusable phrase is named as the phrase, not as a network problem", async ({ wallet }) => {
  const page = wallet.page;
  await openImport(page);

  // The 12-word vector with its checksum word replaced. Every word is real,
  // the count is right, and only the checksum is wrong: the exact shape of a
  // phrase copied down with one word mis-transcribed, which is the most likely
  // way a real recovery goes wrong.
  const said = await tryImport(page, `${"abandon ".repeat(11)}abandon`);
  expect(said).not.toBe("IMPORTED");
  expect(said, "the refusal must name the recovery phrase as the problem").toMatch(/phrase/i);
  expect(
    said,
    "a mis-transcribed phrase is not a connection problem and retrying will never fix it",
  ).not.toMatch(/check your connection/i);
});

test("an empty phrase keeps the button disabled rather than failing later", async ({ wallet }) => {
  const page = wallet.page;
  await openImport(page);
  const button = page.getByRole("button", { name: "Import wallet" });

  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Recovery phrase").fill("");
  await expect(button).toBeDisabled();
  // Whitespace is not a phrase either, and `phrase.trim().length` decides that.
  await page.getByLabel("Recovery phrase").fill(`   ${NBSP}  `);
  await expect(button).toBeDisabled();
  await page.getByLabel("Recovery phrase").fill(TWENTY_FOUR);
  await expect(button).toBeEnabled();
});

test("case, padding and odd whitespace in a phrase are normalised, not rejected", async ({
  wallet,
}) => {
  const page = wallet.page;
  await openImport(page);

  // Upper case on every other word, a non-breaking space between every pair,
  // and padding at both ends: what a phrase looks like after a round trip
  // through a password manager and a chat window.
  const mangled = `  ${words(TWENTY_FOUR)
    .map((w, i) => (i % 2 === 0 ? w.toUpperCase() : w))
    .join(NBSP)}  `;
  expect(mangled, "the fixture must actually carry a non-breaking space").toContain(NBSP);
  expect(mangled, "the fixture must actually differ from the plain phrase").not.toBe(TWENTY_FOUR);
  expect(await tryImport(page, mangled)).toBe("IMPORTED");
});

test("a 12-word phrase is accepted, not only the 24 this wallet makes", async ({ wallet }) => {
  const page = wallet.page;
  await openImport(page);
  // Pocket generates 24 words, but a user arriving from another wallet almost
  // certainly holds 12, and the import screen's own placeholder promises both.
  await expect(page.getByPlaceholder("12 or 24 words, separated by spaces")).toBeVisible();
  expect(await tryImport(page, TWELVE)).toBe("IMPORTED");
});

test("the erase-and-restore screen states the word count rule before the attempt", async ({
  wallet,
}) => {
  const page = wallet.page;
  await onboard(page);
  await page.getByRole("button", { name: "Lock wallet" }).click();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await page.getByRole("button", { name: "I understand, continue" }).click();

  const phrase = page.getByLabel(/Recovery phrase/);
  const button = page.getByRole("button", { name: "Erase and restore" });
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm new password").fill(PASSWORD);

  // A control that refuses to work without saying why is the same defect
  // whether the rule is the word count or the password, so every count that
  // keeps the button disabled has to be stated on screen.
  for (const n of [1, 11, 13, 23, 25]) {
    await phrase.fill(Array<string>(n).fill("abandon").join(" "));
    await expect(button).toBeDisabled();
    await expect(
      page.getByText(`A recovery phrase is 12 or 24 words. This one has ${n}.`),
    ).toBeVisible();
  }

  // 12 and 24 both clear the count rule, which is the other half of the claim.
  await phrase.fill(TWELVE);
  await expect(button).toBeEnabled();
  await phrase.fill(TWENTY_FOUR);
  await expect(button).toBeEnabled();
});

test("a phrase for a different wallet is refused, and this wallet survives", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  const mine = await onboard(page);
  expect(words(mine)).toHaveLength(24);
  await page.getByRole("button", { name: "Lock wallet" }).click();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await page.getByRole("button", { name: "I understand, continue" }).click();

  // A valid phrase, just not this device's. Erasing on it would destroy a
  // wallet whose holder cannot restore it, so the refusal is the whole point.
  await page.getByLabel(/Recovery phrase/).fill(TWENTY_FOUR);
  await page.getByLabel("New password", { exact: true }).fill("another-password");
  await page.getByLabel("Confirm new password").fill("another-password");
  await page.getByRole("button", { name: "Erase and restore" }).click();

  await expect(
    page.getByText(
      "That phrase belongs to a different wallet. Pocket will not erase this one with it.",
    ),
  ).toBeVisible({ timeout: SLOW });

  // Still the original wallet, and the original password still opens it.
  await page.reload();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: SLOW });
});
