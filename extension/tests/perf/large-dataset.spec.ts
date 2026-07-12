// The largest dataset this product actually reads.
//
// There is no transaction list, no table and no pagination in this popup, so
// the usual long-list questions have nothing to point at. The real large-data
// path is `core/inbound.ts`: when a confidential transfer arrives, the wallet
// has to find it by scanning Soroban RPC's whole retained event window, which
// is about 120,960 ledgers, paginated. The code's own comment records 41 pages
// covering the retained window against the live deployment, and it carries a
// 200-page budget as its only other exit.
//
// That scan runs INSIDE the "Reading the ledger" wait on the private pocket
// screen, so it is both the biggest read in the wallet and one of its longest
// waits. It only happens when there is actually something to find: the wallet
// short-circuits when its local record already agrees with the chain
// (`creditInboundTransfers`), so reaching this path costs a real transfer
// between two real wallets.
import { test, expect } from "../support/fixtures";
import { launchWallet } from "../support/extension";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { installProbe, arm, disarm, read, now, screens } from "./probe";

const PASSWORD = "a-strong-test-password";

/**
 * How long the inbound scan may take before it needs different feedback.
 *
 * Measured RPC latency against this deployment is 140-400ms per call, and the
 * scan is sequential, so a full-window scan is inherently seconds rather than
 * milliseconds. 45 seconds is deliberately generous: the point of the bound is
 * that the scan TERMINATES and the screen resolves, not that it is quick. A
 * scan that runs away hits the 200-page budget and would blow this.
 */
const MAX_SCAN_MS = 45_000;

/** The two waits this screen can show, spelled exactly as the user reads them. */
const PROGRESS = /(Reading the ledger|Starting…)/;

test("a received transfer is found by scanning the retained window, and the screen says so throughout", async ({
  wallet,
}) => {
  test.setTimeout(20 * 60_000);

  await wallet.createWallet(PASSWORD);
  const sender = await wallet.revealAddress();
  await ledger.fund(sender);

  const second = await launchWallet();
  try {
    const other = new Wallet(second.popup);
    await installProbe(other.page);
    await other.createWallet(PASSWORD);
    const recipient = await other.revealAddress();
    await ledger.fund(recipient);

    // Both sides need a pocket before either can use one.
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPrivatePocket();
    await wallet.registerPrivatePocket();

    await other.reopen();
    await other.waitForHome(WAITS.ledgerRead);
    await other.openPrivatePocket();
    await other.registerPrivatePocket();

    // Money in, then money across. The recipient knows nothing about either.
    await wallet.openOp("Shield");
    await wallet.page.getByLabel("Amount (XLM)").fill("25");
    await wallet.page.getByRole("button", { name: "Review" }).click();
    await wallet.approve();
    // the receipt is a sheet, and the bar it covers is how the next operation
    // is reached, so it is acknowledged before moving on.
    await expect(wallet.receipt()).toBeVisible({ timeout: WAITS.submission });
    await wallet.dismissReceipt();
    await expect(wallet.spendableMoney()).toHaveText(/^25\.0000000\s*XLM$/, {
      timeout: WAITS.submission,
    });

    await wallet.openOp("Send privately");
    await wallet.page.getByLabel("To", { exact: true }).fill(recipient);
    await wallet.page.getByLabel("Amount (XLM)").fill("5");
    await wallet.page.getByRole("button", { name: "Review" }).click();
    await wallet.approve();
    await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
      timeout: WAITS.submission,
    });
    await wallet.dismissReceipt();

    // Now the expensive read. The recipient's local record still says zero, so
    // the wallet has to go and find the transfer across the whole window.
    await other.page.bringToFront();
    await other.reopen();
    await other.waitForHome(WAITS.ledgerRead);
    await arm(other.page);
    const t0 = await now(other.page);
    await other.openPrivatePocket();
    await expect(other.page.getByRole("button", { name: "Private pocket" })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    const t1 = await now(other.page);
    const p = await read(other.page);
    await disarm(other.page);

    // The scan actually found the money. Without this the timing below would be
    // a measurement of the wallet giving up quickly.
    await expect(other.receivingMoney()).toHaveText(/^5\.0000000\s*XLM$/, {
      // a retained-window scan, not a balance read.
      timeout: WAITS.proving,
    });

    console.log(`  inbound scan of the retained window: ${(t1 - t0).toFixed(0)}ms`);
    expect(t1 - t0, "the retained-window scan must terminate").toBeLessThan(MAX_SCAN_MS);

    // And every moment of it must have been named. This is the same rule as the
    // proving wait, applied to the biggest read in the product.
    //
    // A scan that finishes inside a frame has no moment to name, and that is a
    // faster product rather than a silent one: with the archive current the
    // read no longer walks the retained window at all. So the requirement is
    // conditional on there having been a wait, and the case is recorded rather
    // than passed over, because "no samples" would otherwise be a green test
    // that checked nothing.
    const waiting = screens(p.samples).slice(0, -1);
    if (waiting.length === 0) {
      console.log(`  the scan finished in ${(t1 - t0).toFixed(0)}ms, so there was no wait to name`);
      expect(
        t1 - t0,
        "a scan with nothing to narrate has to have been genuinely instant",
      ).toBeLessThan(1_000);
    }
    for (const s of waiting) {
      expect(
        s.text,
        `the screen said nothing about being busy for ${Math.round(s.to - s.from)}ms`,
      ).toMatch(PROGRESS);
    }
  } finally {
    await second.close();
  }
});
