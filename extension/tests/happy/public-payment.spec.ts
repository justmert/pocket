// Receive and send, end to end, on live testnet.
//
// Two wallets in two Chromium profiles: one pays, one is paid. Every claim the
// UI makes is then checked against Horizon, which shares no code with the
// wallet's own read path, so a bug in that path cannot agree with itself.
import { test, expect } from "../support/fixtures";
import { launchWallet } from "../support/extension";
import { Wallet, ADDRESS_RE, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";

const PASSWORD = "a-strong-test-password";

test("a funded account reports the ledger's balance, and names the locked reserve", async ({
  wallet,
}) => {
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  const funded = await ledger.fund(address);

  // Closing and reopening the popup is how a user refreshes it; the balance is
  // read on mount.
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  // A brand-new account holds two base reserves, 0.5 XLM each, so exactly
  // 1 XLM of what the ledger reports cannot be sent. Showing only the spendable
  // figure made a freshly funded 10,000 XLM account read 9999 with nothing on
  // screen to explain the missing one.
  const shown = await wallet.publicBalance();
  expect(shown).toBeCloseTo(funded - 1, 7);
  await expect(
    wallet.page.getByText("Plus 1.0000000 XLM locked by the network as a reserve."),
  ).toBeVisible();

  // And the figure is the ledger's, not an invention: no zero, no placeholder.
  expect(shown).toBeGreaterThan(0);
});

test("a payment leaves one wallet, arrives in another, and the ledger agrees", async ({
  wallet,
}) => {
  test.setTimeout(6 * 60_000);

  await wallet.createWallet(PASSWORD);
  const sender = await wallet.revealAddress();
  const senderStart = await ledger.fund(sender);

  // The recipient is a second real wallet, not an address pulled from a
  // constant: that is what makes this a test of receiving as well as sending.
  const other = await launchWallet();
  try {
    const recipientWallet = new Wallet(other.popup);
    await recipientWallet.createWallet(PASSWORD);
    const recipient = await recipientWallet.revealAddress();
    const recipientStart = await ledger.fund(recipient);
    expect(recipient).not.toBe(sender);

    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openSend();
    await wallet.composePayment({ to: recipient, amount: "100", memo: "pocket-t1" });

    // The confirm screen is the last thing between a user and a signature, so
    // everything that is about to be signed has to be legible on it.
    const confirmed = await wallet.readAddress();
    expect(confirmed).toBe(recipient);
    expect(confirmed).toHaveLength(56);

    await expect(wallet.page.getByText("To", { exact: true })).toBeVisible();
    // The amount, as money rather than as prose. The effects list says it too,
    // a few lines further down, and both have to be right.
    await expect(wallet.money().first()).toHaveText(/^100\.0000000\s*XLM$/);
    // The memo is signed, so it is reviewed. Corrupting it is the most reliable
    // way to lose funds at an exchange deposit address.
    await expect(wallet.page.getByText("pocket-t1", { exact: true })).toBeVisible();
    await expect(wallet.page.getByText("Send 100.0000000 XLM to this address")).toBeVisible();
    await expect(wallet.page.getByText('Attach the memo "pocket-t1"')).toBeVisible();
    await expect(wallet.page.getByText(/Pay a network fee of [\d.]+ XLM/)).toBeVisible();
    await expect(
      wallet.page.getByText(/could not determine what this transaction does/i),
    ).toHaveCount(0);

    const hash = await wallet.confirmPayment();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    await expect(wallet.page.getByText(/Included in ledger \d+/)).toBeVisible();

    // "Sent" on a screen is a claim. This is the evidence.
    const tx = await ledger.waitForTransaction(hash);
    expect(tx.successful, "the ledger must have accepted the transaction").toBe(true);
    expect(tx.memo).toBe("pocket-t1");
    expect(tx.operation_count).toBe(1);

    const senderEnd = await ledger.nativeBalance(sender);
    const recipientEnd = await ledger.nativeBalance(recipient);
    const fee = Number(tx.fee_charged) / 10_000_000;

    // Exactly 100 XLM moved, plus the fee the transaction itself declares.
    // Anything else means the amount signed was not the amount reviewed.
    expect(recipientEnd - recipientStart).toBeCloseTo(100, 7);
    expect(senderStart - senderEnd).toBeCloseTo(100 + fee, 7);

    // The one operation on the recipient's account is this payment, for this
    // amount, from this sender.
    const [credit] = await ledger.payments(recipient, 1);
    expect(credit, "the recipient's account must show a payment operation").toBeDefined();
    expect(credit!.type).toBe("payment");
    expect(credit!.from).toBe(sender);
    expect(credit!.to).toBe(recipient);
    expect(credit!.amount).toBe("100.0000000");
    expect(credit!.transaction_hash).toBe(hash);

    // And the receiving wallet, reopened, shows the money without being told
    // where it came from.
    await recipientWallet.reopen();
    await recipientWallet.waitForHome(WAITS.ledgerRead);
    expect(await recipientWallet.publicBalance()).toBeCloseTo(recipientEnd - 1, 7);
  } finally {
    await other.close();
  }
});

test("the address a wallet shows to be paid is the account the ledger funds", async ({
  wallet,
}) => {
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  expect(address).toMatch(ADDRESS_RE);

  // Funding the exact string on screen, then reading it back from Horizon: if
  // the receive view rendered anything but this account, no account exists.
  await ledger.fund(address);
  const account = await ledger.account(address);
  expect(account, "friendbot funded the address the wallet displayed").not.toBeNull();
  expect(account!.id).toBe(address);
});
