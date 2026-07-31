// The X on a sheet has to close the sheet.
//
// Every sheet in the wallet is mounted as `onClose={w.closeSheet}`, and
// `closeSheet` is `(id?: SheetId)`: an optional id, so it can refuse to pop a
// sheet that is no longer the one on top. `Sheet` passed that function straight
// to the close button as `onClick={onClose}`, and React hands a click handler
// the EVENT as its first argument. So the X called `closeSheet(mouseEvent)`,
// the guard compared an event to a string, concluded this was not the top
// sheet, and returned the stack unchanged.
//
// The close button on every titled sheet in the wallet did nothing. It was
// invisible because the browser tier could not run: the one place this is
// observable is a real click in a real browser.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

test("the X closes the sheet, on every sheet that has one", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // Receive, from the bottom bar.
  await wallet.nav("Receive").click();
  await expect(page.getByRole("dialog", { name: "Receive" })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).last().click();
  await expect(page.getByRole("dialog"), "the Receive sheet's X did nothing").toHaveCount(0, {
    timeout: WAITS.ledgerRead,
  });

  // ...and a Settings sheet, which is a different mount of the same component.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: /Auto-lock/ })
    .first()
    .click();
  await expect(page.locator("[role='dialog']")).toHaveCount(1);
  await page.getByRole("button", { name: "Close" }).last().click();
  await expect(page.locator("[role='dialog']"), "the Auto-lock sheet's X did nothing").toHaveCount(
    0,
    { timeout: WAITS.ledgerRead },
  );
});

test("the backdrop closes it too", async ({ wallet }) => {
  // Same bug, same component, second call site: the backdrop's onClick had the
  // identical bare pass-through.
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // A SHORT sheet, so there is backdrop to click. Receive is full-height and
  // leaves none, which is why the X above is the only way out of that one.
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page
    .getByRole("button", { name: /Auto-lock/ })
    .first()
    .click();
  const sheet = page.locator("[role='dialog']");
  await expect(sheet).toHaveCount(1);
  const box = await sheet.boundingBox();
  expect(box!.y, "this sheet reaches the top of the frame, so it has no backdrop").toBeGreaterThan(
    40,
  );
  await page.mouse.click(box!.x + box!.width / 2, box!.y - 20);
  await expect(page.getByRole("dialog"), "the backdrop did nothing").toHaveCount(0, {
    timeout: WAITS.ledgerRead,
  });
});
