// The private pocket, at the popup ceiling.
//
// The review step is the most content this wallet ever puts on one surface: a
// heading, an amount, a full untruncated 56-character address, a list of
// effects the worker wrote, and two buttons. It is also where a clipped button
// is worst, because the clipped one would be the one that signs and the user has
// already read everything above it.
//
// Nothing here is a snapshot or a prop. The pockets are registered on chain and
// the amounts are shielded for real, because the review step's height is a
// function of how many effects the WORKER decided to state, and a fixture would
// be measuring a string this file made up.
//
// What the rebuild moved:
//
//   The private pocket has no screen of its own. It is a tab on home, and every
//   operation lives in the Move sheet except spending, which is the bar's own
//   send action in both pockets. So a state's copy and the button that acts on
//   it are now in two different places, and both are checked.
//
//   `SPENDABLE` and `RECEIVING` are gone as labels. The spendable figure is the
//   hero and carries no label at all; the receiving figure is stated in a card
//   labelled `Receiving`, and only when there IS one. The old test asserted both
//   labels on a pocket that had just been registered, where the receiving
//   balance is zero and the card does not exist. The pairing it was really
//   about, a spendable balance shown without the receiving one underneath it,
//   is checked on the RECIPIENT after a real transfer lands, which is the only
//   place the two exist together.
//
// FINDING. Two stages below are red at EVERY viewport, both for one cause, and
// both are left red. Once a pocket has been switched, opening the send sheet
// leaves the whole popup scrolled 394px above its own window with no way to
// scroll it back.
//
//   `ui/App.tsx` renders the pocket-switch wash whenever `pocketFlip > 0`, and
//   `.pocket-wash` in `style.css` ends on `transform: scale(1.8)` with
//   `animation-fill-mode: forwards`. The element is never unmounted and the fill
//   holds the final frame, so from the first pocket switch onwards an invisible
//   1080x691 box sits inside a 600x384 frame whose overflow is `hidden`.
//   Measured: the frame's scrollHeight becomes 994 against a 600 clientHeight
//   and its scrollWidth 538 against 384.
//
//   `overflow: hidden` means no scrollbar, no wheel and no drag, but it does NOT
//   mean no scrolling: the browser still scrolls that box to reveal a focused
//   element. The send sheet autofocuses its `To` field, so opening it scrolls
//   the frame to its new maximum and every pixel of the sheet, the home screen
//   and the bar goes with it. Measured directly: frame scrollTop 0 before the
//   sheet, 394 after, and a wheel gesture over it changes nothing.
//
//   It is not confined to the private pocket. `pocketFlip` never returns to
//   zero, so switching back to the public pocket leaves the wash mounted and the
//   public send sheet in the same state.
import { test, expect } from "../support/fixtures";
import { launchWallet } from "../support/extension";
import { ADDRESS_RE, Wallet, WAITS, openMoveAction } from "../support/wallet";
import * as ledger from "../support/testnet";
import {
  amountBox,
  collectFailures,
  expectLayoutHolds,
  expectReachable,
  FRAME,
  REQUIRED_VIEWPORTS,
} from "./audit";

const PASSWORD = "a-strong-test-password";

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

/**
 * Open one of the operations that live in the Move sheet.
 *
 * `Wallet.openOp()` is not used, and this is the one place in this tier that
 * departs from the page object. It looks the row up with `exact: true`, and a
 * `Row` renders its subtitle inside the same button, so the accessible name of
 * the Move-in row is "Shield Public pocket to private" and an exact match finds
 * nothing. Reported; the substring match below is the same intent spelled
 * against what the row now renders.
 */
async function openMoveOp(wallet: Wallet, name: "Shield" | "Unshield"): Promise<void> {
  await wallet.openMove();
  await wallet.page.getByRole("button", { name }).click();
}

/** Put a sheet away and wait for it to be gone, not merely on its way out. */
async function closeSheet(wallet: Wallet): Promise<void> {
  await wallet.close();
  await expect(wallet.page.getByRole("dialog")).toHaveCount(0);
}

test("the unfunded and unregistered pockets keep their copy and their button on screen", async ({
  wallet,
}) => {
  test.setTimeout(8 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  // The receive sheet is modal, and the pocket tabs are behind it.
  await closeSheet(wallet);

  // Unfunded first: a state that costs nothing to reach and that a real user
  // meets before anything else.
  await wallet.openPrivatePocket();
  await expect(page.getByText("Fund first").first()).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await atEveryViewport(page, "private/unfunded", async () => {
    await expect(page.getByText(/Receive some XLM first/)).toBeVisible();
  });

  await ledger.fund(address);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await expect(page.getByText("Not open yet").first()).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // The facts that are permanent, public or COSTLY are stated ABOVE the button
  // that commits to them. That only protects anyone if they are on screen at the
  // same time as the button, which is precisely a layout property. They live in
  // the Move sheet now, with the button, so the pairing survived the rebuild.
  //
  // One of the old five is missing from this list on purpose. "It also pays a
  // network fee" is no longer part of the set-up copy; the fee is stated by the
  // worker as an effect, so it is asserted on the review step below, where it
  // now is.
  await page.setViewportSize(FRAME);
  await wallet.openMove();
  const bullets = [
    /sends the first one straight away/,
    /Setting up is public/,
    /Only amounts are hidden/,
    /bound permanently/,
  ];
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectLayoutHolds(page, `private/unregistered @ ${vp.name}`);
    for (const b of bullets) {
      await expectReachable(page.getByText(b), `private/unregistered @ ${vp.name}: ${b.source}`);
    }
    await expectReachable(
      page.getByRole("button", { name: "Set up the private pocket" }),
      `private/unregistered @ ${vp.name}: Set up the private pocket`,
    );
  }

  // The register review, reached without signing anything: the effects list is
  // written by the worker, so its height is the product's, not mine.
  await page.setViewportSize(FRAME);
  await openMoveAction(page, "Set up the private pocket");
  await expect(page.getByRole("button", { name: "What this does" })).toBeVisible({
    timeout: WAITS.proving,
  });

  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectLayoutHolds(page, `private/review (register) @ ${vp.name}`);
    const effects = page.locator("li");
    const n = await effects.count();
    expect(n, `private/review (register) @ ${vp.name}: the worker stated effects`).toBeGreaterThan(
      0,
    );
    for (let i = 0; i < n; i++) {
      await expectReachable(effects.nth(i), `private/review (register) @ ${vp.name}: effect ${i}`);
    }
    // The cost, in the one place it is stated. What is being paid for is
    // permanent, so what it costs has to be legible next to the button that
    // agrees to it.
    await expectReachable(
      page.getByText("Network fee", { exact: true }),
      `private/review (register) @ ${vp.name}: the network fee`,
    );
    await expectReachable(
      page.getByRole("button", { name: "Approve" }),
      `private/review (register) @ ${vp.name}: Approve`,
    );
    // not "Back": the first of the two transactions is already on the ledger by
    // the time this step renders, so the way out is a defer and not a cancel.
    await expectReachable(
      page.getByRole("button", { name: "Leave this for now" }),
      `private/review (register) @ ${vp.name}: the way out`,
    );
  }
});

test("a ready pocket, its three op forms and the transfer review all fit the popup", async ({
  wallet,
}) => {
  test.setTimeout(30 * 60_000);
  const page = wallet.page;

  await wallet.createWallet(PASSWORD);
  const sender = await wallet.revealAddress();
  await ledger.fund(sender);

  // A confidential transfer needs a REGISTERED recipient, so the review step
  // that carries a 56-character address cannot be reached with one wallet.
  const second = await launchWallet();
  try {
    const other = new Wallet(second.popup);
    const otherPage = second.popup;
    await other.createWallet(PASSWORD);
    const recipient = await other.revealAddress();
    await ledger.fund(recipient);
    expect(recipient).toMatch(ADDRESS_RE);

    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPrivatePocket();
    await wallet.registerPrivatePocket();

    await other.reopen();
    await other.waitForHome(WAITS.ledgerRead);
    await other.openPrivatePocket();
    await other.registerPrivatePocket();

    // Every stage below records what it found and the flow carries on regardless.
    // Two pockets were registered on chain to get here and real money is about
    // to be shielded and sent, so abandoning the last four stages because an
    // earlier one is a known defect throws away most of what the run paid for.
    const audit = collectFailures("private pocket");

    // ------------------------------------------------------------- ready, the hero
    await expect(wallet.spendableMoney()).toHaveText(/^0\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });
    await audit.check(async () => {
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await expectLayoutHolds(page, `private/ready @ ${vp.name}`);
        // Measured on the rendering, not on the figure the text match finds: the
        // exact ungrouped number lives in a visually hidden span and the thing a
        // person reads is its parent.
        await expectReachable(
          amountBox(wallet.spendableMoney()),
          `private/ready @ ${vp.name}: spendable`,
        );
        // The receiving figure is stated whether or not anything is in it.
        // Money that has arrived is not money that can be sent until it is made
        // spendable, and a screen that only names the second bucket once the
        // first is non-empty teaches that distinction at the worst moment.
        await expect(
          page.getByText("Receiving", { exact: true }),
          `private/ready @ ${vp.name}: the receiving balance is always stated`,
        ).toHaveCount(1);
      }
    });

    // --------------------------------------------------------------- the three forms
    //
    // The way out differs by sheet and both are checked as the way out: the Move
    // sheet's forms step back to its menu, and the send sheet's only way out is
    // the sheet's own Close. A form with no way out is the same defect either
    // way, which is why it is named rather than swept.
    for (const [op, title, wayOut] of [
      ["Shield", "Shielding", "Back"],
      ["Unshield", "Unshielding", "Back"],
      ["Send privately", "Send privately", "Close"],
    ] as const) {
      await page.setViewportSize(FRAME);
      if (op === "Send privately") {
        await wallet.nav("Send privately").click();
        await expect(page.getByLabel("To", { exact: true })).toBeVisible();
        await page.getByLabel("To", { exact: true }).fill(recipient);
      } else {
        await openMoveOp(wallet, op);
      }
      await expect(page.getByRole("dialog", { name: title })).toBeVisible();
      await page.getByLabel("Amount (XLM)").fill("25");

      await audit.check(async () => {
        for (const vp of VIEWPORTS) {
          await page.setViewportSize({ width: vp.width, height: vp.height });
          await expectLayoutHolds(page, `private/form ${op} @ ${vp.name}`);
          await expectReachable(
            page.getByRole("button", { name: "Continue" }),
            `private/form ${op} @ ${vp.name}: Review`,
          );
          await expectReachable(
            page.getByRole("button", { name: wayOut, exact: true }),
            `private/form ${op} @ ${vp.name}: ${wayOut}`,
          );
        }
      });
      await page.setViewportSize(FRAME);
      await closeSheet(wallet);
    }

    // --------------------------------------------------------------- shield, for real
    await openMoveOp(wallet, "Shield");
    await wallet.submitOp({ amount: "25" });
    await wallet.approve();
    await expect(wallet.receipt()).toBeVisible({ timeout: WAITS.submission });

    // The receipt, in the sheet it happened in: the confirmation line, the
    // Transaction ID row (its copy control), and the way out. the hash itself is
    // no longer printed as a block; it is copied from the row and read from the
    // a11y tree, so what has to stay reachable is the confirmation and Done.
    await audit.check(async () => {
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await expectLayoutHolds(page, `private/receipt @ ${vp.name}`);
        await expectReachable(wallet.receipt(), `private/receipt @ ${vp.name}: the confirmation`);
        await expectReachable(
          page.getByText("Transaction ID", { exact: true }),
          `private/receipt @ ${vp.name}: the transaction id row`,
        );
        await expectReachable(
          page.getByRole("button", { name: "Done" }),
          `private/receipt @ ${vp.name}: Done`,
        );
      }
    });

    await page.setViewportSize(FRAME);
    await page.getByRole("button", { name: "Done" }).click();
    await expect(wallet.spendableMoney()).toHaveText(/^25\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });

    // ----------------------------------- THE review step: address + effects + 2
    await page.setViewportSize(FRAME);
    await wallet.nav("Send privately").click();
    await expect(page.getByLabel("To", { exact: true })).toBeVisible();
    await wallet.submitOp({ to: recipient, amount: "5" });
    await expect(page.getByRole("button", { name: "What this does" })).toBeVisible({
      timeout: WAITS.proving,
    });

    await audit.check(async () => {
      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await expectLayoutHolds(page, `private/review (transfer) @ ${vp.name}`);

        // The address is the reason this step exists. It is never truncated by
        // design, so at every viewport it must WRAP inside the frame and still
        // read back as all 56 characters.
        const shown = page.getByText(ADDRESS_RE).first();
        await expectReachable(shown, `private/review (transfer) @ ${vp.name}: the address`);
        expect(
          (await shown.innerText()).replace(/\s/g, ""),
          `private/review (transfer) @ ${vp.name}: all 56 characters, unclipped`,
        ).toBe(recipient);

        const effects = page.locator("li");
        const n = await effects.count();
        expect(n, `private/review (transfer) @ ${vp.name}: effects stated`).toBeGreaterThan(0);
        for (let i = 0; i < n; i++) {
          await expectReachable(
            effects.nth(i),
            `private/review (transfer) @ ${vp.name}: effect ${i}`,
          );
        }
        await expectReachable(
          page.getByRole("button", { name: "Confirm" }),
          `private/review (transfer) @ ${vp.name}: Confirm`,
        );
        await expectReachable(
          page.getByRole("button", { name: "Back" }),
          `private/review (transfer) @ ${vp.name}: Back`,
        );
      }
    });

    // ------------------------------------------------ the two balances, together
    //
    // Sent for real, because this is the only way to produce the state the
    // two-balance layout exists for. Money that has ARRIVED is not money that
    // can be sent until it is merged, and a spendable figure shown without the
    // receiving one underneath it is exactly the "why can't I send my own
    // money" that separating them prevents. So both have to be on screen at
    // once, which is a layout property, and it is checked on the recipient
    // because the recipient is who has both.
    await page.setViewportSize(FRAME);
    await page.getByRole("button", { name: "Confirm" }).click();
    await expect(wallet.receipt()).toBeVisible({ timeout: WAITS.submission });

    await other.reopen();
    await other.waitForHome(WAITS.ledgerRead);
    await other.openPrivatePocket();
    await expect(otherPage.getByText("Receiving", { exact: true })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });

    await audit.check(async () => {
      for (const vp of VIEWPORTS) {
        await otherPage.setViewportSize({ width: vp.width, height: vp.height });
        await expectLayoutHolds(otherPage, `private/receiving @ ${vp.name}`);
        await expectReachable(
          amountBox(other.spendableMoney()),
          `private/receiving @ ${vp.name}: spendable`,
        );
        await expectReachable(
          otherPage.getByText("Receiving", { exact: true }),
          `private/receiving @ ${vp.name}: the Receiving label`,
        );
        await expectReachable(
          amountBox(other.receivingMoney()),
          `private/receiving @ ${vp.name}: receiving`,
        );
      }
    });

    audit.report();
  } finally {
    await second.close();
  }
});
