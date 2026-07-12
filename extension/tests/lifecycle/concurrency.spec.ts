import { test, expect, type Page } from "@playwright/test";
import { addressOf, launch, onboard, PASSWORD, send, storage, storageKeys } from "./harness";

// Two things happening at once, and rapid repeats of one thing. Chrome allows a
// single real popup, but an extension page opens in an ordinary tab, so "two
// popups both acting" is reachable by anyone who can type a URL, and every one
// of these flows is one the wallet cannot afford to do twice.

/** Fill the create form without submitting it. */
async function toCreateForm(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
  await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
}

/** The 24 words currently on the backup screen. */
async function shownPhrase(page: Page): Promise<string> {
  const cells = await page
    .locator("span")
    .filter({ hasText: /^\d+\.\s\w+\s*$/ })
    .allInnerTexts();
  return cells.map((c) => c.replace(/^\d+\.\s*/, "").trim()).join(" ");
}

test("every recovery phrase Pocket shows must control the wallet it wrote", async () => {
  test.setTimeout(240_000);
  const w = await launch();
  try {
    const a = await w.popup();
    const b = await w.popup();
    await toCreateForm(a);
    await toCreateForm(b);

    await Promise.all([
      a.getByRole("button", { name: "Create wallet" }).click(),
      b.getByRole("button", { name: "Create wallet" }).click(),
    ]);

    // Settle: each tab has either the backup screen or a visible refusal.
    const settled = async (p: Page) =>
      (await p.getByText("Write this down").count()) +
      (await p.getByText(/already exists|went wrong|malformed/i).count());
    await expect
      .poll(async () => (await settled(a)) && (await settled(b)), { timeout: 90_000 })
      .toBeGreaterThan(0);

    const phrases: string[] = [];
    for (const p of [a, b]) {
      if ((await p.getByText("Write this down").count()) > 0) phrases.push(await shownPhrase(p));
    }

    // The backup screen says these words are the only way to recover the wallet
    // and that Pocket cannot show them again. Every phrase shown under that
    // sentence has to be true, or the user writes down twenty-four words that
    // own nothing and finds out on the day they need them.
    expect(phrases.length, "two tabs must not both be handed a recovery phrase").toBe(1);

    // Exactly one vault, and the address on disk is the one the wallet reports.
    const s = await storage(a);
    expect(Object.keys(s).filter((k) => k === "pocket.vault")).toHaveLength(1);
    const surviving = await addressOf(a);
    expect(s["pocket.address"]).toBe(surviving);

    // And whichever phrases were shown, each must open this account.
    for (const phrase of phrases) {
      const probe = await launch();
      try {
        const p = await probe.popup();
        const r = await send<{ address: string }>(p, {
          type: "import",
          password: PASSWORD,
          mnemonic: phrase,
        });
        expect(r.ok, JSON.stringify(r)).toBe(true);
        expect(r.data?.address, "a phrase Pocket showed must own the wallet it made").toBe(
          surviving,
        );
      } finally {
        await probe.close();
      }
    }
  } finally {
    await w.close();
  }
});

test("two tabs importing at once cannot replace a wallet that already exists", async () => {
  test.setTimeout(180_000);
  const w = await launch();
  try {
    const first = await w.popup();
    const phrase = await onboard(first);
    const address = await addressOf(first);

    // A different, valid phrase. Importing it must not be able to take the
    // device over: the seed already on it is the only recovery material its
    // owner has.
    const other = "legal winner thank year wave sausage worth useful legal winner thank yellow";

    const a = await w.popup();
    const b = await w.popup();
    const results = await Promise.all([
      send(a, { type: "import", password: PASSWORD, mnemonic: other }),
      send(b, { type: "import", password: PASSWORD, mnemonic: phrase }),
    ]);
    for (const r of results) {
      expect(r.ok, `import must be refused while a vault exists: ${JSON.stringify(r)}`).toBe(false);
      expect(r.error).toMatch(/already exists on this device/);
    }

    expect(await addressOf(a)).toBe(address);
  } finally {
    await w.close();
  }
});

test("repeated unlock clicks leave one unlocked wallet, not several sessions", async () => {
  test.setTimeout(180_000);
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);
    const address = await addressOf(page);
    await page.getByRole("button", { name: "Lock wallet" }).click();
    await expect(page.getByText(/Enter your password to unlock Pocket/)).toBeVisible();

    // Five at once, which is what an impatient user's double-tap plus a slow
    // scrypt looks like from the worker's side.
    const replies = await Promise.all(
      Array.from({ length: 5 }, () => send(page, { type: "unlock", password: PASSWORD })),
    );
    for (const r of replies) {
      expect(r.ok, `every unlock with the right password must succeed: ${r.error}`).toBe(true);
    }
    expect(await addressOf(page)).toBe(address);

    // The other half of a double tap: the second press lands AFTER the first
    // has already got in. Two tabs sitting on the unlock screen do this every
    // time, and it must not turn into an error on a wallet that is open.
    const late = await send(page, { type: "unlock", password: PASSWORD });
    expect(late.ok, `unlocking an already-open wallet must not fail: ${late.error}`).toBe(true);

    // And the session that survived the burst has to be a working one, not a
    // half-built one holding key material another attempt zeroed.
    const b = await send(page, { type: "balances" });
    expect(b.ok, `the surviving session must be usable: ${b.error}`).toBe(true);

    // One vault, one address record. A repeated unlock must not rewrite either.
    const keys = await storageKeys(page);
    expect(keys.filter((k) => k.startsWith("pocket.vault"))).toHaveLength(1);
    expect(keys.filter((k) => k.startsWith("pocket.address"))).toHaveLength(1);
  } finally {
    await w.close();
  }
});

test("a wrong password mixed in with right ones never unlocks, and never locks out", async () => {
  test.setTimeout(180_000);
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);
    const address = await addressOf(page);
    await page.getByRole("button", { name: "Lock wallet" }).click();
    await expect(page.getByText(/Enter your password to unlock Pocket/)).toBeVisible();

    const replies = await Promise.all([
      send(page, { type: "unlock", password: "wrong-one" }),
      send(page, { type: "unlock", password: PASSWORD }),
      send(page, { type: "unlock", password: "wrong-two" }),
    ]);
    expect(replies[0].ok).toBe(false);
    expect(replies[0].error).toBe("Wrong password.");
    expect(replies[2].ok).toBe(false);
    expect(replies[2].error).toBe("Wrong password.");
    expect(replies[1].ok, JSON.stringify(replies[1])).toBe(true);

    // The losing attempts must not have clobbered the session the winner set.
    expect(await addressOf(page)).toBe(address);
  } finally {
    await w.close();
  }
});

test("two erase-and-restore submissions at once leave one wallet on the same address", async () => {
  test.setTimeout(240_000);
  const w = await launch();
  try {
    const page = await w.popup();
    const phrase = await onboard(page);
    const address = await addressOf(page);
    await page.getByRole("button", { name: "Lock wallet" }).click();
    await expect(page.getByText(/Enter your password to unlock Pocket/)).toBeVisible();

    const a = await w.popup();
    const b = await w.popup();
    const replies = await Promise.all([
      send(a, { type: "recoverFromMnemonic", mnemonic: phrase, password: "second-password" }),
      send(b, { type: "recoverFromMnemonic", mnemonic: phrase, password: "second-password" }),
    ]);
    // Both racing on one erase-then-import is allowed to have a loser, but it
    // is NOT allowed to end with no wallet, two vaults, or a wallet nobody's
    // password opens.
    expect(
      replies.some((r) => r.ok),
      JSON.stringify(replies),
    ).toBe(true);

    const keys = await storageKeys(a);
    expect(keys.filter((k) => k === "pocket.vault")).toHaveLength(1);
    expect(keys).toContain("pocket.address");

    // A successful restore leaves the wallet open, so the way to prove the
    // vault it wrote is the one the new password opens is to lock it first.
    const reopened = await w.popup();
    await expect(reopened.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 60_000 });
    expect(await addressOf(reopened), "the restored wallet must be the same account").toBe(address);
    await reopened.getByRole("button", { name: "Lock wallet" }).click();
    await expect(reopened.getByText(/Enter your password to unlock Pocket/)).toBeVisible();
    await reopened.getByRole("textbox", { name: "Password", exact: true }).fill("second-password");
    await reopened.getByRole("button", { name: "Unlock" }).click();
    await expect(
      reopened.getByRole("button", { name: "Public pocket" }),
      "the surviving vault must open with the password the restore was given",
    ).toBeVisible({ timeout: 60_000 });
    expect(await addressOf(reopened)).toBe(address);
  } finally {
    await w.close();
  }
});

test("erase-and-restore refuses a phrase belonging to a different wallet", async () => {
  test.setTimeout(180_000);
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);
    const address = await addressOf(page);
    const keysBefore = await storageKeys(page);
    await page.getByRole("button", { name: "Lock wallet" }).click();

    const stranger = "legal winner thank year wave sausage worth useful legal winner thank yellow";
    const r = await send(page, {
      type: "recoverFromMnemonic",
      mnemonic: stranger,
      password: "another-password",
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/different wallet/);

    // Nothing may have been erased on the way to that refusal.
    expect(await storageKeys(page)).toEqual(keysBefore);
    const reopened = await w.popup();
    await reopened.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
    await reopened.getByRole("button", { name: "Unlock" }).click();
    await expect(reopened.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 60_000 });
    expect(await addressOf(reopened)).toBe(address);
  } finally {
    await w.close();
  }
});

test("closing the popup mid-compose loses the draft and nothing else", async () => {
  const w = await launch();
  try {
    const page = await w.popup();
    await onboard(page);
    const before = await storageKeys(page);

    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: "Send", exact: true }).click();
    await page
      .getByRole("textbox", { name: "To", exact: true })
      .fill("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7");
    await page.getByRole("textbox", { name: "Amount (XLM)" }).fill("3");
    await page.getByRole("textbox", { name: "Memo (optional)" }).fill("draft");
    await page.close();

    const reopened = await w.popup();
    // Back at the start, with nothing carried over and nothing left behind.
    await expect(reopened.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 60_000 });
    await expect(reopened.getByText("Unfinished transaction")).toHaveCount(0);
    expect(await storageKeys(reopened)).toEqual(before);

    await reopened.getByRole("button", { name: "Actions", exact: true }).click();
    await reopened.getByRole("menuitem", { name: "Send", exact: true }).click();
    await expect(reopened.getByRole("textbox", { name: "To", exact: true })).toHaveValue("");
    await expect(reopened.getByRole("textbox", { name: "Memo (optional)" })).toHaveValue("");
  } finally {
    await w.close();
  }
});
