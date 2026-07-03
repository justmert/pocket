import { test, expect, type Page } from "@playwright/test";
import {
  addressOf,
  fund,
  fundedStranger,
  killWorker,
  launch,
  ledgerPayments,
  onboard,
  send,
  storage,
  storageKeys,
  unlockUi,
  waitForFunded,
  waitForStorage,
  type Wallet,
} from "./harness";

// Real transactions on testnet, interrupted deliberately.
//
// `pocket.inflight` is written BEFORE submission and cleared on every terminal
// outcome. That ordering is the whole defence against paying twice: if the
// worker dies inside the confirmation poll the record survives, and the next
// popup finds it instead of composing a second payment against a sequence
// number the first may still consume. Every test here checks the LEDGER, which
// shares no code with the wallet, rather than the screen.

const AMOUNT = "5";

async function fundedWallet(): Promise<{ w: Wallet; page: Page; address: string }> {
  const w = await launch();
  const page = await w.popup();
  await onboard(page);
  const address = await addressOf(page);
  await fund(address);
  await waitForFunded(address);
  return { w, page, address };
}

/** Compose and review a payment, stopping on the confirm screen. */
async function review(page: Page, to: string, amount = AMOUNT): Promise<void> {
  await page.getByRole("button", { name: "Send" }).click();
  await page.getByRole("textbox", { name: "Recipient" }).fill(to);
  await page.getByRole("textbox", { name: "Amount (XLM)" }).fill(amount);
  await page.getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("button", { name: "Confirm and send" })).toBeVisible({
    timeout: 60_000,
  });
}

test("a payment records its hash before submitting and clears it on success", async () => {
  test.setTimeout(300_000);
  const { w, page, address } = await fundedWallet();
  try {
    const to = await fundedStranger();
    await review(page, to);

    // Not awaited: the record has to be caught while the payment is running.
    void page.getByRole("button", { name: "Confirm and send" }).click();

    const during = await waitForStorage(
      page,
      (s) => typeof s["pocket.inflight"] === "object" && s["pocket.inflight"] !== null,
      "the hash must be on disk BEFORE the network is asked",
    );
    const record = during["pocket.inflight"] as { hash: string; maxTime: number };
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(record.maxTime, "without time bounds expiry is undecidable").toBeGreaterThan(0);

    await expect(page.getByText("Sent")).toBeVisible({ timeout: 120_000 });
    expect(await storageKeys(page)).not.toContain("pocket.inflight");

    // The ledger's version of events.
    const paid = (await ledgerPayments(address)).filter((p) => p.to === to);
    expect(paid, "exactly one payment must exist").toHaveLength(1);
    expect(paid[0]?.amount).toBe("5.0000000");
    expect(paid[0]?.transaction_hash).toBe(record.hash);
  } finally {
    await w.close();
  }
});

test("the worker dying mid-poll leaves the hash on disk and the wallet never resends", async () => {
  test.setTimeout(300_000);
  const { w, page, address } = await fundedWallet();
  try {
    const to = await fundedStranger();

    // The expensive case has to be reached deliberately: the money HAS moved
    // and the worker dies before it finds out. Left to chance the worker's own
    // poll wins the race and there is nothing to interrupt. Only the
    // confirmation poll is blocked, at the network boundary; the payment itself
    // is submitted for real and really lands.
    let blindPolls = true;
    await w.ctx.route("**/soroban-testnet.stellar.org/**", async (route) => {
      let method: string | undefined;
      try {
        method = (route.request().postDataJSON() as { method?: string })?.method;
      } catch {
        method = undefined;
      }
      if (blindPolls && method === "getTransaction") return route.abort("failed");
      return route.continue();
    });

    await review(page, to);
    void page.getByRole("button", { name: "Confirm and send" }).click();

    const during = await waitForStorage(
      page,
      (s) => !!s["pocket.inflight"],
      "no in-flight record was written",
    );
    const hash = (during["pocket.inflight"] as { hash: string }).hash;

    await expect
      .poll(async () => (await ledgerPayments(address)).some((p) => p.transaction_hash === hash), {
        timeout: 120_000,
        intervals: [1000],
      })
      .toBe(true);

    // Killed with the money already gone and the worker none the wiser.
    await killWorker(w, page);
    expect(await storageKeys(page)).toContain("pocket.inflight");
    blindPolls = false;

    // A fresh popup must land on the unfinished-transaction screen, before
    // anything else, showing the hash it cannot account for.
    const reopened = await w.popup();
    await unlockUi(reopened);
    await expect(reopened.getByText("Unfinished transaction")).toBeVisible({ timeout: 60_000 });
    await expect(reopened.getByText(hash)).toBeVisible();
    await expect(reopened.getByText(/Do not send it again/)).toBeVisible();

    await reopened.getByRole("button", { name: "Check now" }).click();
    await expect(reopened.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 120_000 });
    expect(await storageKeys(reopened)).not.toContain("pocket.inflight");

    // The thing this whole mechanism exists for.
    const paid = (await ledgerPayments(address)).filter((p) => p.to === to);
    expect(paid, "the interrupted payment must not have been sent twice").toHaveLength(1);
    expect(paid[0]?.transaction_hash).toBe(hash);
  } finally {
    await w.close();
  }
});

test("no second payment can be built while an earlier one is unresolved", async () => {
  test.setTimeout(300_000);
  const { w, page, address } = await fundedWallet();
  try {
    const to = await fundedStranger();
    await review(page, to);
    void page.getByRole("button", { name: "Confirm and send" }).click();
    await waitForStorage(page, (s) => !!s["pocket.inflight"], "no in-flight record was written");
    await killWorker(w, page);

    const reopened = await w.popup();
    await unlockUi(reopened);
    await expect(reopened.getByText("Unfinished transaction")).toBeVisible({ timeout: 60_000 });

    // The screen is not the guard. A popup that never mounted it, or a stale one
    // left open, must still be refused at the point where an envelope would be
    // built: two envelopes against one sequence number is how a user pays twice.
    const r = await send(reopened, {
      type: "buildPayment",
      to,
      amount: "1",
      assetId: "native",
    });
    expect(r.ok, JSON.stringify(r)).toBe(false);
    expect(r.error).toMatch(/has not resolved yet/);
    expect(r.error).toMatch(/may still land/);

    // And a private spend is refused for the same reason. `unshield` rather
    // than `merge`: merge is now exempt from this guard, which is its own
    // finding and is tested where a registered pocket makes it meaningful.
    const p = await send(reopened, {
      type: "buildPrivateOp",
      op: { kind: "unshield", amount: "1" },
    });
    expect(p.ok).toBe(false);
    expect(p.error).toMatch(/has not resolved yet/);

    // Nothing extra reached the ledger while it was refusing.
    const paid = await ledgerPayments(address);
    expect(paid.filter((x) => x.to === to).length).toBeLessThanOrEqual(1);
  } finally {
    await w.close();
  }
});

test("confirming the same reviewed payment twice at once sends it once", async () => {
  test.setTimeout(300_000);
  const { w, page, address } = await fundedWallet();
  try {
    const to = await fundedStranger();
    const built = await send<{ xdr: string }>(page, {
      type: "buildPayment",
      to,
      amount: AMOUNT,
      assetId: "native",
    });
    expect(built.ok, JSON.stringify(built)).toBe(true);
    const handle = built.data!.xdr;

    // The same reviewed envelope, submitted twice in the same instant. This is
    // what a double tap looks like from the worker's side once the UI's own
    // disabled state has been outrun.
    const replies = await Promise.all([
      send(page, { type: "confirmPayment", handle }),
      send(page, { type: "confirmPayment", handle }),
    ]);
    const ok = replies.filter((r) => r.ok);
    const refused = replies.filter((r) => !r.ok);
    expect(ok, "exactly one confirmation may succeed").toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]?.error).toMatch(/no longer pending confirmation/);

    const paid = (await ledgerPayments(address)).filter((p) => p.to === to);
    expect(paid, "a double confirm must not pay twice").toHaveLength(1);
    expect(paid[0]?.amount).toBe("5.0000000");
    expect(await storageKeys(page)).not.toContain("pocket.inflight");
  } finally {
    await w.close();
  }
});

test("two tabs sending at the same time never pay twice", async () => {
  test.setTimeout(300_000);
  const { w, page, address } = await fundedWallet();
  try {
    const to = await fundedStranger();
    const b = await w.popup();
    await expect(b.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 60_000 });

    // Two DIFFERENT payments, so two genuinely distinct envelopes competing for
    // one account sequence. Identical amounts produce a byte-identical envelope
    // and therefore one shared handle, which quietly turns this into the
    // double-confirm test above instead of the two-tab race it is meant to be.
    const [ba, bb] = await Promise.all([
      send<{ xdr: string }>(page, { type: "buildPayment", to, amount: "5", assetId: "native" }),
      send<{ xdr: string }>(b, { type: "buildPayment", to, amount: "7", assetId: "native" }),
    ]);
    expect(ba.ok && bb.ok, `${JSON.stringify(ba)} ${JSON.stringify(bb)}`).toBe(true);
    expect(ba.data!.xdr, "two different payments must be two different envelopes").not.toBe(
      bb.data!.xdr,
    );

    const replies = await Promise.all([
      send(page, { type: "confirmPayment", handle: ba.data!.xdr }),
      send(b, { type: "confirmPayment", handle: bb.data!.xdr }),
    ]);

    // Two envelopes against one sequence number: only one can ever be included.
    // Waited for rather than sampled, so the assertion below is never skipped
    // by Horizon happening to be a second behind.
    await expect
      .poll(async () => (await ledgerPayments(address)).filter((p) => p.to === to).length, {
        timeout: 120_000,
        intervals: [2000],
      })
      .toBe(1);

    // One of them has to lose, and the loser must be TOLD, not left to think it
    // worked: a user who is told a payment went through when it did not sends
    // it again by hand, which is the one thing none of this may cause.
    expect(
      replies.filter((r) => r.ok),
      `only the payment that landed may report success: ${JSON.stringify(replies)}`,
    ).toHaveLength(1);
    for (const f of replies.filter((r) => !r.ok)) {
      expect(f.error, "a failed submission must say so in words a user can act on").toBeTruthy();
      expect(f.error).not.toMatch(/undefined|\[object/i);
    }

    // Whatever happened, nothing may be left unaccounted for.
    await expect
      .poll(async () => (await storage(page))["pocket.inflight"] ?? null, { timeout: 120_000 })
      .toBeNull();
  } finally {
    await w.close();
  }
});

test("reloading the popup mid-payment does not send it again", async () => {
  test.setTimeout(300_000);
  const { w, page, address } = await fundedWallet();
  try {
    const to = await fundedStranger();

    // Hold the confirmation poll open so the reload genuinely lands in the
    // middle of the flow rather than after it.
    let blindPolls = true;
    await w.ctx.route("**/soroban-testnet.stellar.org/**", async (route) => {
      let method: string | undefined;
      try {
        method = (route.request().postDataJSON() as { method?: string })?.method;
      } catch {
        method = undefined;
      }
      if (blindPolls && method === "getTransaction") return route.abort("failed");
      return route.continue();
    });

    await review(page, to);
    void page.getByRole("button", { name: "Confirm and send" }).click();
    const during = await waitForStorage(
      page,
      (s) => !!s["pocket.inflight"],
      "no in-flight record was written",
    );
    const hash = (during["pocket.inflight"] as { hash: string }).hash;

    // F5 in the middle of "Submitting and waiting for the ledger…". The popup's
    // own state is gone; the transaction is not.
    await page.reload();
    await expect(page.getByText("Unfinished transaction")).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(hash)).toBeVisible();
    blindPolls = false;

    await page.getByRole("button", { name: "Check now" }).click();
    await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 120_000 });

    const paid = (await ledgerPayments(address)).filter((p) => p.to === to);
    expect(paid, "a refresh must not turn one payment into two").toHaveLength(1);
    expect(paid[0]?.transaction_hash).toBe(hash);
    expect(await storageKeys(page)).not.toContain("pocket.inflight");
  } finally {
    await w.close();
  }
});
