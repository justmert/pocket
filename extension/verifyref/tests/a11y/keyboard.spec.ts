// Every primary flow, completed without a pointer.
//
// Nothing in this file calls `.click()`. That restriction is the test: a flow
// driven by clicks proves the handlers work, and only a flow driven by Tab,
// Enter and typing proves a keyboard user can finish it. A wallet that cannot
// be operated from the keyboard cannot be operated by a screen-reader user
// either, since that is how they drive it.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { tabTo, tabOrder, focused } from "../support/a11y";

const PASSWORD = "a-strong-test-password";

test("a wallet can be created with the keyboard alone", async ({ wallet }) => {
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });

  expect(await tabTo(wallet.page, "Create a new wallet")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByLabel("Confirm password")).toBeVisible();

  // Tab into the first field and type, exactly as a keyboard user would.
  await wallet.page.keyboard.press("Tab");
  expect((await focused(wallet.page)).tag).toBe("INPUT");
  await wallet.page.keyboard.type(PASSWORD);
  await wallet.page.keyboard.press("Tab");
  await wallet.page.keyboard.type(PASSWORD);

  expect(await tabTo(wallet.page, "Create wallet")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByText("Write this down")).toBeVisible({
    timeout: WAITS.onboarding,
  });

  expect(await tabTo(wallet.page, "I have written it down")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await wallet.waitForHome(WAITS.ledgerRead);
});

test("a locked wallet can be unlocked with the keyboard alone", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  expect(await tabTo(wallet.page, "Lock")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.lockedNotice()).toBeVisible();

  await wallet.page.keyboard.press("Tab");
  expect((await focused(wallet.page)).tag).toBe("INPUT");
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
  await expect(wallet.page.getByLabel("Recipient")).toBeVisible();

  // Reach the first field by tabbing, not by knowing which press gets there.
  let atInput = false;
  for (let i = 0; i < 6 && !atInput; i++) {
    await wallet.page.keyboard.press("Tab");
    atInput = (await focused(wallet.page)).tag === "INPUT";
  }
  expect(atInput, "the recipient field must be reachable by Tab").toBe(true);
  await wallet.page.keyboard.type("GBHEDQ5XUXCWK5I32NVDSGAL6BIX2X7DUWQYC2MLXV27N44JLDQFGT73");
  await wallet.page.keyboard.press("Tab");
  await wallet.page.keyboard.type("2");

  expect(await tabTo(wallet.page, "Review")).toBe(true);
  await wallet.page.keyboard.press("Enter");

  await expect(wallet.page.getByText("Sending to")).toBeVisible({ timeout: WAITS.ledgerRead });
  // Reaching the signature is the point: an approval screen a keyboard user
  // cannot activate is an approval they cannot give.
  expect(await tabTo(wallet.page, "Confirm and send")).toBe(true);
});

test("the private pocket can be opened and its set-up reached with the keyboard alone", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  await ledger.fund(await wallet.revealAddress());
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  expect(await tabTo(wallet.page, "Set up private pocket")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByText("Not set up yet")).toBeVisible({ timeout: WAITS.ledgerRead });
  expect(await tabTo(wallet.page, "Set up the private pocket")).toBe(true);
});

test("focus order follows the order things are read on the home screen", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const order = await tabOrder(wallet.page, 5);
  const controls = order.filter((o) => o !== "(none)");
  // Lock sits in the header, then the two actions in reading order, then the
  // private pocket below them. A tab order that jumps is a tab order that
  // strands somebody mid-form.
  expect(controls.slice(0, 4)).toEqual([
    "BUTTON:Lock",
    "BUTTON:Send",
    "BUTTON:Receive",
    "BUTTON:Set up private pocket",
  ]);
});

test("changing screen does not strand focus outside the new screen", async ({ wallet }) => {
  // The popup replaces its whole tree rather than opening a modal, so there is
  // no focus trap to test. What there IS to test: after the swap, Tab must land
  // on the new screen's own controls rather than nothing at all.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  expect(await tabTo(wallet.page, "Send")).toBe(true);
  await wallet.page.keyboard.press("Enter");
  await expect(wallet.page.getByLabel("Recipient")).toBeVisible();

  const order = await tabOrder(wallet.page, 5);
  expect(
    order.some((o) => o.startsWith("INPUT")),
    `after the screen change, Tab reached: ${order.join(" -> ")}`,
  ).toBe(true);
  expect(order.filter((o) => o === "(none)").length).toBeLessThanOrEqual(1);
});
