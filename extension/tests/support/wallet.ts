// The page object for the popup.
//
// Deliberately thin. It knows how to DRIVE the wallet the way a person does,
// and how to READ what is on screen; it holds no assertions of its own. A page
// object that asserts hides which spec cares about what, and a spec that never
// names its own expectations cannot be reviewed.
//
// Everything is selected by role, accessible name or visible text. Nothing
// selects on a class, a style attribute or a test id, so a restyle cannot break
// the suite, and a change to the WORDS is supposed to break it: the words on a
// signing screen are the product.
import { expect, type Locator, type Page } from "@playwright/test";

/** A G-address, exactly as it must appear on screen: never truncated. */
export const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * An amount, as the accessibility tree carries it: the exact figure, ungrouped,
 * with its code. The visible rendering splits the whole from the fraction and
 * groups the thousands, so this is the one form that is both what a screen
 * reader announces and what the worker actually reported.
 */
export const MONEY_RE = /^-?\d+\.\d{7}\s\w+$/;

/** How long the slowest honest wait is allowed to take, per stage. */
export const WAITS = {
  /** scrypt vault creation, plus the first chain read. */
  onboarding: 60_000,
  /** A balance read against live RPC. */
  ledgerRead: 60_000,
  /** Proving in the offscreen document, then simulation. */
  proving: 240_000,
  /** Submission plus confirmation polling. */
  submission: 300_000,
} as const;

export class Wallet {
  constructor(readonly page: Page) {}

  /** Close and reopen the popup, which is how a real user refreshes it. */
  async reopen(): Promise<void> {
    await this.page.reload();
  }

  // ---------------------------------------------------------------- onboarding

  /** The splash the very first run shows. */
  splash(): Locator {
    return this.page.getByText("Two pockets on Stellar");
  }

  /**
   * Create a wallet and walk through the backup screen to the home screen.
   * Returns the 24 words, read off the backup screen the way a user reads them.
   */
  async createWallet(password: string): Promise<string> {
    await this.page.getByRole("button", { name: "Create a new wallet" }).click();
    await this.page.getByLabel("Password", { exact: true }).fill(password);
    await this.page.getByLabel("Confirm password").fill(password);
    await this.page.getByRole("button", { name: "Create wallet" }).click();
    // The heading the phrase step actually renders. It said "Write this down",
    // which the Onboarding rewrite removed, and this helper is the shared entry
    // point of most of the browser tier: every spec that calls it timed out
    // here, so the whole tier reported a wall of failures with one cause and no
    // product defect behind any of them.
    await expect(this.page.getByRole("heading", { name: "Save your recovery phrase" })).toBeVisible(
      { timeout: WAITS.onboarding },
    );
    await this.showPhrase();
    const phrase = await this.readBackupPhrase();
    await this.page.getByRole("button", { name: "I have written it down" }).click();
    await this.answerBackupCheck(phrase);
    await this.passOnboardingReady();
    await this.waitForHome();
    return phrase;
  }

  /**
   * Leave the "Your wallet is ready!" screen, when onboarding shows one.
   *
   * Onboarding takes a `fullPage` branch whenever it is not the ephemeral
   * (in-popup) placement, and that branch now ends on a completion screen whose
   * Done button closes the TAB rather than routing to home: a real user closes
   * the onboarding tab and reopens the toolbar popup. The harness drives
   * `popup.html` in an ordinary page, which is the fullPage branch, so every
   * spec that calls `createWallet` sat on that screen until it timed out. The
   * whole browser tier went red on one cause with no product defect behind any
   * of it, which is the exact failure mode gate 7 exists to catch and the
   * reason this helper carries its own note.
   *
   * Reopening is modelled as a reload, which is what the harness's `reopen`
   * does and what a user does with the toolbar icon: the vault exists and the
   * session mirror is live, so the popup comes back on home.
   */
  async passOnboardingReady(): Promise<void> {
    // Whichever arrives first. A bare `count()` is a question about this
    // instant, and the vault is still being sealed when it is asked, so it
    // always answered zero and the helper returned before the screen it exists
    // to handle had rendered.
    const ready = this.page.getByRole("heading", { name: "Your wallet is ready!" });
    await expect(ready.or(this.homeMarker()).first()).toBeVisible({ timeout: WAITS.onboarding });
    if ((await ready.count()) > 0) await this.reopen();
  }

  /** The words start hidden so the user chooses the moment they appear. */
  async showPhrase(): Promise<void> {
    const reveal = this.page.getByRole("button", { name: "Show the phrase" });
    if ((await reveal.count()) > 0) await reveal.click();
  }

  /**
   * Answer the three-word check that stands between the phrase and the wallet.
   *
   * The ordinals are chosen at random per run, so they are read off the labels
   * rather than assumed. A test that hardcoded them would pass by luck.
   */
  async answerBackupCheck(phrase: string): Promise<void> {
    const words = phrase.split(" ");
    // The step is TAP CHIPS, not text fields. It used to render inputs labelled
    // "Word N" and this helper typed into them; the Onboarding rewrite replaced
    // that with a pool of word chips placed into three blanks, in order, and
    // the helper is the shared entry point of most of the browser tier.
    //
    // The blanks are asked in phrase order and show their position, so the
    // answer is read off the screen rather than assumed: find each numbered
    // blank, then tap the chip carrying the word at that position.
    const blanks = this.page.getByTestId("verify-blank");
    const n = await blanks.count();
    for (let i = 0; i < n; i++) {
      const ordinal = Number((await blanks.nth(i).getAttribute("data-position")) ?? "0");
      const word = words[ordinal - 1] ?? "";
      await this.page.getByRole("button", { name: word, exact: true }).click();
    }
    await this.page.getByRole("button", { name: "Confirm", exact: true }).click();
  }

  /** The numbered word cells on the backup screen. */
  backupWordCells(): Locator {
    return this.page.locator("span").filter({ hasText: /^\d+\.\s\w+\s*$/ });
  }

  /**
   * The phrase as a user would take it away: the words, in order, without the
   * numbering. Read from the cells rather than from a copy button, so a test
   * that uses it is also checking the words are legible on screen.
   */
  async readBackupPhrase(): Promise<string> {
    const cells = await this.backupWordCells().allInnerTexts();
    return cells.map((c) => c.replace(/^\d+\.\s*/, "").trim()).join(" ");
  }

  async importPhrase(phrase: string, password: string): Promise<void> {
    await this.page.getByRole("button", { name: "I have a recovery phrase" }).click();
    await this.page.getByLabel(/Recovery phrase/).fill(phrase);
    await this.page.getByLabel("New password", { exact: true }).fill(password);
    await this.page.getByRole("button", { name: "Import wallet" }).click();
    await this.passOnboardingReady();
    await this.waitForHome();
  }

  // ------------------------------------------------------------------- session

  /** The pocket tabs are the one thing every unlocked home screen carries. */
  homeMarker(): Locator {
    return this.page.getByRole("button", { name: "Public Pocket" });
  }

  async waitForHome(timeout = WAITS.onboarding): Promise<void> {
    await expect(this.homeMarker()).toBeVisible({ timeout });
  }

  async lock(): Promise<void> {
    // "Lock wallet" lives in the header's overflow (the ⋮ "More" menu), not on
    // the home screen directly, so the menu has to be opened first.
    await this.page.getByRole("button", { name: "More" }).click();
    await this.page.getByRole("button", { name: "Lock wallet" }).click();
    await expect(this.lockedNotice()).toBeVisible();
  }

  async unlock(password: string): Promise<void> {
    await this.page.getByLabel("Password", { exact: true }).fill(password);
    await this.page.getByRole("button", { name: "Unlock", exact: true }).click();
  }

  lockedNotice(): Locator {
    return this.page.getByText("Enter your password to unlock Pocket.");
  }

  /** The way out of a forgotten password. */
  async openRecover(): Promise<void> {
    await this.page.getByRole("button", { name: "Forgot your password?" }).click();
    await expect(this.page.getByRole("heading", { name: "Erase and restore" })).toBeVisible();
  }

  /**
   * Erase this device's wallet and restore it from its phrase.
   * Walks the acknowledgement screen, which is the point of the flow.
   */
  async eraseAndRestore(phrase: string, password: string): Promise<void> {
    await this.page.getByRole("button", { name: "I understand, continue" }).click();
    await this.page.getByLabel(/Recovery phrase/).fill(phrase);
    await this.page.getByLabel("New password", { exact: true }).fill(password);
    await this.page.getByLabel("Confirm new password").fill(password);
    await this.page.getByRole("button", { name: "Erase and restore" }).click();
  }

  // ---------------------------------------------------------------------- home

  /** The bottom bar, which is how every screen and sheet is reached. */
  // "Move" is deliberately absent: the bar's private control is "Move value"
  // and it opens a menu, not the Move sheet. `openMove()` is the way there.
  nav(name: "Home" | "Receive" | "Send" | "Send privately" | "Settings"): Locator {
    return this.page.getByRole("button", { name, exact: true });
  }

  /**
   * Choose which pocket the home screen is showing, and wait for it to be
   * showing it. The tab only exists once the worker has said the private pocket
   * is available, and a click that lands before then changes nothing.
   */
  async openPocket(which: "Public pocket" | "Private pocket"): Promise<void> {
    // `exact`: the pocket's InfoTip is a button named "About the private pocket",
    // and a non-exact match on "Private pocket" is a substring of that, so the
    // tab and its tooltip both resolve.
    // the label capitalises "Pocket"; callers still pass the lower-case name.
    const label = which === "Public pocket" ? "Public Pocket" : "Private Pocket";
    const tab = this.page.getByRole("button", { name: label, exact: true });
    await expect(tab).toBeVisible({ timeout: WAITS.ledgerRead });
    await tab.click();
    await expect(tab).toHaveAttribute("aria-pressed", "true");
  }

  /**
   * Open the receive sheet, read the address in full, and put the sheet away.
   *
   * It closes because a sheet is modal: left open it covers the header, and
   * every spec that read an address and then reached for a control behind it
   * was clicking on a backdrop.
   */
  async revealAddress(): Promise<string> {
    await this.nav("Receive").click();
    await expect(this.page.getByRole("dialog", { name: "Receive" })).toBeVisible();
    const address = await this.readAddress();
    await this.close();
    await expect(this.page.getByRole("dialog")).toHaveCount(0);
    return address;
  }

  /** The address exactly as rendered. Never truncated anywhere it is read. */
  async readAddress(): Promise<string> {
    const block = this.surface().getByText(ADDRESS_RE).first();
    await expect(block).toBeVisible({ timeout: WAITS.ledgerRead });
    return (await block.innerText()).replace(/\s/g, "");
  }

  /**
   * The surface a reader is actually on.
   *
   * A sheet is modal, and the screen behind it is still in the document. Read
   * from the body while one is open and the first amount on the page is the
   * home balance, not the amount being confirmed.
   */
  surface(): Locator {
    return this.page.locator("[role='dialog']:visible, body").last();
  }

  /** Any amount, read from the exact figure rather than the split rendering. */
  money(): Locator {
    return this.surface().getByText(MONEY_RE);
  }

  /** The public XLM figure on the home screen, as a number. */
  async publicBalance(): Promise<number> {
    const shown = this.money().first();
    await expect(shown).toBeVisible({ timeout: WAITS.ledgerRead });
    return Number((await shown.innerText()).replace(/[^\d.]/g, ""));
  }

  // ---------------------------------------------------------------------- send

  async openSend(): Promise<void> {
    // the public pocket's FAB is an actions menu now (Send / Swap / cross-chain),
    // so send is one item inside it rather than the bare FAB. open the menu, then
    // pick Send.
    await this.page.getByRole("button", { name: "Actions", exact: true }).click();
    await this.page.getByRole("menuitem", { name: "Send", exact: true }).click();
    await expect(this.page.getByLabel("To", { exact: true })).toBeVisible();
  }

  /** Fill the compose form and ask for the review step. */
  async composePayment(p: { to: string; amount: string; memo?: string }): Promise<void> {
    await this.page.getByLabel("To", { exact: true }).fill(p.to);
    await this.page.getByLabel("Amount (XLM)").fill(p.amount);
    if (p.memo !== undefined) await this.page.getByLabel("Memo (optional)").fill(p.memo);
    await this.page.getByRole("button", { name: "Continue" }).click();
  }

  /** Approve the reviewed payment and wait for the receipt. Returns its hash. */
  async confirmPayment(): Promise<string> {
    await this.page.getByRole("button", { name: "Confirm" }).click();
    await expect(this.receipt()).toBeVisible({ timeout: WAITS.submission });
    return this.readHash();
  }

  /** The heading that only appears once the ledger has included a transaction:
   *  confirm* resolves after inclusion, so "Transaction successful" is a confirmed
   *  fact. (The "Confirmed in ledger N" line it used to carry was removed.) */
  receipt(): Locator {
    return this.page.getByText("Transaction successful");
  }

  /**
   * Acknowledge a receipt and return to the screen behind it.
   *
   * A receipt is a sheet, so until it is dismissed the home screen is behind a
   * modal and nothing on it is what the user is looking at.
   */
  async dismissReceipt(): Promise<void> {
    await this.page.getByRole("button", { name: "Go to Home" }).click();
    await expect(this.page.getByRole("dialog")).toHaveCount(0);
  }

  /**
   * A 64-character transaction hash from a receipt.
   *
   * The receipt now shows a "Transaction ID" row with a copy control rather than
   * printing the hex, but the full hash is carried in the accessibility tree (for
   * a screen reader and for this), so it is read there: attached, not visible.
   */
  async readHash(): Promise<string> {
    const block = this.surface().getByText(/^[0-9a-f]{64}$/);
    await expect(block.first()).toBeAttached({ timeout: WAITS.submission });
    return ((await block.first().textContent()) ?? "").replace(/\s/g, "");
  }

  // ------------------------------------------------------------- private pocket

  /** Show the private pocket on the home screen. */
  async openPrivatePocket(): Promise<void> {
    await this.openPocket("Private pocket");
  }

  /**
   * Open the move sheet on its menu.
   *
   * If another sheet is already up, it is put away first: the bar is behind it,
   * so clicking through would land on a backdrop.
   */
  async openMove(): Promise<void> {
    const menu = this.page.getByRole("dialog", { name: "Move" });
    if ((await menu.count()) > 0) return;
    if ((await this.page.getByRole("dialog").count()) > 0) await this.close();

    // There is no "Move" button on the bar any more, and there has not been for
    // some time: the private FAB is labelled "Move value" and opens a MENU of
    // Shield/Send/Unshield, none of which is this sheet. `nav("Move")` matched
    // nothing, every one of the twenty-three spec files that reach the private
    // pocket through here timed out on it, and each one paid the full locator
    // timeout to do so.
    //
    // The sheet is reached from the private pocket's own prompt, whose label is
    // the STATE's action: "Set up" before registration, "Make spendable" once
    // there is something to fold, "Reactivate" when dormant. So the way in is
    // whichever of those is on screen, which is also how a user gets here.
    await this.openPocket("Private pocket");
    const ways = ["Set up", "Make spendable", "Reactivate", "Rebuild"];
    for (const name of ways) {
      const control = this.page.getByRole("button", { name, exact: true });
      if ((await control.count()) > 0) {
        await control.first().click();
        await expect(menu).toBeVisible();
        return;
      }
    }
    throw new Error(
      `no way into the Move sheet: the private pocket offered none of ${ways.join(", ")}`,
    );
  }

  /** Register: the one-time, permanent set-up. Returns once it has confirmed. */
  async registerPrivatePocket(): Promise<void> {
    await this.openMove();
    await expect(this.page.getByRole("button", { name: "Set up the private pocket" })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await this.page.getByRole("button", { name: "Set up the private pocket" }).click();
    await this.approve();
    await expect(this.receipt()).toBeVisible({ timeout: WAITS.submission });
    await this.page.getByRole("button", { name: "Go to Home" }).click();
    // a sheet is on screen for the length of its exit, and anything read while
    // it is still there is read from the sheet rather than from the screen.
    await expect(this.page.getByRole("dialog")).toHaveCount(0);
  }

  /**
   * Wait for the review step, check nothing, and take its affirmative control.
   *
   * A send says "Confirm" and a move says "Approve", so the control is
   * found by which one the review is offering rather than by a caller having to
   * know which flow it is in.
   */
  async approve(label?: "Approve" | "Confirm"): Promise<void> {
    await expect(this.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
    if (label) {
      await this.page.getByRole("button", { name: label }).click();
      return;
    }
    const send = this.page.getByRole("button", { name: "Confirm" });
    if ((await send.count()) > 0) {
      await send.click();
      return;
    }
    await this.page.getByRole("button", { name: "Approve" }).click();
  }

  /**
   * Open one of the private-pocket operations.
   *
   * A private send is the bar's own send action while the private pocket is
   * open, not a row inside the move sheet: spending is spending, and it is
   * reached the same way in both pockets.
   */
  async openOp(kind: "Shield" | "Unshield" | "Make spendable" | "Send privately"): Promise<void> {
    if (kind === "Send privately") {
      if ((await this.page.getByRole("dialog").count()) > 0) await this.close();
      await this.nav("Send privately").click();
      await expect(this.page.getByLabel("To", { exact: true })).toBeVisible();
      return;
    }
    const action = this.page.getByRole("button", { name: kind, exact: true });
    if ((await action.count()) === 0) await this.openMove();
    // the sheet shows what the pocket's state allows, and that state arrives
    // from the ledger. right after registering it is still catching up, so this
    // waits for the action rather than assuming it is already offered. the
    // sheet's own text goes into the failure, because "a button was not there"
    // is not a report and this used to fail as one.
    try {
      await expect(action).toBeVisible({ timeout: WAITS.ledgerRead });
    } catch (e) {
      const said = await this.page
        .getByRole("dialog")
        .innerText()
        .catch(() => "no sheet is open");
      throw new Error(`"${kind}" never appeared. The sheet says: ${said.replace(/\n/g, " | ")}`, {
        cause: e,
      });
    }
    await action.click();
  }

  /** The spendable figure: the private pocket's hero. */
  spendableMoney(): Locator {
    return this.money().nth(0);
  }

  /** What has arrived and is one signature away from being spendable. */
  receivingMoney(): Locator {
    return this.money().nth(1);
  }

  /** Fill an amount form and ask for the review step. */
  async submitOp(fields: { amount: string; to?: string }): Promise<void> {
    if (fields.to !== undefined) await this.page.getByLabel("To", { exact: true }).fill(fields.to);
    await this.page.getByLabel("Amount (XLM)").fill(fields.amount);
    await this.page.getByRole("button", { name: "Review" }).click();
  }

  /**
   * The two private balances.
   *
   * Spendable is the hero; receiving is stated separately and only when there
   * is some. The distinction is the point: money that has arrived is not money
   * that can be sent until it is merged, and collapsing the two is what
   * produces "why can't I send my own money".
   */
  async privateBalances(): Promise<{ spendable: number | null; receiving: number | null }> {
    await expect(this.page.getByRole("button", { name: "Private pocket" })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    const amounts = this.money();
    const count = await amounts.count();
    const read = async (n: number): Promise<number | null> => {
      if (count <= n) return null;
      return Number((await amounts.nth(n).innerText()).replace(/[^\d.]/g, ""));
    };
    const receivingLabel = this.page.getByText("Receiving", { exact: true });
    return {
      spendable: await read(0),
      receiving: (await receivingLabel.count()) > 0 ? await read(1) : null,
    };
  }

  /**
   * Put every open sheet away.
   *
   * Sheets stack, so one close is not always the last one, and a spec that
   * reaches for the bar with a sheet still up is clicking a backdrop.
   */
  async close(): Promise<void> {
    const dialogs = this.page.getByRole("dialog");
    for (let i = 0; i < 4 && (await dialogs.count()) > 0; i++) {
      await this.page.getByRole("button", { name: "Close" }).last().click();
      await this.page.waitForTimeout(300);
    }
    if ((await dialogs.count()) > 0) {
      const said = await dialogs.last().innerText();
      throw new Error(`a sheet would not close. It says: ${said.replace(/\n/g, " | ")}`);
    }
  }
}

/**
 * Reach one of the private pocket's actions.
 *
 * Setting up, reactivating, rebuilding and making spendable all live in the
 * move sheet now, so a spec that clicks one has to open it first. Written as a
 * free function because several specs drive a bare `Page` rather than a
 * `Wallet`.
 */
export async function openMoveAction(page: Page, name: string): Promise<void> {
  const dialog = page.getByRole("dialog");
  if ((await dialog.count()) === 0) {
    // The private pocket's own prompt, not a bar button. There is no "Move" on
    // the bar: the private control is labelled "Move value" and opens a menu of
    // Shield/Send/Unshield, none of which is this sheet. The old locator matched
    // nothing, so every spec reaching a private action through here paid a full
    // locator timeout and failed.
    //
    // The prompt's label is the STATE's action, and the action being asked for
    // is usually that same label, so try it first and fall back to the other
    // labels that also open this sheet.
    const ways = [name, "Set up", "Make spendable", "Reactivate", "Rebuild"];
    let opened = false;
    for (const label of ways) {
      const control = page.getByRole("button", { name: label, exact: true });
      if ((await control.count()) > 0) {
        await control.first().click();
        opened = true;
        break;
      }
    }
    if (!opened) {
      throw new Error(`no way into the Move sheet for "${name}": none of ${ways.join(", ")} is up`);
    }
    await expect(dialog).toBeVisible();
  }
  // Already there when the prompt's own label WAS the action (Set up, Rebuild).
  const action = dialog.getByRole("button", { name, exact: true });
  if ((await action.count()) > 0) await action.click();
}

/**
 * Answer the three-word check on the backup screen, for a spec driving a bare
 * `Page` rather than a `Wallet`.
 *
 * The ordinals are random per run and are read off the labels, so a spec cannot
 * pass by luck.
 */
export async function answerBackupCheck(page: Page, phrase: string): Promise<void> {
  const words = phrase.split(" ");
  const fields = page.getByLabel(/^Word \d+$/);
  const n = await fields.count();
  for (let i = 0; i < n; i++) {
    const field = fields.nth(i);
    const label = await field.evaluate((el) => {
      const id = el.getAttribute("id");
      return id ? (document.querySelector(`label[for="${id}"]`)?.textContent ?? "") : "";
    });
    await field.fill(words[Number(label.replace(/\D+/g, "")) - 1] ?? "");
  }
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
}
