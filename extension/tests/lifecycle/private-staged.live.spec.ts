import { test, expect, type Page } from "@playwright/test";
import {
  addressOf,
  fund,
  killWorker,
  launch,
  ledgerTransactions,
  offscreenCount,
  onboard,
  send,
  storage,
  storageKeys,
  TOKEN,
  unlockUi,
  waitForFunded,
  waitForStorage,
  type Wallet,
} from "./harness";

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
  await page.getByRole("button", { name: /private pocket/i }).click();
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
  await expect(page.getByText(/Not set up yet/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Set up the private pocket" }).click();
  await waitForReview(page);
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Confirmed on the ledger/)).toBeVisible({ timeout: 300_000 });
}

test("a register killed between submitting and persisting its openings loses nothing", async () => {
  test.setTimeout(900_000);
  const { w, page, address, openingsKey } = await fundedWallet();
  try {
    const blind = await blindConfirmationPolls(w);

    await openPocket(page);
    await expect(page.getByText(/Not set up yet/)).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Set up the private pocket" }).click();
    await waitForReview(page);
    void page.getByRole("button", { name: "Approve" }).click();

    // The staged post-state is written to disk immediately before the register
    // is submitted. From here the worker must not be allowed to see the
    // outcome, or there is nothing left to interrupt.
    const staged = await waitForStorage(
      page,
      (s) => !!s["pocket.staged"],
      "the post-state must be staged to disk BEFORE submitting",
      180_000,
    );
    blind.on();
    expect(staged["pocket.inflight"], "the submitted hash must be recorded too").toBeTruthy();
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
    await expect(reopened.getByText("PUBLIC POCKET")).toBeVisible({ timeout: 180_000 });

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
    await expect(page.getByText(/Not set up yet/)).toBeVisible({ timeout: 120_000 });
    void page.getByRole("button", { name: "Set up the private pocket" }).click();

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
      await expect(reopened.getByText("PUBLIC POCKET")).toBeVisible({ timeout: 180_000 });
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
    await expect(page.getByText("SPENDABLE")).toBeVisible({ timeout: 180_000 });
    const beforeShield = JSON.stringify((await storage(page))[openingsKey]);

    await page.getByRole("button", { name: "Move in" }).click();
    await page.getByRole("textbox", { name: "Amount" }).fill("25");
    await page.getByRole("button", { name: "Review" }).click();
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
    await expect(
      reopened.getByText(/Unfinished transaction|PUBLIC POCKET/),
    ).toBeVisible({ timeout: 120_000 });
    if ((await reopened.getByText("Unfinished transaction").count()) > 0) {
      await reopened.getByRole("button", { name: "Check now" }).click();
    }
    await expect(reopened.getByText("PUBLIC POCKET")).toBeVisible({ timeout: 240_000 });

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
      await expect(reopened.getByText("RECEIVING")).toBeVisible({ timeout: 180_000 });
      await expect(
        reopened.getByText(/Received funds sit here until you make them spendable/),
      ).toBeVisible();
      await reopened.getByRole("button", { name: "Make spendable" }).click();
      await waitForReview(reopened);
      await reopened.getByRole("button", { name: "Approve" }).click();
      try {
        await expect(reopened.getByText(/Confirmed on the ledger/)).toBeVisible({
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
    await expect(page.getByText("SPENDABLE")).toBeVisible({ timeout: 180_000 });
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

    await page.getByRole("button", { name: "Move in" }).click();
    await page.getByRole("textbox", { name: "Amount" }).fill("25");
    await page.getByRole("button", { name: "Review" }).click();
    await waitForReview(page);
    submissions = 0;
    stopMerge = true;
    await page.getByRole("button", { name: "Approve" }).click();

    await expect(page.getByText(/deposit succeeded/)).toBeVisible({ timeout: 300_000 });
    await expect(page.getByText(/receiving balance/)).toBeVisible();
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
    await expect(page.getByText("SPENDABLE")).toBeVisible({ timeout: 180_000 });

    const built = await send<{ handle: string }>(page, {
      type: "buildPrivateOp",
      op: { kind: "merge" },
    });
    expect(built.ok, JSON.stringify(built)).toBe(true);
    const handle = built.data!.handle;

    const before = (await ledgerTransactions(await addressOf(page))).length;
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
    ).toMatch(/no longer pending confirmation/);

    await expect
      .poll(async () => (await ledgerTransactions(await addressOf(page))).length, {
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
    await expect(page.getByText("SPENDABLE")).toBeVisible({ timeout: 180_000 });
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
