// Every primary flow, completed without a pointer.
//
// Nothing in this file calls `.click()`. That restriction is the test: a flow
// driven by clicks proves the handlers work, and only a flow driven by Tab,
// Enter and typing proves a keyboard user can finish it. A wallet that cannot
// be operated from the keyboard cannot be operated by a screen-reader user
// either, since that is how they drive it.
//
// The rebuild moved every operation into a bottom sheet, which raises a
// question a screen swap never had to answer: when a dialog opens over a screen
// that stays in the DOM, where does focus go, and can it get back out. Both are
// asserted here rather than assumed.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { tabTo, tabOrder, focused } from "../support/a11y";

const PASSWORD = "a-strong-test-password";

/** Is the focused element inside the open dialog? */
async function focusInsideDialog(page: import("@playwright/test").Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLElement && el.closest('[role="dialog"]') !== null;
  });
}

test("a wallet can be created with the keyboard alone", async ({ wallet }) => {
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });

  expect(await tabTo(wallet.page, "Create a new wallet")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByLabel("Confirm password")).toBeVisible();

  // The password field takes focus on arrival, which is the right behaviour for
  // a screen whose only purpose is that field, so typing starts immediately.
  expect((await focused(wallet.page)).tag, "the password field must take focus").toBe("INPUT");
  await wallet.page.keyboard.type(PASSWORD);
  await wallet.page.keyboard.press("Tab");
  await wallet.page.keyboard.type(PASSWORD);

  expect(await tabTo(wallet.page, "Create wallet")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByText("Save your recovery phrase")).toBeVisible({
    timeout: WAITS.onboarding,
  });

  // The words start hidden, so the keyboard path has to reach the reveal first.
  // That is the point of the check: nothing can be acknowledged unseen.
  expect(await tabTo(wallet.page, "Show the phrase")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  const phrase = await wallet.readBackupPhrase();

  expect(await tabTo(wallet.page, "I have written it down")).toBe(true);
  await wallet.page.keyboard.press("Enter");

  // And the three-word check is answerable without a pointer.
  await expect(wallet.page.getByText("Check what you wrote")).toBeVisible();
  expect((await focused(wallet.page)).tag, "the first word field must take focus").toBe("INPUT");
  await wallet.answerBackupCheck(phrase);
  await wallet.waitForHome(WAITS.ledgerRead);
});

test("a locked wallet can be unlocked with the keyboard alone", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  expect(await tabTo(wallet.page, "Lock")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.lockedNotice()).toBeVisible();

  expect((await focused(wallet.page)).tag, "the password field must take focus").toBe("INPUT");
  await wallet.page.keyboard.type(PASSWORD);
  // The unlock form submits on Enter, which is what a keyboard user expects of
  // a single-field form and saves a Tab to reach the button.
  await wallet.page.keyboard.press("Enter");
  await wallet.waitForHome(WAITS.ledgerRead);
});

test("a payment can be composed and reviewed with the keyboard alone", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  await ledger.fund(await wallet.revealAddress());
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  expect(await tabTo(wallet.page, "Send")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByRole("dialog", { name: "Send" })).toBeVisible();

  // The sheet takes focus, so the first keystroke after opening it goes into
  // the form rather than somewhere on the screen underneath.
  expect(
    await focusInsideDialog(wallet.page),
    "opening the send sheet left focus outside the dialog",
  ).toBe(true);
  await wallet.page.keyboard.type("GBHEDQ5XUXCWK5I32NVDSGAL6BIX2X7DUWQYC2MLXV27N44JLDQFGT73");
  await wallet.page.keyboard.press("Tab");
  await wallet.page.keyboard.type("2");

  expect(await tabTo(wallet.page, "Review")).toBe(true);
  await wallet.page.keyboard.press("Enter");

  const dialog = wallet.page.getByRole("dialog", { name: "Send" });
  await expect(dialog.getByText("Sending", { exact: true })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  // Reaching the signature is the point: an approval screen a keyboard user
  // cannot activate is an approval they cannot give.
  expect(await tabTo(wallet.page, "Confirm")).toBe(true);
});

test("the private pocket can be opened and its set-up reached with the keyboard alone", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  await ledger.fund(await wallet.revealAddress());
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  // The pocket is a tab now, not a screen, so opening it is one press on the
  // home screen rather than a navigation.
  expect(await tabTo(wallet.page, "Private")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByText("Not open yet").first()).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // Set-up itself lives in the Move sheet, reached from the prompt.
  expect(await tabTo(wallet.page, "Set up")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByRole("dialog", { name: "Move" })).toBeVisible();
  expect(await tabTo(wallet.page, "Set up the private pocket")).toBe(true);
});

test("opening a sheet moves focus into it", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  // A sheet is `aria-modal="true"`, which tells assistive technology that
  // everything behind it is inert. Focus has to follow that promise: left where
  // it was, the next Tab walks controls the screen reader has been told do not
  // exist, and the user is operating a screen they cannot hear.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const stranded: string[] = [];
  const sheets: { name: string; nav: "Receive" | "Send" | "Move" }[] = [
    { name: "Receive", nav: "Receive" },
    { name: "Send", nav: "Send" },
    { name: "Move", nav: "Move" },
  ];
  for (const sheet of sheets) {
    expect(await tabTo(wallet.page, sheet.nav)).toBe(true);
    await wallet.page.keyboard.press("Enter");
    await expect(wallet.page.getByRole("dialog", { name: sheet.name })).toBeVisible();
    if (!(await focusInsideDialog(wallet.page))) {
      stranded.push(`${sheet.name} (focus stayed on ${(await focused(wallet.page)).text})`);
    }
    await wallet.page.keyboard.press("Escape");
    await expect(wallet.page.getByRole("dialog", { name: sheet.name })).toHaveCount(0);
  }

  expect(stranded, `sheets that opened without taking focus: ${stranded.join(", ")}`).toEqual([]);
});

test("focus order follows the order things are read on the home screen", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const order = await tabOrder(wallet.page, 5);
  // The header's three controls in the order they are drawn, then the pocket
  // tabs. A tab order that jumps is a tab order that strands somebody mid-form.
  expect(order).toEqual([
    "BUTTON:Copy address",
    "BUTTON:Refresh",
    "BUTTON:Lock",
    "BUTTON:Public",
    "BUTTON:Private",
  ]);
});

test("the bottom bar is reachable by keyboard, in the order it is drawn", async ({ wallet }) => {
  // The bar is the only way to Send, Receive or Move, and every one of its
  // controls is an icon with its name only in `aria-label`. If Tab cannot reach
  // them the wallet has no keyboard-operable actions at all.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const order = await tabOrder(wallet.page, 12);
  const bar = order.map((o) => o.replace(/^BUTTON:/, ""));
  const at = (name: string) => bar.indexOf(name);
  for (const name of ["Home", "Receive", "Send", "Move", "Settings"]) {
    expect(
      at(name),
      `the bar's ${name} control is not reachable by Tab: ${bar.join(" -> ")}`,
    ).toBeGreaterThanOrEqual(0);
  }
  expect(
    [at("Home"), at("Receive"), at("Send"), at("Move"), at("Settings")],
    "the bar's controls are not tabbed in the order they are drawn",
  ).toEqual([at("Home"), at("Home") + 1, at("Home") + 2, at("Home") + 3, at("Home") + 4]);
});
