// The openings, checked from outside the wallet.
//
// `pocket.openings.<token>.<address>` is the only thing that makes an on-chain
// commitment spendable. Nothing else holds it, no archive in this build can
// rebuild it, and losing or corrupting one leaves funds visible on chain and
// permanently unspendable. So a screen reading "25.0000000 XLM" is a claim
// about money, and the evidence for it is not another screen: it is whether the
// sealed bytes on disk, opened with the user's password, reproduce the
// accumulator the CONTRACT holds.
//
// `core/private.ts::verifyAgainstChain` is that comparison, inside the wallet.
// Everything here does it from outside, with an oracle that imports no wallet
// code, so a wallet that is wrong in the same way twice cannot pass.
import { test, expect } from "../support/fixtures";
import { launchWallet } from "../support/extension";
import { Wallet, WAITS, openMoveAction } from "../support/wallet";
import * as ledger from "../support/testnet";
import { intercept, restore, RPC_HOST } from "../support/stub";
import {
  chainAccount,
  formatStroops,
  inspect,
  openingKeyFor,
  openingsOpenTheChain,
  storage,
  IDENTITY,
  samePoint,
  type StoredOpenings,
} from "./oracle";
import { evictWorker, expectRestored, PASSWORD } from "./harness";
import type { Page } from "@playwright/test";

/**
 * Assert the record on disk can actually move the money the screen shows.
 *
 * Returns the openings so a caller can go on to assert on the amounts, but the
 * comparison against the contract happens here every time: a value that is
 * merely the number the UI said is not evidence of anything.
 */
async function openingsMustOpenTheChain(
  page: Page,
  address: string,
  password: string,
  when: string,
): Promise<StoredOpenings> {
  const disk = await inspect(page, password);
  expect(disk.openings, `${when}: this device must hold an opening for ${address}`).not.toBeNull();
  expect(disk.openingKey, `${when}: the opening must be under the documented key`).toBe(
    openingKeyFor(address),
  );

  const chain = await chainAccount(address);
  expect(chain, `${when}: the contract must hold a confidential account`).not.toBeNull();

  const verdict = openingsOpenTheChain(disk.openings!, chain!);
  expect(verdict.ok, `${when}: ${verdict.detail}`).toBe(true);
  return disk.openings!;
}

test("every private balance the screen shows is money the record on disk can actually move", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(20 * 60_000);

  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  const startingBalance = await ledger.fund(address);
  console.log(`  account ${address}`);

  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await wallet.registerPrivatePocket();

  // ------------------------------------------------------ just registered
  // A fresh pocket holds the identity on both sides. Checked rather than
  // assumed, because the identity is the one commitment an all-zero opening
  // reproduces trivially, so this is the weakest state and the easiest one to
  // pass by accident. What it does establish is that the record EXISTS and is
  // where the wallet will look for it.
  {
    const o = await openingsMustOpenTheChain(harness.popup, address, PASSWORD, "after register");
    expect(o.spendable.value).toBe(0n);
    expect(o.receiving.value).toBe(0n);
    const chain = (await chainAccount(address))!;
    expect(samePoint(chain.spendableCommitment, IDENTITY)).toBe(true);
    expect(samePoint(chain.receivingCommitment, IDENTITY)).toBe(true);
  }

  // ---------------------------------------------------------------- shield
  await wallet.openOp("Shield");
  await wallet.submitOp({ amount: "25" });
  await wallet.approve();
  await expect(wallet.page.getByText(/Made spendable in a second transaction/)).toBeVisible({
    timeout: WAITS.submission,
  });
  await expect(wallet.spendableMoney()).toHaveText(/^25\.0000000\s*XLM$/, {
    timeout: WAITS.ledgerRead,
  });

  const afterShield = await openingsMustOpenTheChain(
    harness.popup,
    address,
    PASSWORD,
    "after shielding 25 XLM",
  );
  // The screen said 25. The sealed bytes have to say 25 too, to the stroop:
  // a display derived from one number and a record holding another is exactly
  // the failure that only shows up when the money is spent.
  expect(formatStroops(afterShield.spendable.value), "the record must hold what the screen showed").toBe(
    "25.0000000",
  );
  expect(formatStroops(afterShield.receiving.value)).toBe("0.0000000");
  // A deposit is public and unblinded, so its blinding is exactly zero. Any
  // other value here means the credit was computed from something other than
  // the deposit.
  expect(afterShield.receiving.randomness).toBe(0n);

  // -------------------------------- the round trip through a real eviction
  //
  // MV3 evicts the worker whenever it likes. Everything above could have been
  // answered out of the worker's heap; this is where it has to come off disk.
  const blobBefore = JSON.stringify((await storage(harness.popup))[openingKeyFor(address)]);

  await evictWorker(harness.context, harness.popup);
  await expectRestored(harness.popup);

  // The eviction restored the session from the DEK mirror, so this reopens
  // straight to Home. The openings still come off disk: they live encrypted in
  // local storage, decrypted with the restored DEK, and the byte-identical check
  // below proves nothing was re-derived.
  await wallet.reopen();
  await wallet.waitForHome(WAITS.onboarding);
  await wallet.openPrivatePocket();
  await expect(wallet.spendableMoney()).toHaveText(/^25\.0000000\s*XLM$/, {
    timeout: WAITS.ledgerRead,
  });

  const blobAfter = JSON.stringify((await storage(harness.popup))[openingKeyFor(address)]);
  // Byte-identical, ciphertext and IV included. A wallet that re-derived and
  // re-sealed would show the same number with different bytes, and the number
  // would then be a fresh computation rather than the record it claims to be.
  expect(blobAfter, "a cold worker must READ the openings, not rewrite them").toBe(blobBefore);
  const afterRestart = await openingsMustOpenTheChain(
    harness.popup,
    address,
    PASSWORD,
    "after a worker eviction",
  );
  expect(afterRestart.spendable.value).toBe(afterShield.spendable.value);
  expect(afterRestart.spendable.randomness).toBe(afterShield.spendable.randomness);

  // -------------------------------------------------------------- unshield
  await wallet.openOp("Unshield");
  await wallet.submitOp({ amount: "10" });
  await wallet.approve();
  await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
    timeout: WAITS.submission,
  });
  await expect(wallet.spendableMoney()).toHaveText(/^15\.0000000\s*XLM$/, {
    timeout: WAITS.ledgerRead,
  });

  const afterUnshield = await openingsMustOpenTheChain(
    harness.popup,
    address,
    PASSWORD,
    "after moving 10 XLM back out",
  );
  expect(formatStroops(afterUnshield.spendable.value)).toBe("15.0000000");
  // The blinding MUST have moved. A withdrawal that reused the old randomness
  // would still open the new commitment arithmetically and would leak the
  // relationship between the two balances on chain.
  expect(afterUnshield.spendable.randomness).not.toBe(afterShield.spendable.randomness);

  // ---------------------------------------------------------- the ledger
  // 25 out and 10 back, so the public account is down 15 plus every fee it
  // paid, failed attempts included.
  const txs = await ledger.transactions(address, 200);
  const fees = ledger.feesPaidBy(address, txs);
  const endBalance = await ledger.nativeBalance(address);
  expect(startingBalance - endBalance).toBeCloseTo(15 + fees, 5);
  console.log(
    `  ledger: ${txs.filter((t) => t.successful).length} successful, ` +
      `${txs.filter((t) => !t.successful).length} failed, fees ${fees.toFixed(7)}`,
  );
});

test("money received privately is written to disk, not re-read from an event window that expires", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(25 * 60_000);

  // The receiving side is the half where losing the record is unrecoverable.
  // A shield's amount is known locally and can be staged; an inbound transfer
  // is only knowable from a `getEvents` window the RPC keeps for about seven
  // days. If the credit is not PERSISTED, the wallet is fine today and the
  // money is unreachable a week from now, with nothing on screen to say so.
  await wallet.createWallet(PASSWORD);
  const sender = await wallet.revealAddress();
  await ledger.fund(sender);

  const second = await launchWallet();
  try {
    const other = new Wallet(second.popup);
    await other.createWallet(PASSWORD);
    const recipient = await other.revealAddress();
    await ledger.fund(recipient);
    console.log(`  ${sender} -> ${recipient}`);

    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPrivatePocket();
    await wallet.registerPrivatePocket();

    await other.reopen();
    await other.waitForHome(WAITS.ledgerRead);
    await other.openPrivatePocket();
    await other.registerPrivatePocket();

    // The recipient's record, before anything arrives.
    const beforeInbound = JSON.stringify(
      (await storage(second.popup))[openingKeyFor(recipient)],
    );

    await wallet.openOp("Shield");
    await wallet.submitOp({ amount: "25" });
    await wallet.approve();
    await expect(wallet.page.getByText(/Made spendable in a second transaction/)).toBeVisible({
      timeout: WAITS.submission,
    });

    await wallet.openOp("Send privately");
    await wallet.submitOp({ amount: "5", to: recipient });
    await wallet.approve();
    await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
      timeout: WAITS.submission,
    });
    console.log("  sent 5 XLM privately");

    // ------------------------------------------- the recipient learns of it
    await other.reopen();
    await other.waitForHome(WAITS.ledgerRead);
    await other.openPrivatePocket();
    await expect(other.receivingMoney()).toHaveText(/^5\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });

    const credited = await openingsMustOpenTheChain(
      second.popup,
      recipient,
      PASSWORD,
      "after receiving 5 XLM privately",
    );
    expect(formatStroops(credited.receiving.value)).toBe("5.0000000");
    // A transfer's blinding is derived from the shared secret, so unlike a
    // deposit it is emphatically NOT zero. Zero here would mean the wallet
    // credited the amount without the randomness that opens it.
    expect(credited.receiving.randomness, "an inbound transfer is blinded").not.toBe(0n);

    const afterInbound = JSON.stringify((await storage(second.popup))[openingKeyFor(recipient)]);
    expect(afterInbound, "the credit must be WRITTEN, not only displayed").not.toBe(beforeInbound);

    // ------------------------- and it must survive without the event window
    //
    // Kill the worker, then take `getEvents` away entirely at the network
    // boundary and reopen. If the receiving balance is re-derived from events
    // on every read rather than persisted, this is where it disappears, which
    // is what a wallet opened eight days later would experience.
    await evictWorker(second.context, second.popup);
    await expectRestored(second.popup);

    let eventsAsked = 0;
    await intercept(second.context, RPC_HOST, async (route) => {
      const body = route.request().postData() ?? "";
      if (body.includes('"getEvents"')) {
        eventsAsked++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32600, message: "gone" } }),
        });
        return;
      }
      await route.continue();
    });

    await other.reopen();
    await other.waitForHome(WAITS.onboarding);
    await other.openPrivatePocket();
    await expect(
      other.receivingMoney(),
      "the received 5 XLM must come off disk, with no event window to re-read",
    ).toHaveText(/^5\.0000000\s*XLM$/, { timeout: WAITS.ledgerRead });
    expect(
      eventsAsked,
      "a record that already opens the chain needs no event scan at all",
    ).toBe(0);

    // Prove that counter is live before trusting a zero.
    //
    // "The wallet made no event calls" and "the interception was never wired
    // up" are the same observation, and one of them means the assertion above
    // cannot fail. So ask for events deliberately and check it is counted.
    await second.popup.evaluate(
      (url) =>
        fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getEvents", params: {} }),
        }).then(() => undefined),
      `https://${RPC_HOST}`,
    );
    expect(eventsAsked, "the getEvents stub must actually be intercepting").toBe(1);
    await restore(second.context, RPC_HOST);

    // ------------------------------------------------------ make it spendable
    await openMoveAction(other.page, "Make spendable");
    await other.approve();
    await expect(other.page.getByText("Transaction successful")).toBeVisible({
      timeout: WAITS.submission,
    });
    await expect(other.spendableMoney()).toHaveText(/^5\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });

    const merged = await openingsMustOpenTheChain(
      second.popup,
      recipient,
      PASSWORD,
      "after folding the received 5 XLM into spendable",
    );
    expect(formatStroops(merged.spendable.value)).toBe("5.0000000");
    expect(merged.receiving.value).toBe(0n);
    expect(merged.receiving.randomness, "a merged receiving side is the identity").toBe(0n);
    // The merged spendable blinding is the sum of both sides mod the GROUP
    // order, never mod the scalar field. Getting that wrong yields an opening
    // off by q-r that opens nothing, and it crosses the boundary about half
    // the time, so a wrong build passes this roughly one run in two. The
    // commitment check above is what actually catches it; this records the
    // value that was checked.
    expect(merged.spendable.randomness).toBe(credited.receiving.randomness);

    // The sender's own record is still correct after all of it.
    const senderFinal = await openingsMustOpenTheChain(
      harness.popup,
      sender,
      PASSWORD,
      "the sender, after paying 5 XLM privately",
    );
    expect(formatStroops(senderFinal.spendable.value)).toBe("20.0000000");
  } finally {
    await second.close();
  }
});
