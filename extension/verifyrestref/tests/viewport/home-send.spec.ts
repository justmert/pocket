// Home and Send, with real money on a real ledger, at the popup ceiling.
//
// Send's confirm screen is the second-most content the wallet ever shows at
// once: a full untruncated 56-character address, an amount, a memo block, a
// list of effects and two buttons. Confirm is also the screen where a control
// out of reach is worst, because the two buttons are "Confirm and send" and
// "Back" and the user has already decided.
import { test, expect } from "../support/fixtures";
import { ADDRESS_RE, WAITS } from "../support/wallet";
import { fund } from "../support/testnet";
import { hang, offline, RPC_HOST } from "../support/stub";
import { expectLayoutHolds, expectReachable, FRAME, REQUIRED_VIEWPORTS } from "./audit";

const PASSWORD = "a-strong-test-password";

/**
 * Stellar's text memo limit is 28 BYTES, so this is the longest memo the
 * product accepts, and it carries no space, which is the case that actually
 * threatens a layout: a run with no break opportunity in it.
 */
const LONGEST_MEMO = "ZQXJ7WMKB4TVND2HRCPYFGS3".padEnd(28, "L");

const VIEWPORTS = REQUIRED_VIEWPORTS;

async function atEveryViewport(
  page: import("@playwright/test").Page,
  screen: string,
  settle: () => Promise<void>,
): Promise<void> {
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await settle();
    await expectLayoutHolds(page, `${screen} @ ${vp.name}`);
  }
}

test("a funded home keeps both actions, the reserve line and the private section on screen", async ({
  wallet,
}) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  expect(address).toMatch(ADDRESS_RE);
  await fund(address);
  await wallet.reopen();
  await wallet.waitForHome();

  // The loaded home: hero balance, the reserve caption, Send and Receive, and
  // the private pocket section underneath it.
  await expect(page.getByText(/locked by the network as a reserve/)).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await expect(page.getByText("PRIVATE POCKET", { exact: true })).toBeVisible();

  await atEveryViewport(page, "home/loaded", async () => {
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeAttached();
  });

  // With the receive address expanded, which is the tallest the home screen
  // gets: a 56-character address block pushes the private pocket section down.
  await page.setViewportSize(FRAME);
  await page.getByRole("button", { name: "Receive" }).click();
  await expect(page.getByText("Your address")).toBeVisible();

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectLayoutHolds(page, `home/loaded + receive @ ${vp.name}`);
    // The address is the point of the screen. Truncating it is not an option
    // here by design, so it has to WRAP inside the frame rather than run past
    // it, and every character has to be legible.
    const block = page.getByText(ADDRESS_RE).first();
    await expectReachable(block, `home/receive @ ${vp.name}: the address block`);
    expect(
      (await block.innerText()).replace(/\s/g, ""),
      `home/receive @ ${vp.name}: the full 56-character address`,
    ).toBe(address);
  }
});

test("the confirm screen shows a full address, the longest memo and both buttons, all reachable", async ({
  wallet,
}) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await fund(address);
  await wallet.reopen();
  await wallet.waitForHome();

  await wallet.openSend();
  await atEveryViewport(page, "send/compose", async () => {
    await expect(page.getByLabel("Recipient")).toBeAttached();
  });

  await page.setViewportSize(FRAME);
  // Paying itself: a real, valid, funded 56-character destination, without a
  // second browser and without moving money anywhere it cannot be checked.
  await wallet.composePayment({ to: address, amount: "1.5", memo: LONGEST_MEMO });
  await expect(page.getByText("Sending to")).toBeVisible({ timeout: WAITS.ledgerRead });

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectLayoutHolds(page, `send/confirm @ ${vp.name}`);

    // Named individually, because a sweep over "every visible control" would
    // pass on a screen whose address block had been silently clipped: the block
    // is not a control.
    const shown = page.getByText(ADDRESS_RE).first();
    await expectReachable(shown, `send/confirm @ ${vp.name}: the recipient address`);
    expect(
      (await shown.innerText()).replace(/\s/g, ""),
      `send/confirm @ ${vp.name}: the address is complete, not clipped to a prefix`,
    ).toBe(address);

    // `exact` because the memo is stated twice on this screen, once as the
    // reviewable block and once inside the effects list.
    const memo = page.getByText(LONGEST_MEMO, { exact: true });
    await expectReachable(memo, `send/confirm @ ${vp.name}: the memo`);
    expect(
      (await memo.innerText()).replace(/\s/g, ""),
      `send/confirm @ ${vp.name}: the memo is complete`,
    ).toBe(LONGEST_MEMO);

    await expectReachable(
      page.getByRole("button", { name: "Confirm and send" }),
      `send/confirm @ ${vp.name}: Confirm and send`,
    );
    await expectReachable(
      page.getByRole("button", { name: "Back" }),
      `send/confirm @ ${vp.name}: Back`,
    );
  }
});

test("the submitting wait stays on screen at every viewport", async ({ wallet, harness }) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await fund(address);
  await wallet.reopen();
  await wallet.waitForHome();
  await wallet.openSend();
  await wallet.composePayment({ to: address, amount: "1.5" });
  await expect(page.getByText("Sending to")).toBeVisible({ timeout: WAITS.ledgerRead });

  // Held open at the network boundary rather than raced against a real
  // submission: the request is never dispatched, so nothing is signed onto the
  // ledger and the screen sits in the state under test for as long as needed.
  await hang(harness.context, RPC_HOST);
  await page.getByRole("button", { name: "Confirm and send" }).click();
  await expect(page.getByText("Submitting and waiting for the ledger…")).toBeVisible();

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    const label = page.getByText("Submitting and waiting for the ledger…");
    await expectReachable(label, `send/sending @ ${vp.name}: the wait label`);
    await expectLayoutHolds(page, `send/sending @ ${vp.name}`);
  }
});

test("home reports a loading wait and an honest error inside the frame", async ({
  wallet,
  harness,
}) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await fund(address);

  // Loading: the ledger read held open, so the wait is a real one rather than a
  // frame captured mid-render.
  await hang(harness.context, RPC_HOST);
  await wallet.reopen();
  await wallet.waitForHome();
  await expect(page.getByText("Reading the ledger…")).toBeVisible();
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectReachable(
      page.getByText("Reading the ledger…"),
      `home/loading @ ${vp.name}: the wait label`,
    );
    await expectLayoutHolds(page, `home/loading @ ${vp.name}`);
  }

  // Error: refused outright, so the wallet reports what happened instead of a
  // fabricated zero. That notice is multi-line and it is what pushes the two
  // buttons down the screen.
  await offline(harness.context, RPC_HOST);
  await page.setViewportSize(FRAME);
  await wallet.reopen();
  await wallet.waitForHome();
  const notice = page.getByText(/Something went wrong|check your connection/i).first();
  await expect(notice).toBeVisible({ timeout: WAITS.ledgerRead });

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectLayoutHolds(page, `home/error @ ${vp.name}`);
    await expectReachable(notice, `home/error @ ${vp.name}: the error notice`);
    await expectReachable(
      page.getByRole("button", { name: "Send", exact: true }),
      `home/error @ ${vp.name}: Send`,
    );
  }
});
