// "Your money is there and you cannot spend it yet" is one shape.
//
// The direction document names this the product's signature problem: it happens
// in unrelated places, and presented differently in each, a user meeting one for
// the first time cannot tell "this is fine, one press fixes it" from "your money
// is gone". `ui/Held.tsx` is the answer, and these tests are what stops the
// surfaces drifting apart again.
//
// Driven by stubbing `privatePocket`, because reaching a dormant or diverged
// confidential account for real needs on-chain state this suite cannot create.
// The stub answers the message contract exactly as the worker does.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

async function stubPocket(page: Page, pocket: Record<string, unknown>): Promise<void> {
  await page.addInitScript((p) => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      if (msg?.type === "privatePocket") return { ok: true, data: p };
      if (msg?.type === "status") {
        const real = await send(msg);
        if (real?.ok) return { ok: true, data: { ...real.data, privateAvailable: true } };
        return real;
      }
      return send(msg);
    };
  }, pocket);
}

/**
 * the states that are all the same fact about the user's money.
 *
 * `where` is not incidental: the received-but-unmerged case is on Home because
 * the pocket is otherwise working, and the two broken ones are in the Move sheet
 * because that is where the thing that fixes them lives.
 */
const HELD = [
  {
    name: "received but not yet spendable",
    where: "home",
    pocket: { state: "ready", spendable: "5.0000000", receiving: "12.5000000" },
    label: "Receiving",
    figure: "12.5000000 XLM",
    control: /Make spendable/i,
  },
  {
    name: "dormant",
    where: "move",
    pocket: { state: "archived", spendable: "8.0000000", message: "This pocket went dormant." },
    label: "Dormant",
    figure: "8.0000000 XLM",
    control: /^Reactivate$/i,
  },
  {
    name: "needs rebuilding",
    where: "move",
    pocket: { state: "needsRecovery", message: "This device's record is behind the contract." },
    label: "Needs rebuilding",
    figure: null,
    control: /Rebuild from history/i,
  },
  {
    name: "out of step with the contract",
    where: "move",
    pocket: { state: "diverged", message: "This device disagrees with the contract." },
    label: "Out of step",
    figure: null,
    control: /Rebuild from history/i,
  },
] as const;

for (const state of HELD) {
  test(`held value, ${state.name}: names itself, its figure and its way out`, async ({ wallet }) => {
    test.setTimeout(4 * 60_000);
    const page = wallet.page;
    await stubPocket(page, state.pocket);
    await wallet.createWallet(PASSWORD);
    await page.reload();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPocket("Private pocket");
    if (state.where === "move") await wallet.openMove();

    // Scoped to the sheet where the card lives, because the screen behind it is
    // still in the DOM and offers its own prompt with some of the same words.
    const where = state.where === "move" ? page.locator("[role='dialog']") : page;

    await expect(
      where.getByText(state.label, { exact: false }).first(),
      "a held balance must say what is holding it, in the same word every time",
    ).toBeVisible({ timeout: WAITS.ledgerRead });

    if (state.figure !== null) {
      // Shown in full, never dimmed and never approximated. The exact node is
      // the visually hidden one, because the visible rendering is split.
      await expect(
        where.locator(`span:text-is("${state.figure}")`).first(),
        "the held figure must be on screen exactly, not rounded and not hidden",
      ).toBeAttached();
    } else {
      // Where the wallet cannot read it, it says so rather than drawing a zero.
      // A zero here would be a lie about the user's money.
      await expect(
        where.getByText(/not readable on this device yet/i),
        "an unreadable held balance must be stated, never rendered as a zero",
      ).toBeVisible();
      await expect(
        where.locator('span:text-is("0")'),
        "an unreadable held balance was drawn as a zero",
      ).toHaveCount(0);
    }

    await expect(where.getByRole("button", { name: state.control }).first()).toBeVisible();
  });
}

test("the held states share one shape, in one order", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await stubPocket(page, { state: "archived", spendable: "8.0000000" });
  await wallet.createWallet(PASSWORD);
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPocket("Private pocket");
  await wallet.openMove();

  // The point of one shape is that the parts sit in one order: what it is, what
  // it is worth, what is holding it, what releases it.
  const sheet = page.locator("[role='dialog']");
  await expect(sheet.getByText("Dormant").first()).toBeVisible({ timeout: WAITS.ledgerRead });
  const order = await page.evaluate(() => {
    const el = document.querySelector("[role='dialog']") as HTMLElement | null;
    const body = (el?.innerText ?? "").replace(/\s+/g, " ");
    return {
      label: body.indexOf("Dormant"),
      figure: body.indexOf("8"),
      holding: body.indexOf("went dormant from not being used"),
      control: body.indexOf("Reactivate"),
    };
  });
  expect(order.label, "the held state must name itself").toBeGreaterThanOrEqual(0);
  expect(order.holding, "the held state must say what is holding it").toBeGreaterThan(order.label);
  expect(order.control, "the control that releases it comes last").toBeGreaterThan(order.holding);
});
