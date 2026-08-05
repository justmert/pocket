import { test, expect } from "@playwright/test";
import {
  addressOf,
  alarms,
  killWorker,
  launch,
  onboard,
  PASSWORD,
  relaunch,
  send,
  storage,
  storageKeys,
  unlockUi,
} from "./harness";

// The spine of this slice. MV3 evicts the service worker whenever it likes, and
// the worker owns the vault, the session and every chain call. So each of these
// asks the same question of a different moment: the worker just died. What
// survived, what did not, and is the user told the truth about which?

test("a worker eviction inside the idle window comes back unlocked", async () => {
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);
    const address = await addressOf(page);
    const before = await storageKeys(page);

    await killWorker(w, page);

    // NOT a lock. MV3 evicts the worker constantly, and the DEK is mirrored in
    // session storage (RAM, wiped on browser close) so a fresh worker re-opens
    // the vault without the password, up to the idle deadline. This is the
    // MetaMask model, and the point of the mirror.
    const status = await send<{ locked: boolean; initialised: boolean; address?: string }>(page, {
      type: "status",
    });
    expect(status.ok, JSON.stringify(status)).toBe(true);
    expect(status.data?.locked, "an eviction inside the window must not lock").toBe(false);
    expect(status.data?.address).toBe(address);

    // Nothing on DISK changed, and nothing on disk unlocks it: the mirror is in
    // session storage, not local. `storageKeys` reads local only.
    expect(await storageKeys(page)).toEqual(before);
    expect(before).toContain("pocket.vault");
    expect(before).toContain("pocket.state");
    expect(before).toContain("pocket.address");

    // A reopened page lands on Home, still unlocked, on the same account.
    const reopened = await w.popup();
    await expect(reopened.getByRole("button", { name: "Public pocket" })).toBeVisible({
      timeout: 60_000,
    });
    expect(await addressOf(reopened)).toBe(address);
  } finally {
    await w.close();
  }
});

test("the worker leaves nothing on disk that would unlock the wallet without the password", async () => {
  const w = await launch();
  try {
    const page = await w.popup();
    const phrase = await onboard(page);
    await killWorker(w, page);

    const blob = JSON.stringify(await storage(page));
    for (const word of phrase.split(" ")) {
      // A BIP-39 word is 3-8 characters, so a bare substring search would hit
      // base64 by chance. Word boundaries make the match mean what it says.
      expect(blob, `the recovery phrase must never be on disk in the clear`).not.toMatch(
        new RegExp(`(^|[^A-Za-z])${word}([^A-Za-z]|$)`),
      );
    }
    expect(blob).not.toMatch(/"(dek|seed|mnemonic|password)"\s*:/);
  } finally {
    await w.close();
  }
});

test("a wallet whose worker died before the backup was acknowledged is not orphaned", async () => {
  test.setTimeout(240_000);
  const w = await launch();
  const second = await launch();
  try {
    // Stop on the backup screen: the vault is already written and the session
    // is already live, but the user has not pressed anything yet.
    const page = await w.popup();
    await page.getByRole("button", { name: "Create a new wallet" }).click();
    await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
    await page.getByRole("button", { name: "Create wallet" }).click();
    await expect(page.getByText("Save your recovery phrase")).toBeVisible({ timeout: 60_000 });
    await page.getByRole("button", { name: "Show the phrase" }).click();
    const phrase = (
      await page
        .locator("span")
        .filter({ hasText: /^\d+\.\s\w+\s*$/ })
        .allInnerTexts()
    )
      .map((c) => c.replace(/^\d+\.\s*/, "").trim())
      .join(" ");

    await killWorker(w, page);

    // The wallet exists. It must present as locked, never as a fresh install:
    // offering onboarding here is how a user creates a SECOND seed over the one
    // whose phrase they just wrote down.
    const reopened = await w.popup();
    await expect(reopened.getByText(/Enter your password to unlock Pocket/)).toBeVisible();
    await unlockUi(reopened);
    await expect(reopened.getByRole("button", { name: "Public pocket" })).toBeVisible({
      timeout: 60_000,
    });
    const address = await addressOf(reopened);

    // And the words that were on screen when it died are the words that own it.
    const p2 = await second.popup();
    await p2.getByRole("button", { name: /recovery phrase/i }).click();
    await p2.getByRole("textbox", { name: /Recovery phrase/i }).fill(phrase);
    await p2.getByRole("textbox", { name: "New password", exact: true }).fill(PASSWORD);
    // The restore screen asks twice; one field leaves the submit disabled.
    await p2.getByRole("textbox", { name: "Confirm new password", exact: true }).fill(PASSWORD);
    await p2.getByRole("button", { name: "Restore wallet" }).click();
    await expect(p2.getByRole("button", { name: "Public pocket" })).toBeVisible({
      timeout: 60_000,
    });
    expect(await addressOf(p2)).toBe(address);
  } finally {
    await w.close();
    await second.close();
  }
});

test("worker death with nothing submitted leaves no in-flight or staged record", async () => {
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);
    await killWorker(w, page);

    const keys = await storageKeys(page);
    expect(keys).not.toContain("pocket.inflight");
    expect(keys).not.toContain("pocket.staged");

    // And the popup must not show the unfinished-transaction screen for a
    // wallet that has never submitted anything.
    const reopened = await w.popup();
    await unlockUi(reopened);
    await expect(reopened.getByRole("button", { name: "Public pocket" })).toBeVisible({
      timeout: 60_000,
    });
    await expect(reopened.getByText("Unfinished transaction")).toHaveCount(0);
  } finally {
    await w.close();
  }
});

test("a second tab left on Home after the first locked cannot spend", async () => {
  const w = await launch();
  try {
    const a = await w.popup();
    await onboard(a);
    const b = await w.popup();
    await expect(b.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 60_000 });

    await a.getByRole("button", { name: "More" }).click();
    await a.getByRole("menuitem", { name: "Lock wallet" }).click();
    await expect(a.getByText(/Enter your password to unlock Pocket/)).toBeVisible();

    // Tab B still renders Home. That is stale UI, which is survivable; what is
    // not survivable is a stale tab still being able to act.
    await b.getByRole("button", { name: "Actions", exact: true }).click();
    await b.getByRole("menuitem", { name: "Send", exact: true }).click();
    await b
      .getByRole("textbox", { name: "To", exact: true })
      .fill("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7");
    await b.getByRole("textbox", { name: "Amount (XLM)" }).fill("1");
    await b.getByRole("button", { name: "Continue" }).click();
    await expect(b.getByText("Wallet is locked.")).toBeVisible({ timeout: 30_000 });

    // Nothing was built, nothing was staged.
    const keys = await storageKeys(b);
    expect(keys).not.toContain("pocket.inflight");
    expect(keys).not.toContain("pocket.staged");
  } finally {
    await w.close();
  }
});

test("a browser restart keeps the wallet exactly as it was", async () => {
  const first = await launch();
  const dir = first.dir;
  try {
    const page = await first.popup();
    await onboard(page);
    const address = await addressOf(page);
    const keys = await storageKeys(page);
    await first.suspend();

    const again = await relaunch(dir);
    try {
      const page2 = await again.popup();
      await expect(page2.getByText(/Enter your password to unlock Pocket/)).toBeVisible();
      expect(await storageKeys(page2)).toEqual(keys);
      await unlockUi(page2);
      await expect(page2.getByRole("button", { name: "Public pocket" })).toBeVisible({
        timeout: 60_000,
      });
      expect(await addressOf(page2)).toBe(address);
    } finally {
      await again.close();
    }
  } catch (e) {
    await first.close().catch(() => undefined);
    throw e;
  }
});

test("the keep-alive check is not pushed further away by every worker start", async () => {
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);

    const first = (await alarms(page)).find((a) => a.name === "pocket.keepalive");
    expect(first, "a keep-alive check must be scheduled").toBeDefined();
    const scheduled = first!.scheduledTime;

    // MV3 restarts the worker constantly, and `alarms.create` REPLACES a
    // same-named alarm. If the startup path recreated it unconditionally, a user
    // who opens their wallet more often than hourly would never have one fire,
    // and the confidential entry archives on a timer that does not care.
    // Each answered status is a cold worker that has run its startup path: the
    // listener only replies after the module body, which is where the schedule
    // is ensured. Two more round-trips after the last kill, so anything that
    // startup queued has been issued before the alarm is read back.
    for (let i = 0; i < 3; i++) {
      await killWorker(w, page);
      expect((await send(page, { type: "status" })).ok).toBe(true);
    }
    expect((await send(page, { type: "status" })).ok).toBe(true);

    const after = (await alarms(page)).find((a) => a.name === "pocket.keepalive");
    expect(after, "the schedule must survive a worker restart").toBeDefined();
    expect(
      after!.scheduledTime,
      "three worker restarts must not have moved the keep-alive check",
    ).toBe(scheduled);
  } finally {
    await w.close();
  }
});

/**
 * Bring the idle lock forward to the platform's shortest honoured delay.
 *
 * The 15-minute constant is not the behaviour under test; "the idle lock fires,
 * a poll does not postpone it, and real activity does" is. The wait and the
 * assertion afterwards matter: Home reads balances on mount, that read IS user
 * activity, and it re-arms the lock, so an alarm set before it lands is
 * silently replaced by a 15-minute one and the test would measure nothing.
 */
async function armIdleLock(page: import("@playwright/test").Page): Promise<void> {
  await expect(page.getByText("Reading the ledger")).toHaveCount(0, { timeout: 60_000 });
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.waitForTimeout(750);
    await page.evaluate(() => chrome.alarms.create("pocket.autolock", { delayInMinutes: 0.5 }));
    const a = (await alarms(page)).find((x) => x.name === "pocket.autolock");
    if (a && a.scheduledTime - Date.now() < 45_000) return;
  }
  throw new Error("could not bring the idle lock forward: something keeps re-arming it");
}

test("the idle lock fires, and a status poll does not hold it off", async () => {
  test.setTimeout(180_000);
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);
    await armIdleLock(page);

    let lockedAt = -1;
    for (let i = 0; i < 22 && lockedAt < 0; i++) {
      await page.waitForTimeout(3000);
      // Polling status keeps the worker warm, so a lock here is the alarm's
      // doing and not eviction. It is also NOT user activity, so it must not
      // hold the lock off: a wallet left open on the home screen must still
      // lock itself.
      const s = await send<{ locked: boolean }>(page, { type: "status" });
      expect(s.ok).toBe(true);
      if (s.data?.locked) lockedAt = i;
    }
    expect(lockedAt, "the idle alarm must lock the wallet").toBeGreaterThanOrEqual(0);

    // And the lock is a real one: the vault is intact and the password gets in.
    const reopened = await w.popup();
    await unlockUi(reopened);
    await expect(reopened.getByRole("button", { name: "Public pocket" })).toBeVisible({
      timeout: 60_000,
    });
  } finally {
    await w.close();
  }
});

test("real user activity postpones the idle lock", async () => {
  test.setTimeout(180_000);
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);
    await armIdleLock(page);

    // Halfway through the window, do something a user does. That must re-arm
    // the lock; otherwise a wallet locks itself out from under someone who is
    // actively using it.
    await page.waitForTimeout(15_000);
    const b = await send(page, { type: "balances" });
    expect(b.ok, JSON.stringify(b)).toBe(true);

    // Keep the worker warm without counting as activity, well past the original
    // deadline.
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(4000);
      const s = await send<{ locked: boolean }>(page, { type: "status" });
      expect(s.ok).toBe(true);
      expect(s.data?.locked, "activity must have postponed the idle lock").toBe(false);
    }
  } finally {
    await w.close();
  }
});
