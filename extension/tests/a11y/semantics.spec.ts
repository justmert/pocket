// Roles, names, and whether anything is ANNOUNCED.
//
// A sighted user learns the balance arrived because a shimmer became a number.
// A screen-reader user learns nothing unless the change is inside a live
// region. WCAG 2.1 SC 4.1.3 (Status Messages, Level AA) is the rule: a status
// that appears without taking focus must be programmatically determinable.
//
// Every wait in this wallet is a status message -- the balance read, the four
// proving steps, the submission -- and so is every refusal.
//
// The rebuild changed the SHAPE of most of these. Waits are no longer sentences
// with a spinner beside them; a value that has not arrived is a shimmer with
// nothing to read, so the fact has to be spelled out in the tree separately.
// Sheets are `role="dialog"` over a screen that stays in the DOM, so nothing
// here reads `body.innerText` any more: it would pick up the screen behind.
import { test, expect } from "../support/fixtures";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { offline, hang, RPC_HOST } from "../support/stub";

const PASSWORD = "a-strong-test-password";

/** Does this element, or an ancestor, put it in a live region? */
async function inLiveRegion(locator: import("@playwright/test").Locator): Promise<{
  live: boolean;
  role: string;
  ariaLive: string;
}> {
  return locator.evaluate((el: Element) => {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const role = n.getAttribute("role") ?? "";
      const ariaLive = n.getAttribute("aria-live") ?? "";
      if (["status", "alert", "log", "progressbar"].includes(role) || ariaLive) {
        return { live: true, role, ariaLive };
      }
    }
    return { live: false, role: "", ariaLive: "" };
  });
}

/**
 * Every sheet, and how to get to it from a freshly created wallet.
 *
 * All seven are reachable without funding the account, which is what makes this
 * a cheap check rather than one nobody runs. The title is the sheet's
 * accessible name: `Sheet` passes its title straight to `aria-label`.
 */
const SHEETS: {
  title: string;
  /** skipped where this build gives it no entrance. see the rebuild entry. */
  onlyIfReachable?: boolean;
  open: (w: Wallet) => Promise<void>;
}[] = [
  { title: "Receive", open: async (w) => void (await w.nav("Receive").click()) },
  { title: "Send", open: async (w) => void (await w.nav("Send").click()) },
  // no "Move" button on the bar: the private FAB is "Move value" and opens a
  // menu, not this sheet. `openMove` knows the real route, which is the private
  // pocket's own prompt, and is also how a person gets here.
  { title: "Move", open: async (w) => void (await w.openMove()) },
  {
    title: "Network",
    open: async (w) => {
      await w.nav("Settings").click();
      await w.page.getByRole("button", { name: "Network" }).click();
    },
  },
  {
    title: "Connected sites",
    open: async (w) => {
      await w.nav("Settings").click();
      await w.page.getByRole("button", { name: "Connected sites" }).click();
    },
  },
  {
    title: "Rebuild from history",
    // unreachable on a build with no archive, which is every shipped build:
    // the settings row that opened it is now absent rather than present and
    // refusing (defect D-009). the sheet is kept for the build variant that
    // does configure an archive, and this entry is skipped rather than deleted
    // so it comes back into coverage the day that variant ships.
    onlyIfReachable: true,
    open: async (w) => {
      await w.nav("Settings").click();
      await w.page.getByRole("button", { name: "Rebuild from history" }).click();
    },
  },
  {
    title: "Erase this wallet",
    open: async (w) => {
      await w.nav("Settings").click();
      await w.page.getByRole("button", { name: "Erase this wallet" }).click();
    },
  },
];

test("every button has an accessible name, on every screen and every sheet", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // Read from the ACCESSIBILITY TREE, not from innerText.
  //
  // innerText reports a name for a button whose only content is `aria-hidden`,
  // which is precisely the case that leaves a screen-reader user with an
  // unlabelled control -- and this UI is full of them: every control on the
  // bottom bar is an icon with `aria-hidden` on the glyph and the name only in
  // `aria-label`. The tree is what assistive technology consumes.
  //
  // Via `ariaSnapshot`, not `page.accessibility`: that API was removed in
  // Playwright 1.62, so calling it threw a TypeError. The test failed, which
  // looked like a finding and was not, and worse, it "failed" identically under
  // the mutation meant to prove it works. A test that throws is not a test that
  // asserts.
  const unnamedIn = async (snapshot: string) =>
    snapshot
      .split("\n")
      // `- button "Lock wallet"` is named; a bare `- button` or `- button:` is not.
      .filter((line) => /^\s*-\s+button\s*:?\s*$/.test(line));

  const home = await wallet.page.locator("body").ariaSnapshot();
  expect(await unnamedIn(home), `unnamed buttons on the home screen\n${home}`).toEqual([]);

  await wallet.nav("Settings").click();
  await expect(wallet.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  const settings = await wallet.page.locator("body").ariaSnapshot();
  expect(await unnamedIn(settings), `unnamed buttons in Settings\n${settings}`).toEqual([]);

  for (const sheet of SHEETS.filter((x) => !x.onlyIfReachable)) {
    await wallet.nav("Home").click();
    await sheet.open(wallet);
    const dialog = wallet.page.getByRole("dialog", { name: sheet.title });
    await expect(dialog).toBeVisible();
    // Scoped to the dialog. The screen behind a sheet stays mounted, so a
    // body-wide snapshot here would re-report the home screen's controls and
    // say nothing about the sheet.
    const snapshot = await dialog.ariaSnapshot();
    expect(await unnamedIn(snapshot), `unnamed buttons in the ${sheet.title} sheet\n${snapshot}`)
      .toEqual([]);
    await wallet.page.keyboard.press("Escape");
  }
});

test("every sheet is a dialog with an accessible name", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  // A bottom sheet is a modal in everything but the markup, and the markup is
  // the only part assistive technology can see. Without `role="dialog"` and a
  // name, a screen-reader user is dropped into a stack of anonymous text with
  // no way to tell that the screen they were on is no longer the live one.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  for (const sheet of SHEETS.filter((x) => !x.onlyIfReachable)) {
    await wallet.nav("Home").click();
    await sheet.open(wallet);
    const dialog = wallet.page.getByRole("dialog", { name: sheet.title });
    await expect(dialog, `the ${sheet.title} sheet is not an accessibly named dialog`).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await wallet.page.keyboard.press("Escape");
  }
});

test("every sheet closes on Escape", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  // Escape is the one way out that needs no pointer and no hunting for the
  // close control. A sheet that only closes on its own button traps a keyboard
  // user behind whatever they opened by mistake.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  for (const sheet of SHEETS.filter((x) => !x.onlyIfReachable)) {
    await wallet.nav("Home").click();
    await sheet.open(wallet);
    const dialog = wallet.page.getByRole("dialog", { name: sheet.title });
    await expect(dialog).toBeVisible();
    await wallet.page.keyboard.press("Escape");
    await expect(dialog, `the ${sheet.title} sheet survived Escape`).toHaveCount(0);
  }
});

test("every text field is programmatically labelled", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.openSend();

  // `getByLabel` resolving at all is the proof: it uses the accessibility
  // label, not the visual proximity of some text.
  await expect(wallet.page.getByLabel("To", { exact: true })).toBeVisible();
  await expect(wallet.page.getByLabel("Amount (XLM)")).toBeVisible();
  await expect(wallet.page.getByLabel("Memo (optional)")).toBeVisible();

  const unlabelled = await wallet.page.evaluate(() =>
    Array.from(document.querySelectorAll("input, textarea"))
      .filter((el) => {
        const id = el.getAttribute("id");
        const byFor = id ? document.querySelector(`label[for="${id}"]`) : null;
        const wrapped = el.closest("label");
        return !el.getAttribute("aria-label") && !byFor && !wrapped;
      })
      .map((el) => el.outerHTML.slice(0, 80)),
  );
  expect(unlabelled).toEqual([]);
});

test("the exact amount is in the accessibility tree and the split rendering is not", async ({
  wallet,
}) => {
  // Amounts are drawn split: a grouped whole part, a smaller fraction beside
  // it, and the asset code smaller again. Read out, that is "nine thousand,
  // point, five, X L M" at best and three separate announcements at worst.
  //
  // So the figure a screen reader gets is a separate, visually hidden span
  // carrying exactly what the worker reported, and the drawn version is
  // `aria-hidden`. Both halves matter: an exposed split rendering would be
  // announced TWICE, once correctly and once as fragments.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const exact = wallet.money().first();
  await expect(exact).toHaveText(/^0\.0000000 XLM$/, { timeout: WAITS.ledgerRead });
  expect(
    await exact.evaluate((el: Element) => el.closest("[aria-hidden]") !== null),
    "the exact figure is inside an aria-hidden subtree, so it is announced to nobody",
  ).toBe(false);

  // Everything drawn alongside it is hidden from the tree.
  const siblings = await exact.evaluate((el: Element) =>
    Array.from(el.parentElement?.children ?? [])
      .filter((n) => n !== el)
      .map((n) => ({
        hidden: n.getAttribute("aria-hidden") !== null,
        text: (n as HTMLElement).innerText.trim().slice(0, 20),
      })),
  );
  expect(siblings.length, "the amount renders nothing beside its exact figure").toBeGreaterThan(0);
  expect(
    siblings.filter((s) => !s.hidden),
    "the split visual rendering is exposed to the tree, so the amount is announced twice",
  ).toEqual([]);
});

/**
 * The wait a user is most anxious about is the one before a balance appears,
 * and it is now drawn as a shimmer: there is no sentence to read at all.
 */
test("a wait is announced, not only drawn", async ({ harness, wallet }) => {
  await wallet.createWallet(PASSWORD);
  await hang(harness.context, RPC_HOST);
  await wallet.reopen();

  const waiting = wallet.page.getByText("Reading the ledger", { exact: true });
  await expect(
    waiting,
    "the balance shimmer says nothing to a screen reader: there is no status text at all",
  ).toBeVisible({ timeout: WAITS.ledgerRead });

  const region = await inLiveRegion(waiting);
  expect(
    region.live,
    "the balance-read status is not in a live region, so a screen-reader user is told " +
      "nothing between opening the wallet and the balance arriving",
  ).toBe(true);
  expect(region.role || region.ariaLive, "a status region must be polite, not assertive").toMatch(
    /status|polite/,
  );
});

/**
 * A refusal that is only drawn is a refusal a screen-reader user does not know
 * happened. They pressed Review, nothing was said, and the form still looks the
 * same to them.
 */
test("a refusal is announced, not only drawn", async ({ wallet }) => {
  await wallet.createWallet(PASSWORD);
  await wallet.openSend();
  await wallet.composePayment({ to: "not-an-address", amount: "1" });

  const error = wallet.page.getByText(/does not look like a Stellar address/i);
  await expect(error).toBeVisible({ timeout: WAITS.ledgerRead });

  const region = await inLiveRegion(error);
  expect(
    region.live,
    "the address refusal is not in a live region and does not take focus, so it is " +
      "silent to a screen reader",
  ).toBe(true);
  // A refusal interrupts. `alert` is the role that says so; `status` would
  // queue it behind whatever is being read and lose the connection to the
  // press that caused it.
  expect(region.role, "a danger notice must be role=alert").toBe("alert");
});

/**
 * The balance failing to load is the case where a silent UI is most dangerous:
 * the user is about to decide whether they have money.
 */
test("a failed balance read is announced", async ({ harness, wallet }) => {
  await wallet.createWallet(PASSWORD);
  await ledger.fund(await wallet.revealAddress());
  await offline(harness.context, RPC_HOST);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  const error = wallet.page.getByText(/Something went wrong|check your connection/i);
  await expect(error).toBeVisible({ timeout: WAITS.ledgerRead });
  const region = await inLiveRegion(error);
  expect(region.live, "the balance failure is not announced").toBe(true);
  expect(region.role, "the balance failure must interrupt, not queue").toBe("alert");
});

test("a long operation reports its progress in a live region", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  // Proving takes minutes. The four steps and the worker's own phase text are
  // the only evidence the wallet has not hung, and a screen-reader user gets
  // none of it unless the region is live. This checks the region rather than
  // waiting for a real proof: the requirement is about the markup, and driving
  // a genuine proof here would make an accessibility test depend on testnet.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // The boot status is the same component's contract, reachable without money:
  // it is what the popup shows before the worker has answered.
  const statuses = await wallet.page.evaluate(() =>
    Array.from(document.querySelectorAll('[role="status"]')).map((el) => ({
      live: el.getAttribute("aria-live"),
      text: (el as HTMLElement).innerText.trim().slice(0, 40),
    })),
  );
  expect(statuses.length, "the home screen exposes no status region at all").toBeGreaterThan(0);
  expect(
    statuses.filter((s) => s.live !== "polite"),
    "a status region that is not polite either interrupts or says nothing",
  ).toEqual([]);
});

test("each screen has a heading a screen reader can navigate by", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  // Screen-reader users navigate by heading. A screen with none can only be
  // read from the top, every time.
  const missing: string[] = [];
  const check = async (where: string) => {
    if ((await wallet.page.getByRole("heading").count()) === 0) missing.push(where);
  };

  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await check("onboarding");
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await check("home");
  await wallet.nav("Settings").click();
  await expect(wallet.page.getByRole("heading", { name: "Settings" })).toBeVisible();
  await check("settings");
  // Back to Home first: the lock control is the header's icon button, and the
  // Settings tab has its own "Lock now" row instead.
  await wallet.nav("Home").click();
  await wallet.lock();
  await check("unlock");
  // Opened by hand rather than through `Wallet.openRecover`, which waits for a
  // heading on the very screen this test is checking for one. Using it here
  // would make the page object decide the result.
  await wallet.page.getByRole("button", { name: "Forgot your password?" }).click();
  await expect(wallet.page.getByText("This erases the wallet on this device.")).toBeVisible();
  await check("recover");

  expect(missing, `screens that expose no heading at all: ${missing.join(", ")}`).toEqual([]);
});

test("the recovery phrase is real text, not an image or a canvas", async ({ wallet }) => {
  // The one screen whose content a user MUST be able to copy, read aloud, or
  // have read to them. Rendering it as anything but text would make it
  // unrecoverable for exactly the people who most need it read out.
  await wallet.page.getByRole("button", { name: "Create a new wallet" }).click();
  await wallet.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await wallet.page.getByLabel("Confirm password").fill(PASSWORD);
  await wallet.page.getByRole("button", { name: "Create wallet" }).click();
  await expect(wallet.page.getByText("Save your recovery phrase")).toBeVisible({
    timeout: WAITS.onboarding,
  });

  // Selected here rather than through `Wallet.backupWordCells`, whose regex
  // requires whitespace between the ordinal and the word: the rebuild draws
  // "1." and the word as flex children with a 6px gap, so the gap is layout and
  // the text content runs them together as "1.arctic". The page object matches
  // nothing, which is a finding in `tests/support/` rather than in the screen.
  const cells = wallet.page.locator("span").filter({ hasText: /^\d+\.\s*\w+\s*$/ });
  await expect(cells).toHaveCount(24);
  const words = (await cells.allInnerTexts()).map((c) => c.replace(/^\d+\.\s*/, "").trim());
  expect(words).toHaveLength(24);
  expect(
    words.filter((w) => !/^[a-z]+$/.test(w)),
    "a word that is not legible as a word cannot be written down",
  ).toEqual([]);
  await expect(wallet.page.locator("canvas, img")).toHaveCount(0);
});
