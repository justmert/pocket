import { test, expect, type Page } from "@playwright/test";
import {
  addressOf,
  alarms,
  fund,
  fundedStranger,
  killWorker,
  launch,
  ledgerTransactions,
  offscreenCount,
  onboard,
  ownTransactions,
  send,
  storage,
  storageKeys,
  TOKEN,
  unlockUi,
  waitForFunded,
  waitForStorage,
  type Wallet,
} from "./harness";
import { openMoveAction } from "../support/wallet";

// Not parallel WITHIN this file, and not for an ordering reason: every test here
// builds its own wallet and reads nothing another wrote. Proving is CPU-bound and
// multithreaded, and three of these at once turned a 15-second register into four
// minutes. `default` rather than `serial` on purpose: serial would SKIP the rest
// of the file after one failure, which would hide findings.
//
// It also keeps this file's auditor registrations from bursting at the shared
// registry counter all at once. That is a real effect but a partial fix: other
// FILES still run beside this one, so it does not make the registry contention
// go away, it only stops this file adding to it. The burst is a symptom of F0;
// once the retry predicate lands, this file submits one registration per test.
test.describe.configure({ mode: "default" });

// The most expensive window in the wallet.
//
// Openings are the ONLY thing that makes an on-chain commitment spendable, and
// nothing else holds them. Lose one and the balance is visible on the ledger and
// permanently unspendable. The code stages the post-state to disk before
// submitting and writes it only once the ledger has accepted, verified against
// the commitment the contract actually holds. These tests kill the worker inside
// that window and ask what survived.

interface Live {
  w: Wallet;
  page: Page;
  address: string;
  openingsKey: string;
}

async function fundedWallet(): Promise<Live> {
  const w = await launch();
  const page = await w.popup();
  await onboard(page);
  const address = await addressOf(page);
  await fund(address);
  await waitForFunded(address);
  return { w, page, address, openingsKey: `pocket.openings.${TOKEN}.${address}` };
}

/** Stop the worker from ever seeing a confirmation, at the network boundary. */
async function blindConfirmationPolls(w: Wallet): Promise<{ on(): void; off(): void }> {
  let blind = false;
  await w.ctx.route("**/soroban-testnet.stellar.org/**", async (route) => {
    let method: string | undefined;
    try {
      method = (route.request().postDataJSON() as { method?: string })?.method;
    } catch {
      method = undefined;
    }
    if (blind && method === "getTransaction") return route.abort("failed");
    return route.continue();
  });
  return {
    on: () => {
      blind = true;
    },
    off: () => {
      blind = false;
    },
  };
}

async function openPocket(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Private", exact: true }).click();
}

/**
 * Wait for the review screen, and say what the wallet actually showed if it
 * never arrives. A bare "element not found" after four minutes hides whichever
 * refusal the wallet was displaying the whole time.
 */
async function waitForReview(page: Page, timeout = 240_000): Promise<void> {
  try {
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({ timeout });
  } catch (e) {
    throw new Error(
      `no review screen appeared. The wallet was showing:\n${await page.innerText("body")}`,
      { cause: e },
    );
  }
}

/** Register the confidential account and land on the balances view. */
async function register(page: Page): Promise<void> {
  await openPocket(page);
  await expect(page.getByText(/Not open yet/).first()).toBeVisible({ timeout: 120_000 });
  await openMoveAction(page, "Set up the private pocket");
  await waitForReview(page);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Success")).toBeVisible({ timeout: 300_000 });
}

test("a register killed between submitting and persisting its openings loses nothing", async () => {
  test.setTimeout(900_000);
  const { w, page, address, openingsKey } = await fundedWallet();
  try {
    const blind = await blindConfirmationPolls(w);

    await openPocket(page);
    await expect(page.getByText(/Not open yet/).first()).toBeVisible({ timeout: 120_000 });
    await openMoveAction(page, "Set up the private pocket");
    await waitForReview(page);
    void page.getByRole("button", { name: "Approve" }).click();

    // The staged post-state is written to disk immediately before the register
    // is submitted. From here the worker must not be allowed to see the
    // outcome, or there is nothing left to interrupt.
    // Both records, not just the staged one. They are written a beat apart
    // (staged, then the hash immediately before the network is asked), and
    // catching the gap between them is a race in the TEST, not a defect: a
    // worker that died in that window submitted nothing, so the staged record
    // is dead weight the next operation overwrites.
    const staged = await waitForStorage(
      page,
      (s) => !!s["pocket.staged"] && !!s["pocket.inflight"],
      "the post-state and the submitted hash must both be on disk BEFORE the outcome is known",
      180_000,
    );
    blind.on();
    expect(
      staged[openingsKey],
      "openings must NOT be written before the ledger has accepted",
    ).toBeUndefined();
    // Sealed, not in the clear: a resolution carries an amount.
    expect(Object.keys(staged["pocket.staged"] as object).sort()).toEqual(["ct", "iv", "v"]);

    const hash = (staged["pocket.inflight"] as { hash: string }).hash;
    await expect
      .poll(async () => (await ledgerTransactions(address)).some((t) => t.hash === hash), {
        timeout: 180_000,
        intervals: [2000],
      })
      .toBe(true);

    // Killed with the confidential account created on chain and this device
    // still holding the only copy of what opens its commitments.
    await killWorker(w, page);
    blind.off();
    let keys = await storageKeys(page);
    expect(keys).toContain("pocket.staged");
    expect(keys).toContain("pocket.inflight");
    expect(keys).not.toContain(openingsKey);

    // A fresh popup must find it and finish the job.
    const reopened = await w.popup();
    await unlockUi(reopened);
    await expect(reopened.getByText("Unfinished transaction")).toBeVisible({ timeout: 120_000 });
    await reopened.getByRole("button", { name: "Check now" }).click();
    await expect(reopened.getByRole("button", { name: "Public", exact: true })).toBeVisible({
      timeout: 180_000,
    });

    keys = await storageKeys(reopened);
    expect(keys, "the openings must have been recovered").toContain(openingsKey);
    expect(keys, "the staged record must be cleared once written").not.toContain("pocket.staged");
    expect(keys).not.toContain("pocket.inflight");

    // `ready` is only reported when the stored openings re-commit to the
    // commitments the contract holds, so this is the chain agreeing, not the
    // wallet agreeing with itself.
    const pocket = await send<{ state: string; spendable?: string; receiving?: string }>(reopened, {
      type: "privatePocket",
    });
    expect(pocket.ok, JSON.stringify(pocket)).toBe(true);
    expect(pocket.data?.state).toBe("ready");
    expect(pocket.data?.spendable).toBe("0.0000000");

    // Reconciling again must be a no-op, not a second application.
    const blobBefore = (await storage(reopened))[openingsKey];
    const again = await send(reopened, { type: "reconcileInFlight" });
    expect(again.ok, JSON.stringify(again)).toBe(true);
    expect(again.data, "there is nothing left to reconcile").toBeNull();
    expect((await storage(reopened))[openingsKey]).toEqual(blobBefore);
  } finally {
    await w.close();
  }
});

test("a proof killed mid-flight stages nothing and does not orphan an auditor key", async () => {
  test.setTimeout(900_000);
  const { w, page, address, openingsKey } = await fundedWallet();
  try {
    await openPocket(page);
    await expect(page.getByText(/Not open yet/).first()).toBeVisible({ timeout: 120_000 });
    void openMoveAction(page, "Set up the private pocket");

    // The offscreen document only comes up when a proof starts, and the auditor
    // key is registered before that, so this is precisely "killed while
    // proving, with a chain write already behind us".
    await expect
      .poll(() => offscreenCount(page), { timeout: 240_000, intervals: [250] })
      .toBeGreaterThan(0);
    await killWorker(w, page);

    const keys = await storageKeys(page);
    expect(keys, "nothing may be staged for an operation that was never built").not.toContain(
      "pocket.staged",
    );
    expect(keys, "no openings for an account that was never registered").not.toContain(openingsKey);
    const auditorKey = keys.find((k) => k.startsWith("pocket.auditorid."));
    expect(
      auditorKey,
      "the allocated auditor id must be persisted, or a retry orphans the key it registered",
    ).toBeDefined();
    const allocated = (await storage(page))[auditorKey!];

    // Now do it again, the way a user would after their browser ate the tab.
    const reopened = await w.popup();
    await unlockUi(reopened);
    if ((await reopened.getByText("Unfinished transaction").count()) > 0) {
      await reopened.getByRole("button", { name: "Check now" }).click();
      await expect(reopened.getByRole("button", { name: "Public", exact: true })).toBeVisible({
        timeout: 180_000,
      });
    }
    await register(reopened);

    const after = await storage(reopened);
    expect(
      Object.keys(after).filter((k) => k.startsWith("pocket.auditorid.")),
      "a retry must reuse the id the registry already allocated, never allocate a second",
    ).toHaveLength(1);
    expect(after[auditorKey!]).toEqual(allocated);

    const pocket = await send<{ state: string; auditorId?: number }>(reopened, {
      type: "privatePocket",
    });
    expect(pocket.data?.state).toBe("ready");
    expect(pocket.data?.auditorId, "the account must be bound to the id it already owned").toBe(
      allocated,
    );
    void address;
  } finally {
    await w.close();
  }
});

test("a shield killed after the deposit puts the money in receiving and says so", async () => {
  test.setTimeout(900_000);
  const { w, page, openingsKey } = await fundedWallet();
  try {
    await register(page);
    await expect(page.getByRole("button", { name: "Private", exact: true })).toBeVisible({
      timeout: 180_000,
    });
    const beforeShield = JSON.stringify((await storage(page))[openingsKey]);

    await page.getByRole("button", { name: "Shield" }).click();
    await page.getByRole("textbox", { name: "Amount" }).fill("25");
    await page.getByRole("button", { name: "Continue" }).click();
    await waitForReview(page);
    void page.getByRole("button", { name: "Approve" }).click();

    // A shield is deposit THEN merge. The deposit's credit is written the
    // moment the ledger accepts it, which is what makes this survivable at all,
    // so wait for that write and kill straight after it.
    await waitForStorage(
      page,
      (s) => !!s[openingsKey] && JSON.stringify(s[openingsKey]) !== beforeShield,
      "the deposit's credit must be written as soon as the ledger accepts it",
      300_000,
    );
    await killWorker(w, page);

    const reopened = await w.popup();
    await unlockUi(reopened);
    // Anything the kill caught mid-submission is resolved the way a user
    // resolves it, through the screen the wallet puts in front of them. Which
    // screen appears depends on exactly where the kill landed, so wait for
    // either rather than guessing.
    await expect(reopened.getByText(/Unfinished transaction|PUBLIC POCKET/)).toBeVisible({
      timeout: 120_000,
    });
    if ((await reopened.getByText("Unfinished transaction").count()) > 0) {
      await reopened.getByRole("button", { name: "Check now" }).click();
    }
    await expect(reopened.getByRole("button", { name: "Public", exact: true })).toBeVisible({
      timeout: 240_000,
    });

    // Whichever side of the merge the kill landed on, the invariant is the
    // same: 25 XLM went in, the chain and this device agree about where it is,
    // and it is neither lost nor counted twice.
    const pocket = await send<{
      state: string;
      spendable?: string;
      receiving?: string;
      mergeAvailable?: boolean;
    }>(reopened, { type: "privatePocket" });
    expect(pocket.ok, JSON.stringify(pocket)).toBe(true);
    expect(pocket.data?.state, "a killed shield must not leave a diverged wallet").toBe("ready");
    expect(
      Number(pocket.data?.spendable) + Number(pocket.data?.receiving),
      `25 XLM went in, so 25 XLM must be accounted for: ${JSON.stringify(pocket.data)}`,
    ).toBe(25);

    // If it stopped before the merge, the money is in the receiving balance and
    // the wallet has to say so, in the words that name the one action that
    // finishes the job.
    if (Number(pocket.data?.receiving) > 0) {
      expect(pocket.data?.mergeAvailable).toBe(true);
      await openPocket(reopened);
      await expect(reopened.getByText("Receiving", { exact: true })).toBeVisible({
        timeout: 180_000,
      });
      await openMoveAction(reopened, "Make spendable");
      await waitForReview(reopened);
      await reopened.getByRole("button", { name: "Approve" }).click();
      try {
        await expect(reopened.getByText("Success")).toBeVisible({
          timeout: 300_000,
        });
      } catch (e) {
        throw new Error(
          `"Make spendable" is the action the wallet offers for money sitting in the ` +
            `receiving balance, and it did not go through. The screen said:\n` +
            `${await reopened.innerText("body")}`,
          { cause: e },
        );
      }
    }

    await expect
      .poll(
        async () => {
          const p = await send<{ spendable?: string; receiving?: string }>(reopened, {
            type: "privatePocket",
          });
          return `${p.data?.spendable}/${p.data?.receiving}`;
        },
        { timeout: 180_000, intervals: [3000] },
      )
      .toBe("25.0000000/0.0000000");
  } finally {
    await w.close();
  }
});

test("a shield whose merge never reaches the network says where the money is, and means it", async () => {
  test.setTimeout(900_000);
  const { w, page, openingsKey } = await fundedWallet();
  try {
    await register(page);
    await expect(page.getByRole("button", { name: "Private", exact: true })).toBeVisible({
      timeout: 180_000,
    });
    const beforeShield = JSON.stringify((await storage(page))[openingsKey]);

    // Let the deposit through and stop the merge at the network boundary. This
    // is the designed two-transaction failure: the money is in, and the second
    // signature that makes it spendable did not happen.
    let submissions = 0;
    let stopMerge = false;
    await w.ctx.route("**/soroban-testnet.stellar.org/**", async (route) => {
      let method: string | undefined;
      try {
        method = (route.request().postDataJSON() as { method?: string })?.method;
      } catch {
        method = undefined;
      }
      if (method === "sendTransaction") {
        submissions++;
        if (stopMerge && submissions > 1) return route.abort("failed");
      }
      return route.continue();
    });

    await page.getByRole("button", { name: "Shield" }).click();
    await page.getByRole("textbox", { name: "Amount" }).fill("25");
    await page.getByRole("button", { name: "Continue" }).click();
    await waitForReview(page);
    submissions = 0;
    stopMerge = true;
    await page.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByText(/deposit landed but is not spendable yet/)).toBeVisible({
      timeout: 300_000,
    });
    await expect(page.getByText(/Make spendable/)).toBeVisible();
    stopMerge = false;

    // The deposit's credit really is on disk, and the chain agrees with it.
    expect(JSON.stringify((await storage(page))[openingsKey])).not.toBe(beforeShield);
    const pocket = await send<{ state: string; spendable?: string; receiving?: string }>(page, {
      type: "privatePocket",
    });
    expect(pocket.data?.state).toBe("ready");
    expect(pocket.data?.receiving).toBe("25.0000000");
    expect(pocket.data?.spendable).toBe("0.0000000");

    // And the instruction it just gave has to be one the wallet will accept.
    // Telling a user to press a button and then refusing that button is the
    // same defect as not telling them at all.
    const merge = await send(page, { type: "buildPrivateOp", op: { kind: "merge" } });
    expect(
      merge.ok,
      `the wallet told the user to make it spendable, then answered: ${merge.error}`,
    ).toBe(true);
  } finally {
    await w.close();
  }
});

test("approving one private operation twice at once runs it once", async () => {
  test.setTimeout(900_000);
  const { w, page } = await fundedWallet();
  try {
    await register(page);
    await expect(page.getByRole("button", { name: "Private", exact: true })).toBeVisible({
      timeout: 180_000,
    });

    const built = await send<{ handle: string }>(page, {
      type: "buildPrivateOp",
      op: { kind: "merge" },
    });
    expect(built.ok, JSON.stringify(built)).toBe(true);
    const handle = built.data!.handle;

    // Counted with failed transactions INCLUDED and narrowed to the ones this
    // wallet paid for. Horizon hides failures by default, so a duplicate that
    // was included and trapped would be invisible and this assertion would be
    // satisfied by construction rather than by the wallet behaving.
    const address = await addressOf(page);
    const before = (await ownTransactions(address)).length;
    const replies = await Promise.all([
      send(page, { type: "confirmPrivateOp", handle }),
      send(page, { type: "confirmPrivateOp", handle }),
    ]);
    const ok = replies.filter((r) => r.ok);
    expect(ok, "one proved operation must be submitted once").toHaveLength(1);
    const refused = replies.find((r) => !r.ok)!;
    expect(
      refused.error,
      "the losing tap must be told what happened, not handed a generic error",
    ).toMatch(/no longer pending confirmation|still waiting on an earlier transaction/);

    await expect
      .poll(async () => (await ownTransactions(address)).length, {
        timeout: 120_000,
        intervals: [3000],
      })
      .toBe(before + 1);
  } finally {
    await w.close();
  }
});

test("erase-and-restore takes the openings with it and says they cannot be rebuilt", async () => {
  test.setTimeout(900_000);
  const w = await launch();
  try {
    const page = await w.popup();
    const phrase = await onboard(page);
    const address = await addressOf(page);
    const openingsKey = `pocket.openings.${TOKEN}.${address}`;
    await fund(address);
    await waitForFunded(address);

    await register(page);
    await expect(page.getByRole("button", { name: "Private", exact: true })).toBeVisible({
      timeout: 180_000,
    });
    expect(await storageKeys(page)).toContain(openingsKey);

    // The forgotten-password route. It is authorised by the phrase and it does
    // erase real money's only key material, which is why the screen says so.
    const r = await send(page, {
      type: "recoverFromMnemonic",
      mnemonic: phrase,
      password: "a-different-password",
    });
    expect(r.ok, JSON.stringify(r)).toBe(true);

    // No orphaned blob may survive. A new vault gets a fresh random DEK, so a
    // leftover opening record is undecryptable forever, and re-importing the
    // same phrase reproduces the same storage key and would hit it.
    const keys = await storageKeys(page);
    expect(keys.filter((k) => k.startsWith("pocket.openings."))).toEqual([]);
    expect(keys).not.toContain("pocket.staged");
    expect(keys).not.toContain("pocket.inflight");

    // Same account, and the wallet says plainly what did not come back.
    expect(await addressOf(page)).toBe(address);
    const pocket = await send<{ state: string; message?: string }>(page, {
      type: "privatePocket",
    });
    expect(pocket.data?.state).toBe("needsRecovery");
    expect(pocket.data?.message).toMatch(/no record of its balances/);
    expect(pocket.data?.message).toMatch(/funds are safe on chain/);
    expect(pocket.data?.message).toMatch(/cannot be rebuilt yet/);
  } finally {
    await w.close();
  }
});

test("an auditor registration whose outcome is unknown is never resent", async () => {
  test.setTimeout(900_000);
  const { w, page, address } = await fundedWallet();
  try {
    // Registering the auditor key contends on a counter in the registry's
    // instance storage, so it can lose and the wallet retries. A retry is only
    // safe for an outcome that is KNOWN to have consumed nothing. This blinds
    // the confirmation poll, which is the other thing that happens constantly
    // under MV3: the transaction really lands and the worker never finds out,
    // so the outcome is "pending" — may still land, do not resend.
    const blind = await blindConfirmationPolls(w);
    blind.on();

    await openPocket(page);
    await expect(page.getByText(/Not open yet/).first()).toBeVisible({ timeout: 120_000 });
    await openMoveAction(page, "Set up the private pocket");
    await expect(page.getByText(/Nothing was bound|did not succeed/)).toBeVisible({
      timeout: 600_000,
    });
    blind.off();

    // What the account actually did, from the ledger. Failed transactions
    // included, and filtered to the ones this wallet paid for, so friendbot's
    // create-account does not count as ours.
    await page.waitForTimeout(3000);
    const mine = await ownTransactions(address);
    const landed = mine.filter((t) => t.successful);
    const paid = landed.reduce((n, t) => n + Number(t.feeCharged), 0);

    // What the wallet believes, next to what the ledger did. Every registration
    // that landed and was not read back is an auditor key this account owns and
    // can never name again, paid for and orphaned.
    const keys = await storageKeys(page);
    const recorded = keys.filter((k) => k.startsWith("pocket.auditorid."));

    expect(
      landed.length,
      `a submission whose outcome is unknown may still land, so it must not be sent again. ` +
        `The ledger applied ${landed.length} of this wallet's transactions ` +
        `(${landed.map((t) => t.hash.slice(0, 8)).join(", ")}) for ${paid} stroops, ` +
        `and the wallet recorded ${recorded.length} auditor ids.`,
    ).toBeLessThanOrEqual(1);

    // And the one submission it did make must still be findable. An unresolved
    // transaction whose hash is gone can never be reconciled by anything, which
    // is the same loss as never having recorded it.
    expect(keys, "a submission left unresolved must leave the hash that can resolve it").toContain(
      "pocket.inflight",
    );
  } finally {
    await w.close();
  }
});

test("a merge is refused while an unrelated transaction is still unresolved", async () => {
  test.setTimeout(900_000);
  const { w, page, address } = await fundedWallet();
  try {
    await register(page);
    await expect(page.getByRole("button", { name: "Private", exact: true })).toBeVisible({
      timeout: 180_000,
    });

    // A payment, submitted and left unresolved: the poll is blinded so the
    // worker never learns the outcome, which is the routine MV3 case.
    const blind = await blindConfirmationPolls(w);
    blind.on();
    const built = await send<{ xdr: string }>(page, {
      type: "buildPayment",
      to: await fundedStranger(),
      amount: "1",
      assetId: "native",
    });
    expect(built.ok, JSON.stringify(built)).toBe(true);
    await send(page, { type: "confirmPayment", handle: built.data!.xdr });

    const record = (await storage(page))["pocket.inflight"] as { hash: string } | undefined;
    expect(record, "the payment must be on disk as unresolved").toBeTruthy();

    // The outstanding envelope is a PAYMENT. It may still land, and it consumed
    // a sequence number a merge built now would take as well. A merge folding
    // the receiving balance twice is harmless; a merge racing a payment for one
    // sequence number is not, and that is what this guard is for.
    const merge = await send(page, { type: "buildPrivateOp", op: { kind: "merge" } });
    blind.off();
    expect(
      merge.ok,
      `a merge must not be built against a sequence an unresolved payment may still ` +
        `consume. The wallet answered: ${JSON.stringify(merge)}`,
    ).toBe(false);
    expect(merge.error).toMatch(/has not resolved yet/);
    void address;
  } finally {
    await w.close();
  }
});

test("the idle lock does not fire in the middle of a private operation", async () => {
  test.setTimeout(900_000);
  const { w, page, address, openingsKey } = await fundedWallet();
  try {
    await openPocket(page);
    await expect(page.getByText(/Not open yet/).first()).toBeVisible({ timeout: 120_000 });
    await openMoveAction(page, "Set up the private pocket");
    await waitForReview(page);

    // Make the operation OUTLAST the alarm, and be able to prove afterwards
    // that it did. The first version of this test delayed each poll by 2.5s,
    // which was not enough: the register confirmed in about fifteen seconds,
    // success re-armed the idle lock to fifteen minutes, and the 30-second
    // alarm never fired at all. The test passed against a build with the
    // deferral deleted, which makes it a test that could not fail.
    //
    // Delays sit under the wallet's own 30-second per-request deadline, so what
    // is being stretched is the operation, not any single request.
    let slow = true;
    await w.ctx.route("**/soroban-testnet.stellar.org/**", async (route) => {
      let method: string | undefined;
      try {
        method = (route.request().postDataJSON() as { method?: string })?.method;
      } catch {
        method = undefined;
      }
      if (slow && (method === "getTransaction" || method === "sendTransaction")) {
        // 25s, against the wallet's own 30-second per-request ceiling. The
        // submit and the first confirmation poll together then carry the
        // operation past the 30-second alarm with margin at both ends.
        await new Promise((r) => setTimeout(r, 25_000));
      }
      return route.continue();
    });

    // The idle lock, at the platform's shortest honoured delay, verified to be
    // the pending one before anything starts.
    await page.evaluate(() => chrome.alarms.create("pocket.autolock", { delayInMinutes: 0.5 }));
    const armed = (await alarms(page)).find((a) => a.name === "pocket.autolock");
    expect(armed, "the idle lock must be scheduled").toBeTruthy();
    const deadline = armed!.scheduledTime;
    expect(deadline - Date.now()).toBeLessThan(45_000);

    const startedAt = Date.now();
    void page.getByRole("button", { name: "Approve" }).click();

    // Locking here would strand a transaction that has already been submitted:
    // the write that records what it did needs the very keys the lock destroys,
    // and `clearSession` zeroes the seed in place, so an operation already
    // holding a reference is not spared. The money would be on chain with
    // nothing on this device able to open it.
    let sawLocked = false;
    let finishedAt = 0;
    while (Date.now() - startedAt < 150_000) {
      if ((await page.getByText("Success").count()) > 0) {
        finishedAt = Date.now();
        break;
      }
      const s = await send<{ locked: boolean }>(page, { type: "status" });
      if (s.data?.locked) sawLocked = true;
      await page.waitForTimeout(2000);
    }
    slow = false;

    // Cause before consequence. With the deferral removed both of these fire,
    // and the lock is the one worth reading first.
    expect(
      sawLocked,
      "the wallet locked itself in the middle of a private operation, which strands " +
        "whatever it had already submitted",
    ).toBe(false);
    expect(
      finishedAt,
      "the operation never completed, so whatever it submitted was stranded",
    ).toBeGreaterThan(0);
    // And the assertion that makes the two above mean anything: the alarm's
    // moment has to have fallen INSIDE the operation. Without it the whole test
    // passes whenever the operation happens to finish early, which is exactly
    // how its first version fooled me into thinking the deferral was covered.
    expect(
      finishedAt,
      "the operation finished before the idle lock was due, so this test proved nothing",
    ).toBeGreaterThan(deadline);

    // And the deferral did its job: the consequence was written, not lost.
    expect(await storageKeys(page)).toContain(openingsKey);
    const pocket = await send<{ state: string }>(page, { type: "privatePocket" });
    expect(pocket.data?.state).toBe("ready");
    void address;
  } finally {
    await w.close();
  }
});
