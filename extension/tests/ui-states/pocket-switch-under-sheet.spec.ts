// Switching pocket closes whatever compose form was open.
//
// Found while capturing motion frames: a sequence meant to film the pocket
// switch caught a Send sheet still on screen with its title reading "Send
// privately". Public and private sends are different transactions with
// different privacy properties and different fees, so a compose form that
// changes which one it is under someone mid-typing would be a real defect.
//
// It is not one. The sheet is torn down by the switch; what the frame caught
// was a sheet already in its 240ms exit, re-rendering with the incoming
// pocket's copy on its way out. This test pins the behaviour that makes that
// safe, because the safety is entirely in the teardown: if a future change kept
// the sheet mounted across a pocket switch, the frame I saw would become the
// real thing, and nothing else in the suite would notice.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";
const TO = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

test("switching pocket closes an open compose form rather than repurposing it", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Send", exact: true }).click();
  await expect(page.locator("[role='dialog']")).toHaveCount(1);
  await page.getByRole("textbox", { name: "To", exact: true }).fill(TO);
  await page.getByRole("textbox", { name: /Amount/ }).fill("1");

  await page.getByRole("button", { name: "Private pocket" }).click({ force: true });

  // Gone, not converted. `toHaveCount(0)` waits, so this also covers the exit
  // animation rather than racing it.
  await expect(
    page.locator("[role='dialog']"),
    "a compose form survived a pocket switch, which means it is now describing a different transaction than the one it was opened for",
  ).toHaveCount(0, { timeout: WAITS.ledgerRead });

  // And the draft does not come back with it. A fresh wallet has no private
  // pocket to send from, so the reachable half of the question is whether
  // coming back to the public one reopens a form still holding the old
  // recipient.
  await page.getByRole("button", { name: "Public pocket" }).click();
  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await page.getByRole("menuitem", { name: "Send", exact: true }).click();
  await expect(page.locator("[role='dialog']")).toHaveCount(1);
  const carried = await page.getByRole("textbox", { name: "To", exact: true }).inputValue();
  expect(
    carried,
    "the compose form reopened still holding what was typed before the pocket switch",
  ).toBe("");
});
