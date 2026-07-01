// Duplicate submission: the same button, twice, before anything can react.
//
// Every test here uses `clickTwiceInOneTask`, which dispatches both clicks in
// one task so the second cannot lose a race against a re-render. A test that
// merely clicks fast is a test that sometimes clicks once, passes, and proves
// nothing. The helper asserts that both clicks were dispatched, so a run that
// tested nothing fails instead of going quietly green.
//
// The question in each case is not "did it error" but "what exists afterwards":
// one wallet, one vault, one payment on the ledger.
import { Keypair } from "@stellar/stellar-sdk/base";
import { launchWallet } from "../support/extension";
import {
  test,
  expect,
  onboard,
  receiveAddress,
  fund,
  compose,
  review,
  payments,
  waitFor,
  clickTwiceInOneTask,
  PASSWORD,
  SLOW,
} from "./edge";

test("creating a wallet twice in one gesture leaves one wallet, and the phrase on screen is its phrase", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await page.getByLabel("Confirm password").fill(PASSWORD);

  await clickTwiceInOneTask(page, "Create wallet");

  await expect(page.getByText("Write this down")).toBeVisible({ timeout: SLOW });
  const cells = page.locator("span").filter({ hasText: /^\d+\.\s\w+\s*$/ });
  // Not 48, and not 12: two creations racing could leave either.
  await expect(cells).toHaveCount(24);
  const phrase = (await cells.allInnerTexts())
    .map((c) => c.replace(/^\d+\.\s*/, "").trim())
    .join(" ");

  await page.getByRole("button", { name: "I have written it down" }).click();
  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: SLOW });
  const address = await receiveAddress(page);

  // The assertion that matters, and the reason this test is worth its cost:
  // the words the user wrote down have to open the vault that was KEPT. A
  // second creation that replaced the seed after the first one's words were
  // rendered would leave the user holding a phrase for a wallet that no longer
  // exists, and nothing on screen would say so.
  const second = await launchWallet();
  try {
    const other = second.popup;
    await other.getByRole("button", { name: "I have a recovery phrase" }).click();
    await other.getByLabel("Recovery phrase").fill(phrase);
    await other.getByLabel("New password", { exact: true }).fill(PASSWORD);
    await other.getByRole("button", { name: "Import wallet" }).click();
    await expect(other.getByText("PUBLIC POCKET")).toBeVisible({ timeout: SLOW });
    expect(
      await receiveAddress(other),
      "the phrase shown at backup must restore the account this device kept",
    ).toBe(address);
  } finally {
    await second.close();
  }
});

test("unlocking twice in one gesture unlocks once and reports nothing wrong", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByText(/Locked\. Enter your password/)).toBeVisible();

  await page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await clickTwiceInOneTask(page, "Unlock");

  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: SLOW });
  // A second unlock racing the first must not surface as a failure to the
  // person who pressed the button once too often.
  await expect(page.getByText("Wrong password.")).toBeHidden();
  await expect(page.getByText(/check your connection/i)).toBeHidden();
});

test("importing twice in one gesture leaves one wallet, not an existing-wallet error", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  const phrase = `${"abandon ".repeat(23)}art`;

  await page.getByRole("button", { name: "I have a recovery phrase" }).click();
  await page.getByLabel("Recovery phrase").fill(phrase);
  await page.getByLabel("New password", { exact: true }).fill(PASSWORD);

  await clickTwiceInOneTask(page, "Import wallet");

  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: SLOW });
  // The second import is refused by design (`WalletExistsError`), and being
  // told so after successfully importing is the wallet reporting its own
  // internal race to the user.
  await expect(page.getByText(/wallet already exists/i)).toBeHidden();

  // And the account installed is the right one. This is what makes the test
  // falsifiable at all: two imports of the SAME phrase are idempotent by
  // construction, so without an oracle the assertions above pass whatever the
  // race does. The address is SEP-0005 m/44'/148'/0' for the BIP-39 all-zero
  // 24-word vector, computed from the published standards (PBKDF2-HMAC-SHA512
  // then SLIP-0010) rather than from this wallet's own derivation.
  expect(await receiveAddress(page), "the imported account must be the phrase's account").toBe(
    "GB3TCCIC6KLYKM72PX7KA6RNYC2BHC7DQYDMEAAN7PDMUZQD7UKJGSSY",
  );
});

test("confirming a payment twice in one gesture sends it once and shows the receipt", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  const from = await receiveAddress(page);
  const to = Keypair.random().publicKey();
  // BOTH ends funded. A classic PaymentOp to an account that does not exist
  // fails on chain with op_no_destination, and Horizon lists only successful
  // operations, so an unfunded recipient makes "no payment happened" and "the
  // payment failed" look identical and the test would report the wrong thing.
  await Promise.all([fund(from), fund(to)]);

  await compose(page, { to, amount: "1.5" });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");

  await clickTwiceInOneTask(page, "Confirm and send");

  // Wait for the wallet to STOP working, whatever it settles on. Waiting for
  // the receipt alone would report this as a timeout on an anonymous locator
  // and hide what the user was actually left looking at.
  await expect
    .poll(
      async () => {
        const body = await page.locator("body").innerText();
        return body.includes("Submitting and waiting") ? "working" : "settled";
      },
      { timeout: SLOW * 5, message: "the wallet never finished submitting" },
    )
    .toBe("settled");

  // What the user is left looking at, quoted into every failure below so this
  // never fails as an anonymous timeout.
  const body = await page.locator("body").innerText();

  // The ledger is the oracle for how many payments happened. Given a bounded
  // wait, because Horizon indexes a closed ledger a moment after the wallet
  // hears about it, and a race here would read zero and call it a bug.
  const mine = (ops: { type: string; to?: string }[]) =>
    ops.filter((o) => o.type === "payment" && o.to === to);
  const ops = await waitFor(
    () => payments(from, 50),
    (o) => mine(o).length > 0,
    `a payment to ${to} to appear on the ledger. The screen says: ${body}`,
    { timeoutMs: 60_000 },
  ).catch(() => [] as Awaited<ReturnType<typeof payments>>);

  expect(mine(ops), `a double click must send exactly once. The screen says: ${body}`).toHaveLength(
    1,
  );

  // And the screen must be the receipt. A second confirm that fails with
  // "build it again and review it" AFTER the money has left is worse than the
  // duplicate it prevented: it hides the hash and invites the user to send the
  // same payment a second time by hand.
  expect(
    body,
    "a payment that succeeded must not be described as needing to be built again",
  ).not.toContain("Build it again and review it.");
  expect(body, "the receipt must survive the second click").toContain("Sent");
});

test("erasing and restoring twice in one gesture restores once", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  const phrase = await onboard(page);
  const address = await receiveAddress(page);

  await page.getByRole("button", { name: "Lock" }).click();
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await page.getByRole("button", { name: "I understand, continue" }).click();
  await page.getByLabel(/Recovery phrase/).fill(phrase);
  await page.getByLabel("New password", { exact: true }).fill("a-different-password");
  await page.getByLabel("Confirm new password").fill("a-different-password");

  await clickTwiceInOneTask(page, "Erase and restore");

  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: SLOW * 2 });
  // Same account, and the new password opens it. A second erase landing after
  // the first restore would leave a vault the new password does not match, or
  // no vault at all.
  expect(await receiveAddress(page)).toBe(address);
  await page.getByRole("button", { name: "Lock" }).click();
  await page.getByLabel("Password", { exact: true }).fill("a-different-password");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: SLOW });
});
