// The private pocket, driven the way a person drives it, against live testnet.
//
// Real proving in the offscreen document, real transactions, real contracts.
// Nothing is stubbed and nothing is simulated in place of a submission.
//
// It is one long test on purpose. Every step needs the previous one to have
// LANDED ON CHAIN: you cannot send privately without a spendable balance, and
// you cannot have one without registering and shielding first. Splitting that
// into five specs would mean five specs sharing state, which is worse than one
// spec that owns its own.
import { test, expect } from "../support/fixtures";
import { launchWallet, askWorker } from "../support/extension";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { auditorOwner, DEPLOYMENT } from "../support/soroban";

const PASSWORD = "a-strong-test-password";

test("a funded account that has not set up a private pocket says so, and states the permanent facts first", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);

  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  // The entry point says what it is offering before it is opened.
  await expect(wallet.page.getByText("PRIVATE POCKET", { exact: true })).toBeVisible();
  await expect(wallet.page.getByText(/Hides amounts, never addresses/)).toBeVisible();

  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Not set up yet")).toBeVisible({ timeout: WAITS.ledgerRead });

  // Three facts that are permanent or public, stated ABOVE the button that
  // commits to them, not in a confirmation afterwards.
  await expect(
    wallet.page.getByText(
      "Setting up is a public transaction. Anyone can see this account has one.",
    ),
  ).toBeVisible();
  await expect(wallet.page.getByText(/Only amounts are hidden/)).toBeVisible();
  await expect(wallet.page.getByText(/derived from your recovery phrase/)).toBeVisible();
  await expect(wallet.page.getByText(/cannot be changed later/)).toBeVisible();

  // And no balance is invented for a pocket that does not exist.
  await expect(wallet.money()).toHaveCount(0);
});

/**
 * These two are NOT ordered: either runs alone, in either order, and neither
 * reads anything the other wrote. They are kept off the same wall clock because
 * of a defect in the deployed auditor registry, not because of a dependency.
 *
 * `register` allocates its auditor id from a shared monotonic counter in the
 * contract's instance storage. Simulation computes the footprint for the id
 * that is free AT SIMULATION TIME, so if another account registers in between,
 * the invocation reaches for a ledger key it never declared and the host traps.
 * Observed on chain as invokeHostFunctionTrapped with the diagnostic "trying to
 * access contract data key outside of the footprint". See finding 2 in
 * _test/T1.md; delete this annotation to reproduce it.
 */
test.describe("private pocket operations", () => {
  test.describe.configure({ mode: "serial" });

  test("set up, move in, send privately, move out", async ({ wallet }) => {
    test.setTimeout(20 * 60_000);

    // ---------------------------------------------------------------- two wallets
    await wallet.createWallet(PASSWORD);
    const sender = await wallet.revealAddress();
    const senderStart = await ledger.fund(sender);
    console.log(`  sender    ${sender}`);

    const second = await launchWallet();
    try {
      const other = new Wallet(second.popup);
      await other.createWallet(PASSWORD);
      const recipient = await other.revealAddress();
      await ledger.fund(recipient);
      console.log(`  recipient ${recipient}`);

      // ------------------------------------------------------------------ register
      await wallet.reopen();
      await wallet.waitForHome(WAITS.ledgerRead);
      await wallet.openPrivatePocket();
      await expect(wallet.page.getByText("Not set up yet")).toBeVisible({
        timeout: WAITS.ledgerRead,
      });
      await wallet.page.getByRole("button", { name: "Set up the private pocket" }).click();

      // The approval screen enumerates every effect before anything is signed.
      await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
      await expect(wallet.page.getByText(/Bind your OWN auditor key/)).toBeVisible();
      await expect(wallet.page.getByText(/Nobody else can read your amounts/)).toBeVisible();
      await expect(
        wallet.page.getByText("This binding is permanent and cannot be changed for this account"),
      ).toBeVisible();
      await expect(wallet.page.getByText(/not reversible/)).toBeVisible();
      await wallet.page.getByRole("button", { name: "Approve" }).click();
      await expect(wallet.page.getByText(/Confirmed on the ledger/)).toBeVisible({
        timeout: WAITS.submission,
      });
      console.log("  registered");

      // A pocket that has just been created holds nothing, and says so with real
      // zeros read from its own openings rather than a placeholder.
      await expect(wallet.spendableMoney()).toHaveText(/^0\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      await expect(wallet.receivingMoney()).toHaveText(/^0\.0000000\s*XLM$/);

      // D8, checked against the registry rather than against the wallet's own
      // claim: the account must have bound ITS OWN auditor key. Id 0 on this
      // deployment is the deployer's, and the binding is permanent.
      const bound = await askWorker<{ auditorId?: number }>(wallet.page, { type: "privatePocket" });
      expect(bound.auditorId, "the pocket must report the auditor id it bound").toBeDefined();
      expect(bound.auditorId, "id 0 is the deployer's key").not.toBe(0);
      const owner = await auditorOwner(bound.auditorId!, sender);
      expect(owner, `auditor #${bound.auditorId} must be owned by the account itself`).toBe(sender);
      expect(owner).not.toBe(DEPLOYMENT.deployer);
      console.log(`  bound auditor #${bound.auditorId}, owned by this account`);

      // The recipient needs a pocket of its own before it can be paid privately.
      await other.reopen();
      await other.waitForHome(WAITS.ledgerRead);
      await other.openPrivatePocket();
      await other.registerPrivatePocket();
      console.log("  recipient registered");

      // -------------------------------------------------------------------- shield
      await wallet.openOp("Move in");
      await wallet.page.getByLabel("Amount (XLM)").fill("25");
      // The deposit amount is public. That has to be said before the review, not
      // discovered on the ledger afterwards.
      await expect(wallet.page.getByText(/This amount is public/)).toBeVisible();
      await wallet.page.getByRole("button", { name: "Review" }).click();

      await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
      await expect(
        wallet.page.getByText("Move 25.0000000 XLM from the public pocket into the private one"),
      ).toBeVisible();
      await expect(
        wallet.page.getByText(/This deposit amount is PUBLIC on the ledger/),
      ).toBeVisible();
      await wallet.page.getByRole("button", { name: "Approve" }).click();

      // A shield is two transactions: the deposit credits the receiving side, and
      // the merge that follows is what makes it spendable. Both are stated.
      await expect(wallet.page.getByText(/Made spendable in a second transaction/)).toBeVisible({
        timeout: WAITS.submission,
      });
      await expect(wallet.spendableMoney()).toHaveText(/^25\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      await expect(wallet.receivingMoney()).toHaveText(/^0\.0000000\s*XLM$/);
      console.log("  shielded 25 XLM");

      // ------------------------------------------------------------------ transfer
      await wallet.openOp("Send privately");
      await wallet.page.getByLabel("To", { exact: true }).fill(recipient);
      await wallet.page.getByLabel("Amount (XLM)").fill("5");
      await wallet.page.getByRole("button", { name: "Review" }).click();

      await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
      await expect(
        wallet.page.getByText("Send 5.0000000 XLM privately to this address"),
      ).toBeVisible();
      // The honest framing at the moment of signing: the amount is hidden, both
      // addresses are not, and that is permanent.
      await expect(
        wallet.page.getByText(
          "The AMOUNT is hidden. Both addresses are PUBLIC on the ledger, permanently",
        ),
      ).toBeVisible();
      // Never truncated at a confirm step.
      expect(await wallet.readAddress()).toBe(recipient);
      await wallet.page.getByRole("button", { name: "Approve" }).click();
      await expect(wallet.page.getByText(/Confirmed on the ledger/)).toBeVisible({
        timeout: WAITS.submission,
      });
      await expect(wallet.spendableMoney()).toHaveText(/^20\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      console.log("  sent 5 XLM privately");

      // ------------------------------------------------------------------ unshield
      await wallet.openOp("Move out");
      await wallet.page.getByLabel("Amount (XLM)").fill("10");
      await expect(wallet.page.getByText(/This amount becomes public/)).toBeVisible();
      await wallet.page.getByRole("button", { name: "Review" }).click();

      await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
      await expect(
        wallet.page.getByText("Move 10.0000000 XLM from the private pocket back to the public one"),
      ).toBeVisible();
      await expect(
        wallet.page.getByText("This withdrawal amount becomes PUBLIC on the ledger"),
      ).toBeVisible();
      await wallet.page.getByRole("button", { name: "Approve" }).click();
      await expect(wallet.page.getByText(/Confirmed on the ledger/)).toBeVisible({
        timeout: WAITS.submission,
      });
      await expect(wallet.spendableMoney()).toHaveText(/^10\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      console.log("  moved 10 XLM back out");

      // ------------------------------------------------------------- the ledger
      // Everything above is what the wallet SAYS. This is what happened.
      const txs = await ledger.transactions(sender, 200);
      expect(
        txs.every((t) => t.successful),
        "every transaction this wallet submitted must have succeeded",
      ).toBe(true);
      // register auditor, register, deposit, merge, transfer, unshield.
      expect(txs.length).toBeGreaterThanOrEqual(6);

      // Only the ones this account paid for. Friendbot's create-account is listed
      // here too, and friendbot paid that one.
      const fees = txs
        .filter((t) => t.fee_account === sender)
        .reduce((sum, t) => sum + Number(t.fee_charged) / 10_000_000, 0);
      const senderEnd = await ledger.nativeBalance(sender);
      // 25 XLM left the public balance and 10 came back, so the public account is
      // down by exactly 15 plus the fees the ledger itself charged. Any other
      // number means an amount was moved that no screen ever stated.
      expect(senderStart - senderEnd).toBeCloseTo(15 + fees, 5);
      console.log(
        `  ledger: ${txs.length} successful transactions, net -${(senderStart - senderEnd).toFixed(7)} XLM public (fees ${fees.toFixed(7)})`,
      );

      // The recipient paid its own fees and nothing else: a confidential transfer
      // moves no public XLM at either end.
      const recipientTxs = await ledger.transactions(recipient, 200);
      expect(recipientTxs.every((t) => t.successful)).toBe(true);
      const recipientFees = recipientTxs
        .filter((t) => t.fee_account === recipient)
        .reduce((sum, t) => sum + Number(t.fee_charged) / 10_000_000, 0);
      const recipientEnd = await ledger.nativeBalance(recipient);
      expect(ledger.FRIENDBOT_XLM - recipientEnd).toBeCloseTo(recipientFees, 5);
    } finally {
      await second.close();
    }
  });

  test("money received privately can be made spendable by the person who received it", async ({
    wallet,
  }) => {
    test.setTimeout(20 * 60_000);

    // The other half of a private transfer. The sending half is covered above;
    // this is the half that decides whether a private payment is a payment at
    // all. The receiving balance is the wallet's own promise: "Received funds sit
    // here until you make them spendable. One signature, no fee beyond the
    // network's."
    await wallet.createWallet(PASSWORD);
    const sender = await wallet.revealAddress();
    await ledger.fund(sender);

    const second = await launchWallet();
    try {
      const other = new Wallet(second.popup);
      await other.createWallet(PASSWORD);
      const recipient = await other.revealAddress();
      await ledger.fund(recipient);
      console.log(`  sender ${sender} -> recipient ${recipient}`);

      await wallet.reopen();
      await wallet.waitForHome(WAITS.ledgerRead);
      await wallet.openPrivatePocket();
      await wallet.registerPrivatePocket();

      await other.reopen();
      await other.waitForHome(WAITS.ledgerRead);
      await other.openPrivatePocket();
      await other.registerPrivatePocket();

      await wallet.openOp("Move in");
      await wallet.page.getByLabel("Amount (XLM)").fill("25");
      await wallet.page.getByRole("button", { name: "Review" }).click();
      await wallet.approve();
      await expect(wallet.page.getByText(/Made spendable in a second transaction/)).toBeVisible({
        timeout: WAITS.submission,
      });

      await wallet.openOp("Send privately");
      await wallet.page.getByLabel("To", { exact: true }).fill(recipient);
      await wallet.page.getByLabel("Amount (XLM)").fill("5");
      await wallet.page.getByRole("button", { name: "Review" }).click();
      await wallet.approve();
      await expect(wallet.page.getByText(/Confirmed on the ledger/)).toBeVisible({
        timeout: WAITS.submission,
      });
      // The sender's own spendable balance really did fall by five, so the money
      // has left. It is now somewhere, and the rest of this test is about whether
      // the person it was sent to can reach it.
      await expect(wallet.spendableMoney()).toHaveText(/^20\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      console.log("  sent 5 XLM privately");

      await other.reopen();
      await other.waitForHome(WAITS.ledgerRead);
      await other.openPrivatePocket();

      // The receiving side is where an inbound private payment lands, and the
      // word "pending" is deliberately not used for it: it resolves by signing,
      // not by waiting.
      await expect(other.receivingMoney()).toHaveText(/^5\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      await expect(other.spendableMoney()).toHaveText(/^0\.0000000\s*XLM$/);
      await expect(
        other.page.getByText(/Received funds sit here until you make them spendable/),
      ).toBeVisible();

      await other.page.getByRole("button", { name: "Make spendable" }).click();
      await expect(other.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
      await expect(
        other.page.getByText("Fold everything you have received into your spendable balance"),
      ).toBeVisible();
      await other.page.getByRole("button", { name: "Approve" }).click();
      await expect(other.page.getByText(/Confirmed on the ledger/)).toBeVisible({
        timeout: WAITS.submission,
      });

      await expect(other.spendableMoney()).toHaveText(/^5\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      await expect(other.receivingMoney()).toHaveText(/^0\.0000000\s*XLM$/);

      // And once it is spendable it can be spent, which is the only definition of
      // "received" that means anything.
      await other.openOp("Move out");
      await other.page.getByLabel("Amount (XLM)").fill("5");
      await other.page.getByRole("button", { name: "Review" }).click();
      await other.approve();
      await expect(other.page.getByText(/Confirmed on the ledger/)).toBeVisible({
        timeout: WAITS.submission,
      });
    } finally {
      await second.close();
    }
  });
});
