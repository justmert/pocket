// The private pocket, at the popup ceiling.
//
// The review screen is the most content this wallet ever puts on one screen: a
// section label, an amount, a full untruncated 56-character address, a list of
// effects the worker wrote, and two buttons. It is also the screen where a
// clipped button is worst, because the clipped one would be Approve and the
// user has already read everything above it.
//
// Nothing here is a snapshot or a prop. The pockets are registered on chain and
// the amounts are shielded for real, because the review screen's height is a
// function of how many effects the WORKER decided to state, and a fixture would
// be measuring a string this file made up.
import { test, expect } from "../support/fixtures";
import { launchWallet } from "../support/extension";
import { ADDRESS_RE, Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { expectLayoutHolds, expectReachable, FRAME, REQUIRED_VIEWPORTS } from "./audit";

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

test("the unfunded and unregistered pockets keep their copy and their button on screen", async ({
  wallet,
}) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();

  // Unfunded first: a state that costs nothing to reach and that a real user
  // meets before anything else.
  await wallet.openPrivatePocket();
  await expect(page.getByText("Fund this account first")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await atEveryViewport(page, "private/unfunded", async () => {
    await expect(page.getByText(/Receive some XLM first/)).toBeVisible();
  });

  await ledger.fund(address);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await expect(page.getByText("Not set up yet")).toBeVisible({ timeout: WAITS.ledgerRead });

  // The three permanent facts are stated ABOVE the button that commits to them.
  // That only protects anyone if all three are on screen at the same time as
  // the button, which is precisely a layout property.
  const bullets = [
    /Setting up is a public transaction/,
    /Only amounts are hidden/,
    /cannot be changed later/,
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

  // The register review screen, reached without signing anything: the effects
  // list is written by the worker, so its height is the product's, not mine.
  await page.setViewportSize(FRAME);
  await page.getByRole("button", { name: "Set up the private pocket" }).click();
  await expect(page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

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
    await expectReachable(
      page.getByRole("button", { name: "Approve" }),
      `private/review (register) @ ${vp.name}: Approve`,
    );
    await expectReachable(
      page.getByRole("button", { name: "Cancel" }),
      `private/review (register) @ ${vp.name}: Cancel`,
    );
  }
});

test("a ready pocket, its three op forms and the transfer review all fit the popup", async ({
  wallet,
}) => {
  test.setTimeout(20 * 60_000);
  const page = wallet.page;

  await wallet.createWallet(PASSWORD);
  const sender = await wallet.revealAddress();
  await ledger.fund(sender);

  // A confidential transfer needs a REGISTERED recipient, so the review screen
  // that carries a 56-character address cannot be reached with one wallet.
  const second = await launchWallet();
  try {
    const other = new Wallet(second.popup);
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

    // ------------------------------------------------------- ready, both balances
    await expect(wallet.spendableMoney()).toHaveText(/^0\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await expectLayoutHolds(page, `private/ready @ ${vp.name}`);
      // Both balances, and the labels that distinguish them. A spendable
      // balance shown without the receiving one underneath is the exact
      // confusion the two-balance layout exists to prevent, so it is not enough
      // for the numbers to be "visible": both have to be on screen.
      await expectReachable(
        page.getByText("SPENDABLE", { exact: true }),
        `private/ready @ ${vp.name}: SPENDABLE`,
      );
      await expectReachable(wallet.spendableMoney(), `private/ready @ ${vp.name}: spendable`);
      await expectReachable(
        page.getByText("RECEIVING", { exact: true }),
        `private/ready @ ${vp.name}: RECEIVING`,
      );
      await expectReachable(wallet.receivingMoney(), `private/ready @ ${vp.name}: receiving`);
    }

    // ------------------------------------------------------------- the three forms
    for (const [op, heading] of [
      ["Move in", "Move into the private pocket"],
      ["Move out", "Move back to the public pocket"],
      ["Send privately", "Send privately"],
    ] as const) {
      await page.setViewportSize(FRAME);
      await wallet.openOp(op);
      await expect(page.getByText(heading, { exact: true })).toBeVisible();
      // The transfer form is the tall one: an address field on top of the
      // amount field, under two balances that stay on screen while it is open.
      if (op === "Send privately") await page.getByLabel("To", { exact: true }).fill(recipient);
      await page.getByLabel("Amount (XLM)").fill("25");

      for (const vp of VIEWPORTS) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await expectLayoutHolds(page, `private/form ${op} @ ${vp.name}`);
        await expectReachable(
          page.getByRole("button", { name: "Review" }),
          `private/form ${op} @ ${vp.name}: Review`,
        );
        await expectReachable(
          page.getByRole("button", { name: "Cancel" }),
          `private/form ${op} @ ${vp.name}: Cancel`,
        );
      }
      await page.setViewportSize(FRAME);
      await page.getByRole("button", { name: "Cancel" }).click();
    }

    // ------------------------------------------------------------- shield, for real
    await wallet.openOp("Move in");
    await wallet.submitOp({ amount: "25" });
    await wallet.approve();
    await expect(page.getByText(/Confirmed on the ledger/)).toBeVisible({
      timeout: WAITS.submission,
    });
    await expect(wallet.spendableMoney()).toHaveText(/^25\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });

    // A receipt notice, a 64-character hash block and the two balances all on
    // screen at once, which is the busiest the ready state gets.
    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await expectLayoutHolds(page, `private/ready + receipt @ ${vp.name}`);
      await expectReachable(
        page.getByText(/^[0-9a-f]{64}$/),
        `private/ready + receipt @ ${vp.name}: the transaction hash`,
      );
    }

    // ------------------------------------ THE review screen: address + effects + 2
    await page.setViewportSize(FRAME);
    await wallet.openOp("Send privately");
    await wallet.submitOp({ to: recipient, amount: "5" });
    await expect(page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

    for (const vp of VIEWPORTS) {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await expectLayoutHolds(page, `private/review (transfer) @ ${vp.name}`);

      // The address is the reason this screen exists. It is never truncated by
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
        page.getByRole("button", { name: "Approve" }),
        `private/review (transfer) @ ${vp.name}: Approve`,
      );
      await expectReachable(
        page.getByRole("button", { name: "Cancel" }),
        `private/review (transfer) @ ${vp.name}: Cancel`,
      );
    }
  } finally {
    await second.close();
  }
});
