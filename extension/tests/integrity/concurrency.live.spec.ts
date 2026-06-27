// Two writers, one opening store.
//
// Everything that spends goes through the controller's `exclusive` queue, so
// two operations cannot interleave. `privatePocket()` does NOT: it is a read,
// the popup calls it on every mount, and since `creditInboundTransfers` landed
// it WRITES the opening store on the way through. That makes it the one path
// that can write those bytes without taking the lock, and its window is not
// small: crediting an inbound transfer means paginating `getEvents` across the
// RPC's whole retained span, which T1 measured at up to 41 pages.
//
// The shape being hunted is T4's headline bug in a different file: read, do
// something slow, write back what you read. What makes it worse here is WHAT is
// read back. `creditInboundTransfers` writes `{...stored, receiving}` — the
// spendable side comes from its own stale snapshot, so a write that only means
// to credit the receiving balance carries an old spendable opening with it.
//
// The one thing stubbed is at the network boundary, and only the timing: the
// first `getEvents` reply is held so the overlap is deterministic instead of a
// coin flip. Both operations really run, really submit and really land.
import { test, expect } from "../support/fixtures";
import { launchWallet } from "../support/extension";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { intercept, restore, RPC_HOST } from "../support/stub";
import {
  chainAccount,
  formatStroops,
  inspect,
  openingKeyFor,
  openingsOpenTheChain,
  storage,
} from "./oracle";
import { fire, collect, PASSWORD } from "./harness";
import type { Page } from "@playwright/test";

/** Two registered wallets, with `amount` XLM already sent privately to the second. */
async function transferPrivately(
  sender: Wallet,
  recipient: Wallet,
  amount: string,
): Promise<{ senderAddress: string; recipientAddress: string }> {
  await sender.createWallet(PASSWORD);
  const senderAddress = await sender.revealAddress();
  await ledger.fund(senderAddress);
  await recipient.createWallet(PASSWORD);
  const recipientAddress = await recipient.revealAddress();
  await ledger.fund(recipientAddress);

  await sender.reopen();
  await sender.waitForHome(WAITS.ledgerRead);
  await sender.openPrivatePocket();
  await sender.registerPrivatePocket();

  await recipient.reopen();
  await recipient.waitForHome(WAITS.ledgerRead);
  await recipient.openPrivatePocket();
  await recipient.registerPrivatePocket();

  await sender.openOp("Move in");
  await sender.submitOp({ amount: "25" });
  await sender.approve();
  await expect(sender.page.getByText(/Made spendable in a second transaction/)).toBeVisible({
    timeout: WAITS.submission,
  });

  await sender.openOp("Send privately");
  await sender.submitOp({ amount, to: recipientAddress });
  await sender.approve();
  await expect(sender.page.getByText(/Confirmed on the ledger/)).toBeVisible({
    timeout: WAITS.submission,
  });
  return { senderAddress, recipientAddress };
}

test("a merge landing while an inbound credit is still reading events must not lose the merged balance", async ({
  wallet,
}) => {
  test.setTimeout(25 * 60_000);

  const second = await launchWallet();
  try {
    const other = new Wallet(second.popup);
    const { recipientAddress } = await transferPrivately(wallet, other, "5");
    console.log(`  recipient ${recipientAddress} has 5 XLM waiting`);

    // The recipient's device has not looked yet, so its record still says
    // receiving = 0 while the chain says otherwise. That is the state in which
    // `creditInboundTransfers` does work, and therefore the state in which it
    // writes.
    const beforeAnything = await inspect(second.popup, PASSWORD);
    expect(beforeAnything.openings!.receiving.value, "not credited yet").toBe(0n);

    // Park the FIRST event scan, and let every later one through.
    //
    // Not by holding the socket: the RPC client has a 30-second request
    // deadline, so a reply held longer than that becomes a timeout and the
    // credit is abandoned rather than delayed. Parked the way the RPC itself
    // stalls a wide scan, which T1 measured against the live deployment: an
    // EMPTY PAGE CARRYING A CURSOR, over and over. Every individual request
    // answers promptly, so nothing times out, and `findInbound` keeps asking
    // for the next page exactly as it does in the wild. Releasing hands back
    // the real reply that was captured on the way past, so the scan then
    // completes for real against real events.
    let released = false;
    let captured: string | null = null;
    let parkedPages = 0;
    const parked = new Promise<void>((seen) => {
      void intercept(second.context, RPC_HOST, async (route) => {
        const raw = route.request().postData() ?? "";
        if (!raw.includes('"getEvents"')) {
          await route.continue();
          return;
        }
        const isParked = raw.includes("T10-PARK");
        if (isParked) {
          if (released && captured) {
            await route.fulfill({
              status: 200,
              contentType: "application/json",
              body: captured,
            });
            return;
          }
          parkedPages++;
          // A slow poll, not a spin. Answering instantly burns `findInbound`'s
          // 200-page budget in about a second, which ends the scan with its own
          // refusal instead of parking it, and floods the route handler hard
          // enough to delay the OTHER tab's real requests past the 30-second
          // deadline. Two seconds a page is both realistic and cheap.
          await new Promise((r) => setTimeout(r, 2_000));
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { events: [], cursor: `T10-PARK-${parkedPages}`, latestLedger: 1 },
            }),
          });
          return;
        }
        if (captured === null) {
          // Take the real answer, keep it, and stall this scan instead.
          const real = await route.fetch();
          captured = await real.text();
          seen();
          await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { events: [], cursor: "T10-PARK-0", latestLedger: 1 },
            }),
          });
          return;
        }
        await route.continue();
      });
    });

    // ---- tab B: a popup that starts reading the pocket and stays inside it
    const tabB: Page = await second.openPopup();
    await fire(tabB, "slowRead", { type: "privatePocket" });
    await parked;
    console.log("  tab B is inside creditInboundTransfers, parked on getEvents");

    // ---- tab A: the user, in another tab, doing the whole flow meanwhile
    const tabA = new Wallet(await second.openPopup());
    await tabA.waitForHome(WAITS.ledgerRead);
    // Reopen until the credit lands, which is what a user does when a screen
    // says the ledger could not be reached. Observed once in four runs: tab A's
    // own event scan came back "Pocket could not reach the ledger to look for
    // transfers you have received" under load, which is a transport failure in
    // the SETUP of this test rather than anything it is asserting. Retrying the
    // read is honest; weakening the assertion below would not be.
    for (let attempt = 1; ; attempt++) {
      await tabA.openPrivatePocket();
      try {
        await expect(tabA.receivingMoney()).toHaveText(/^5\.0000000\s*XLM$/, {
          timeout: WAITS.ledgerRead,
        });
        break;
      } catch (e) {
        console.log(
          `  tab A attempt ${attempt}: ${(await tabA.page.locator("body").innerText()).replace(/\n+/g, " | ")}`,
        );
        if (attempt === 3) throw e;
        await tabA.close();
        await tabA.waitForHome(WAITS.ledgerRead);
      }
    }
    await tabA.page.getByRole("button", { name: "Make spendable" }).click();
    await tabA.approve();
    await expect(tabA.page.getByText(/Confirmed on the ledger/)).toBeVisible({
      timeout: WAITS.submission,
    });
    await expect(tabA.spendableMoney()).toHaveText(/^5\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });
    console.log("  tab A merged: the screen says 5 XLM spendable");

    const merged = JSON.stringify((await storage(second.popup))[openingKeyFor(recipientAddress)]);

    // ---- and now tab B finishes the read it started before any of that
    released = true;
    const late = await collect<{ state?: string }>(tabB, "slowRead");
    console.log(
      `  tab B finished after ${parkedPages} parked pages: ${JSON.stringify(late.data ?? late.error)}`,
    );
    await restore(second.context, RPC_HOST);
    // If the park ran out of pages, `findInbound` refused on its own budget and
    // never reached the write this test is about, so a green result would mean
    // nothing. 200 is the loop's cap.
    expect(parkedPages, "the parked scan must have been released, not exhausted").toBeLessThan(190);

    const after = await inspect(second.popup, PASSWORD);
    const chain = await chainAccount(recipientAddress);
    const verdict = openingsOpenTheChain(after.openings!, chain!);

    const afterBlob = JSON.stringify(
      (await storage(second.popup))[openingKeyFor(recipientAddress)],
    );
    console.log(
      `  the late credit ${afterBlob === merged ? "left the merged record alone" : "REWROTE the opening store"}: ` +
        `spendable ${formatStroops(after.openings!.spendable.value)}, ` +
        `receiving ${formatStroops(after.openings!.receiving.value)}`,
    );

    // What the user is left looking at, gathered BEFORE the assertion so the
    // evidence exists whichever way this goes.
    await other.reopen();
    await other.waitForHome(WAITS.ledgerRead);
    await other.openPrivatePocket();
    // Wait for the read to settle, not for a duration: "Reading the ledger…" is
    // the loading state and capturing it says nothing about what the user ends
    // up looking at.
    await expect(other.page.getByText(/Reading the ledger/)).toHaveCount(0, {
      timeout: WAITS.ledgerRead,
    });
    const screen = await other.page.locator("body").innerText();
    console.log(`  the recipient's own screen:\n${screen.replace(/^/gm, "    ")}`);

    // The whole point. Whatever the last writer wrote, the record on disk has
    // to be able to move the money the contract holds. If a stale snapshot won,
    // the merged spendable opening exists nowhere and 5 XLM is visible on chain
    // and permanently unspendable.
    expect(
      verdict.ok,
      `an inbound credit finishing late must not overwrite a merge: ${verdict.detail}. ` +
        `Stored spendable ${formatStroops(after.openings!.spendable.value)}, ` +
        `receiving ${formatStroops(after.openings!.receiving.value)}.`,
    ).toBe(true);
    expect(formatStroops(after.openings!.spendable.value)).toBe("5.0000000");
    expect(after.openings!.receiving.value).toBe(0n);

    // And the user's own screen must agree, on a fresh mount that reads disk.
    await expect(
      other.spendableMoney(),
      "the screen must still offer the money the record can move",
    ).toHaveText(/^5\.0000000\s*XLM$/, { timeout: WAITS.ledgerRead });
  } finally {
    await second.close();
  }
});

test("two tabs learning about the same inbound transfer at once credit it once", async ({
  wallet,
}) => {
  test.setTimeout(25 * 60_000);

  const second = await launchWallet();
  try {
    const other = new Wallet(second.popup);
    const { recipientAddress } = await transferPrivately(wallet, other, "5");

    // Both tabs read the uncredited record, both scan, both write. Crediting
    // twice would produce 10 XLM for a 5 XLM transfer, and the commitment check
    // inside `creditInbound` is what is supposed to refuse it: a doubled credit
    // does not reproduce the accumulator the contract holds.
    const tabB = await second.openPopup();
    const tabC = await second.openPopup();
    await fire(tabB, "read", { type: "privatePocket" });
    await fire(tabC, "read", { type: "privatePocket" });
    const [b, c] = await Promise.all([
      collect<{ state: string; receiving?: string }>(tabB, "read"),
      collect<{ state: string; receiving?: string }>(tabC, "read"),
    ]);
    console.log(`  tab B: ${JSON.stringify(b.data ?? b.error)}`);
    console.log(`  tab C: ${JSON.stringify(c.data ?? c.error)}`);

    const after = await inspect(second.popup, PASSWORD);
    expect(
      formatStroops(after.openings!.receiving.value),
      "a transfer of 5 credited twice is 10, and the money would be unspendable",
    ).toBe("5.0000000");

    const chain = await chainAccount(recipientAddress);
    const verdict = openingsOpenTheChain(after.openings!, chain!);
    expect(verdict.ok, `after two concurrent credits: ${verdict.detail}`).toBe(true);

    // Neither tab may report a balance the record cannot back.
    for (const [name, r] of [
      ["B", b],
      ["C", c],
    ] as const) {
      if (r.data?.state === "ready") {
        expect(r.data.receiving, `tab ${name} reported a balance the record does not hold`).toBe(
          "5.0000000",
        );
      }
    }
  } finally {
    await second.close();
  }
});
