// The password: the only thing standing between someone holding the device and
// the vault.
//
// Two properties, and they pull in opposite directions. Every rule that keeps
// the Create button disabled has to be STATED, because a control that silently
// refuses is indistinguishable from a broken one. And whatever the user typed
// has to be the exact string the KDF sees, because a password silently trimmed
// or normalised opens a vault its owner cannot reproduce from memory.
import { test, expect, SLOW } from "./edge";
import type { Page } from "@playwright/test";
import { answerBackupCheck } from "../support/wallet";

// Every action gets a bound. Playwright's default `actionTimeout` is 0, meaning
// "wait until the test times out", so a `fill()` on a field that never appears
// hangs for the config's 15 minutes (45 with `test.slow()`) instead of failing.
// A mutation run found this the expensive way: a mutation that let every bad
// phrase import left the next `fill()` looking for a field on the home screen,
// and the run sat there for a quarter of an hour. A test that hangs instead of
// failing is a test nobody will run.
test.use({ actionTimeout: SLOW });

/** Fill the create form. Does not press anything. */
async function fillCreate(page: Page, password: string, confirm = password): Promise<void> {
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByLabel("Confirm password").fill(confirm);
}

async function openCreate(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
}

/** Create a wallet with this password and walk past the backup screen. */
async function createWith(page: Page, password: string): Promise<void> {
  await openCreate(page);
  await fillCreate(page, password);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({ timeout: SLOW });
  await page.getByRole("button", { name: "Show the phrase" }).click();
    const shownWords = await page
    .locator("span")
    .filter({ hasText: /^\d+\.\s\w+\s*$/ })
    .allInnerTexts();
  const shownPhraseText = shownWords.map((c) => c.replace(/^\d+\.\s*/, "").trim()).join(" ");
  await page.getByRole("button", { name: "I have written it down" }).click();
  await answerBackupCheck(page, shownPhraseText);
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: SLOW });
}

test("the eight-character minimum is enforced at exactly eight, and stated", async ({ wallet }) => {
  const page = wallet.page;
  await openCreate(page);
  const button = page.getByRole("button", { name: "Create wallet" });
  const rule = page.getByText("Use at least eight characters.");

  // Empty: refused, and deliberately silent. Nothing has gone wrong yet, so
  // shouting a rule at an untouched form is noise, not help.
  await fillCreate(page, "");
  await expect(button).toBeDisabled();
  await expect(rule).toBeHidden();

  // Seven, one under. Refused AND explained.
  await fillCreate(page, "1234567");
  await expect(button).toBeDisabled();
  await expect(rule).toBeVisible();

  // Eight, the boundary itself. Accepted, and the rule stops being shown.
  await fillCreate(page, "12345678");
  await expect(button).toBeEnabled();
  await expect(rule).toBeHidden();
});

test("a mismatched confirmation is refused and named, before anything is created", async ({
  wallet,
}) => {
  const page = wallet.page;
  await openCreate(page);
  const button = page.getByRole("button", { name: "Create wallet" });

  await fillCreate(page, "a-strong-password", "a-strong-passwerd");
  await expect(button).toBeDisabled();
  await expect(page.getByText("The two passwords do not match.")).toBeVisible();

  // A confirmation that is a PREFIX of the password is the one a user is most
  // likely to produce and least likely to spot.
  await fillCreate(page, "a-strong-password", "a-strong-passwor");
  await expect(button).toBeDisabled();

  await fillCreate(page, "a-strong-password");
  await expect(button).toBeEnabled();
  await expect(page.getByText("The two passwords do not match.")).toBeHidden();
});

test("a password is taken exactly as typed: padding is part of it, not noise", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  // Leading and trailing spaces. If anything trims them, the vault is opened
  // by a string the user never typed and cannot reproduce, and the one they DO
  // remember stops working. Silent normalisation of a secret is a lockout.
  const padded = "  spaced out  ";
  await createWith(page, padded);

  await page.getByRole("button", { name: "Lock wallet" }).click();
  await expect(page.getByText(/Enter your password to unlock Pocket/)).toBeVisible();

  // The trimmed form must NOT open it.
  await page.getByLabel("Password", { exact: true }).fill(padded.trim());
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible({ timeout: SLOW });

  // The exact string must.
  await page.getByLabel("Password", { exact: true }).fill(padded);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: SLOW });
});

test("an emoji password round-trips through the vault unchanged", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  // Four emoji. `password.length` counts UTF-16 code units, so this is eight
  // by the minimum-length rule and four to the person typing it. Whatever the
  // rule decides, the bytes that reach scrypt must be the bytes typed: a
  // surrogate pair mangled on the way in produces a vault nobody can open.
  const emoji = "\u{1f642}\u{1f510}\u{1f680}\u{1f9ea}";
  expect(emoji.length, "four emoji is eight UTF-16 units").toBe(8);
  expect([...emoji], "and four characters to a human").toHaveLength(4);

  await createWith(page, emoji);
  await page.getByRole("button", { name: "Lock wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(emoji);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: SLOW });
});

test("a very long password is not truncated to something shorter", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  // 1,024 characters. A KDF that silently truncates at 64 or 72 bytes, as
  // bcrypt does, would accept a prefix as the whole password: the vault would
  // then open for a password the user did not choose.
  const long = `${"correct horse battery staple ".repeat(36)}end`;
  expect(long.length).toBeGreaterThan(1000);

  await createWith(page, long);
  await page.getByRole("button", { name: "Lock wallet" }).click();

  await page.getByLabel("Password", { exact: true }).fill(long.slice(0, 72));
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(
    page.getByText("Wrong password."),
    "a 72-character prefix must not open a 1,024-character password's vault",
  ).toBeVisible({ timeout: SLOW });

  await page.getByLabel("Password", { exact: true }).fill(long);
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: SLOW });
});

test("a wrong password is named as wrong and clears the field", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await createWith(page, "a-strong-password");
  await page.getByRole("button", { name: "Lock wallet" }).click();

  const field = page.getByLabel("Password", { exact: true });
  await field.fill("a-strong-passwerd");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("Wrong password.")).toBeVisible({ timeout: SLOW });
  // The message says what happened without saying anything about the vault:
  // no hint about length, no hint about how close the attempt was.
  await expect(page.getByText(/check your connection/i)).toBeHidden();
  // And the field is emptied, so a second attempt starts from nothing rather
  // than from a wrong string the user has to notice and clear.
  await expect(field).toHaveValue("");
  // Unlock is disabled again on an empty field, so the failed attempt cannot
  // simply be repeated by pressing the button.
  await expect(page.getByRole("button", { name: "Unlock" })).toBeDisabled();
});

test("an empty password never reaches the key derivation", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await createWith(page, "a-strong-password");
  await page.getByRole("button", { name: "Lock wallet" }).click();
  await expect(page.getByRole("button", { name: "Unlock" })).toBeDisabled();
  await page.getByLabel("Password", { exact: true }).fill(" ");
  await expect(
    page.getByRole("button", { name: "Unlock" }),
    "a single space is a password the user may genuinely have chosen",
  ).toBeEnabled();
});
