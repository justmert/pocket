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
import { Wallet, WAITS, openMoveAction } from "../support/wallet";
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
  await expect(wallet.page.getByRole("button", { name: "Private pocket" })).toBeVisible();
  await expect(wallet.page.getByText(/Hides amounts, never addresses/)).toBeVisible();

  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({ timeout: WAITS.ledgerRead });

  // The disclosure lives with the button that commits to it, and that button
  // lives in the move sheet, so the sheet is what has to be open.
  await wallet.openMove();

  // Facts that are permanent, public, or COSTLY, stated ABOVE the button that
  // commits to them and not in a confirmation afterwards.
  //
  // The cost one is the newest and it is here because it was missing: pressing
  // this button submits a transaction and pays a fee before any review screen
  // exists, and the copy used to say "a public transaction", singular, which
  // read as though nothing happened until you approved something. The ordering
  // cannot be changed (the registry allocates the auditor id and returns it, so
  // the account-creation proof cannot be built until that registration lands),
  // so the disclosure has to carry it.
  await expect(wallet.page.getByText(/TWO transactions/)).toBeVisible();
  await expect(wallet.page.getByText(/sends the first one straight away/)).toBeVisible();
  await expect(wallet.page.getByText(/pays a network fee/)).toBeVisible();
  await expect(
    wallet.page.getByText("Setting up is public. Anyone can see this account has a private pocket."),
  ).toBeVisible();
  await expect(wallet.page.getByText(/Only amounts are hidden/)).toBeVisible();
  await expect(wallet.page.getByText(/derived from your recovery phrase/)).toBeVisible();
  await expect(wallet.page.getByText(/cannot be changed later/)).toBeVisible();

  // And no balance is invented for a pocket that does not exist.
  await expect(wallet.money()).toHaveCount(0);
});

/**
 * Independent, and run in parallel.
 *
 * They were pinned serial for a while because concurrent registrations trapped
 * on chain: `register` allocates its auditor id from a shared counter in the
 * registry's instance storage, so simulation pins a footprint for whichever id
 * is free at simulation time and the invocation later reaches for a ledger key
 * it never declared. `be74266` made the wallet retry, which recovers the flow,
 * so the pin came off.
 *
 * The retry does NOT make it free. The failed attempt still charges its fee and
 * still burns a sequence number, and the reconciliation below is what keeps that
 * cost visible: it counts failed transactions too, so a retried run shows up as
 * "7 successful, 1 failed" with the fee total to match rather than as a clean
 * run. Finding 2 in `_test/T1.md` is mitigated, not closed.
 */
test.describe("private pocket operations", () => {
  test.describe.configure({ mode: "parallel" });

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
      await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
        timeout: WAITS.ledgerRead,
      });
      await openMoveAction(wallet.page, "Set up the private pocket");

      // The approval screen enumerates every effect before anything is signed.
      await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
      await expect(wallet.page.getByText(/Bind your OWN auditor key/)).toBeVisible();
      await expect(wallet.page.getByText(/Nobody else can read your amounts/)).toBeVisible();
      await expect(
        wallet.page.getByText("This binding is permanent and cannot be changed for this account"),
      ).toBeVisible();
      await expect(wallet.page.getByText(/not reversible/)).toBeVisible();
      await wallet.page.getByRole("button", { name: "Approve" }).click();
      await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
        timeout: WAITS.submission,
      });
      await wallet.dismissReceipt();
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
      await wallet.openOp("Shield");
      await wallet.page.getByLabel("Amount (XLM)").fill("25");
      // The deposit amount is public. That has to be said before the review, not
      // discovered on the ledger afterwards.
      await expect(wallet.page.getByText(/This amount is public/)).toBeVisible();
      await wallet.page.getByRole("button", { name: "Continue" }).click();

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
      await wallet.dismissReceipt();
      await expect(wallet.spendableMoney()).toHaveText(/^25\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      await expect(wallet.receivingMoney()).toHaveText(/^0\.0000000\s*XLM$/);
      console.log("  shielded 25 XLM");

      // ------------------------------------------------------------------ transfer
      await wallet.openOp("Send privately");
      await wallet.page.getByLabel("To", { exact: true }).fill(recipient);
      await wallet.page.getByLabel("Amount (XLM)").fill("5");
      await wallet.page.getByRole("button", { name: "Continue" }).click();

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
      await wallet.page.getByRole("button", { name: "Confirm" }).click();
      await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
        timeout: WAITS.submission,
      });
      await wallet.dismissReceipt();
      await expect(wallet.spendableMoney()).toHaveText(/^20\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      console.log("  sent 5 XLM privately");

      // ------------------------------------------------------------------ unshield
      await wallet.openOp("Unshield");
      await wallet.page.getByLabel("Amount (XLM)").fill("10");
      await expect(wallet.page.getByText(/This amount becomes public/)).toBeVisible();
      await wallet.page.getByRole("button", { name: "Continue" }).click();

      await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
      await expect(
        wallet.page.getByText("Move 10.0000000 XLM from the private pocket back to the public one"),
      ).toBeVisible();
      await expect(
        wallet.page.getByText("This withdrawal amount becomes PUBLIC on the ledger"),
      ).toBeVisible();
      await wallet.page.getByRole("button", { name: "Approve" }).click();
      await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
        timeout: WAITS.submission,
      });
      await wallet.dismissReceipt();
      await expect(wallet.spendableMoney()).toHaveText(/^10\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      console.log("  moved 10 XLM back out");

      // ------------------------------------------------------------- the ledger
      // Everything above is what the wallet SAYS. This is what happened.
      //
      // `transactions` includes FAILED transactions. Asserting "every one
      // succeeded" against Horizon's default is vacuous, because the default
      // omits the failures, and a failed transaction still charges its fee. The
      // reconciliation below is the assertion that carries the weight, and it
      // only balances if every fee is counted.
      const txs = await ledger.transactions(sender, 200);
      // register auditor, register, deposit, merge, transfer, unshield.
      expect(txs.filter((t) => t.successful).length).toBeGreaterThanOrEqual(6);

      const fees = ledger.feesPaidBy(sender, txs);
      const senderEnd = await ledger.nativeBalance(sender);
      // 25 XLM left the public balance and 10 came back, so the public account is
      // down by exactly 15 plus every fee the ledger charged it, successful or
      // not. Any other number means an amount moved that no screen ever stated.
      expect(senderStart - senderEnd).toBeCloseTo(15 + fees, 5);

      // A retried operation is not a free one. Naming the failures keeps the
      // cost of finding 2 visible instead of hiding inside a fee total.
      const failed = txs.filter((t) => !t.successful);
      console.log(
        `  ledger: ${txs.filter((t) => t.successful).length} successful, ${failed.length} failed, ` +
          `net -${(senderStart - senderEnd).toFixed(7)} XLM public (fees ${fees.toFixed(7)})`,
      );

      // The recipient paid its own fees and nothing else: a confidential transfer
      // moves no public XLM at either end.
      const recipientTxs = await ledger.transactions(recipient, 200);
      const recipientEnd = await ledger.nativeBalance(recipient);
      expect(ledger.FRIENDBOT_XLM - recipientEnd).toBeCloseTo(
        ledger.feesPaidBy(recipient, recipientTxs),
        5,
      );
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

      await wallet.openOp("Shield");
      await wallet.page.getByLabel("Amount (XLM)").fill("25");
      await wallet.page.getByRole("button", { name: "Continue" }).click();
      await wallet.approve();
      await expect(wallet.page.getByText(/Made spendable in a second transaction/)).toBeVisible({
        timeout: WAITS.submission,
      });

      await wallet.openOp("Send privately");
      await wallet.page.getByLabel("To", { exact: true }).fill(recipient);
      await wallet.page.getByLabel("Amount (XLM)").fill("5");
      await wallet.page.getByRole("button", { name: "Continue" }).click();
      await wallet.approve();
      await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
        timeout: WAITS.submission,
      });
      await wallet.dismissReceipt();
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
      await expect(
        other.receivingMoney(),
        `the recipient's screen says: ${(await other.page.locator("body").innerText()).replace(/\n/g, " | ")}`,
        // a retained-window scan, not a balance read: this is the slow one.
      ).toHaveText(/^5\.0000000\s*XLM$/, { timeout: WAITS.proving });
      await expect(other.spendableMoney()).toHaveText(/^0\.0000000\s*XLM$/);
      await expect(
        other.page.getByText(/Received funds sit here until you make them spendable/),
      ).toBeVisible();

      await openMoveAction(other.page, "Make spendable");
      await expect(other.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
      await expect(
        other.page.getByText("Fold everything you have received into your spendable balance"),
      ).toBeVisible();
      await other.page.getByRole("button", { name: "Approve" }).click();
      await expect(other.page.getByText("Transaction successful")).toBeVisible({
        timeout: WAITS.submission,
      });
      await other.dismissReceipt();

      await expect(other.spendableMoney()).toHaveText(/^5\.0000000\s*XLM$/, {
        timeout: WAITS.ledgerRead,
      });
      await expect(other.receivingMoney()).toHaveText(/^0\.0000000\s*XLM$/);

      // And once it is spendable it can be spent, which is the only definition of
      // "received" that means anything.
      await other.openOp("Unshield");
      await other.page.getByLabel("Amount (XLM)").fill("5");
      await other.page.getByRole("button", { name: "Continue" }).click();
      await other.approve();
      await expect(other.page.getByText("Transaction successful")).toBeVisible({
        timeout: WAITS.submission,
      });
      await other.dismissReceipt();
    } finally {
      await second.close();
    }
  });
});
