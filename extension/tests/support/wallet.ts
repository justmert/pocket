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
    await expect(this.page.getByText("Write this down")).toBeVisible({
      timeout: WAITS.onboarding,
    });
    const phrase = await this.readBackupPhrase();
    await this.page.getByRole("button", { name: "I have written it down" }).click();
    await this.waitForHome();
    return phrase;
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
    await this.waitForHome();
  }

  // ------------------------------------------------------------------- session

  /** The pocket tabs are the one thing every unlocked home screen carries. */
  homeMarker(): Locator {
    return this.page.getByRole("button", { name: "Public pocket" });
  }

  async waitForHome(timeout = WAITS.onboarding): Promise<void> {
    await expect(this.homeMarker()).toBeVisible({ timeout });
  }

  async lock(): Promise<void> {
    await this.page.getByRole("button", { name: "Lock wallet" }).click();
    await expect(this.lockedNotice()).toBeVisible();
  }

  async unlock(password: string): Promise<void> {
    await this.page.getByLabel("Password", { exact: true }).fill(password);
    await this.page.getByRole("button", { name: "Unlock", exact: true }).click();
  }

  lockedNotice(): Locator {
    return this.page.getByText("Enter your password to continue.");
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
  nav(name: "Home" | "Receive" | "Send" | "Send privately" | "Move" | "Settings"): Locator {
    return this.page.getByRole("button", { name, exact: true });
  }

  /** Choose which pocket the home screen is showing. */
  async openPocket(which: "Public pocket" | "Private pocket"): Promise<void> {
    await this.page.getByRole("button", { name: which }).click();
  }

  /** Open the receive sheet and read the address back in full. */
  async revealAddress(): Promise<string> {
    await this.nav("Receive").click();
    await expect(this.page.getByRole("dialog", { name: "Receive" })).toBeVisible();
    return this.readAddress();
  }

  /** The address exactly as rendered. Never truncated anywhere it is read. */
  async readAddress(): Promise<string> {
    const block = this.page.getByText(ADDRESS_RE).first();
    await expect(block).toBeVisible({ timeout: WAITS.ledgerRead });
    return (await block.innerText()).replace(/\s/g, "");
  }

  /** Any amount, read from the exact figure rather than the split rendering. */
  money(): Locator {
    return this.page.getByText(MONEY_RE);
  }

  /** The public XLM figure on the home screen, as a number. */
  async publicBalance(): Promise<number> {
    const shown = this.money().first();
    await expect(shown).toBeVisible({ timeout: WAITS.ledgerRead });
    return Number((await shown.innerText()).replace(/[^\d.]/g, ""));
  }

  // ---------------------------------------------------------------------- send

  async openSend(): Promise<void> {
    await this.nav("Send").click();
    await expect(this.page.getByLabel("To", { exact: true })).toBeVisible();
  }

  /** Fill the compose form and ask for the review step. */
  async composePayment(p: { to: string; amount: string; memo?: string }): Promise<void> {
    await this.page.getByLabel("To", { exact: true }).fill(p.to);
    await this.page.getByLabel("Amount (XLM)").fill(p.amount);
    if (p.memo !== undefined) await this.page.getByLabel("Memo (optional)").fill(p.memo);
    await this.page.getByRole("button", { name: "Review" }).click();
  }

  /** Approve the reviewed payment and wait for the receipt. Returns its hash. */
  async confirmPayment(): Promise<string> {
    await this.page.getByRole("button", { name: "Confirm and send" }).click();
    await expect(this.receipt()).toBeVisible({ timeout: WAITS.submission });
    return this.readHash();
  }

  /** The line that only appears once the ledger has included a transaction. */
  receipt(): Locator {
    return this.page.getByText(/^Confirmed in ledger \d+\.$/);
  }

  /** A 64-character transaction hash from a receipt. */
  async readHash(): Promise<string> {
    const block = this.page.getByText(/^[0-9a-f]{64}$/);
    await expect(block.first()).toBeVisible({ timeout: WAITS.submission });
    return (await block.first().innerText()).replace(/\s/g, "");
  }

  // ------------------------------------------------------------- private pocket

  /** Show the private pocket on the home screen. */
  async openPrivatePocket(): Promise<void> {
    await this.openPocket("Private pocket");
  }

  /** The sheet that carries every private-pocket operation. */
  async openMove(): Promise<void> {
    await this.nav("Move").click();
    await expect(this.page.getByRole("dialog")).toBeVisible();
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
    await this.page.getByRole("button", { name: "Done" }).click();
  }

  /** Wait for the review step, check nothing, and approve it. */
  async approve(label: "Approve" | "Confirm and send" = "Approve"): Promise<void> {
    await expect(this.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
    await this.page.getByRole("button", { name: label }).click();
  }

  /**
   * Open one of the private-pocket operations.
   *
   * A private send is the bar's own send action while the private pocket is
   * open, not a row inside the move sheet: spending is spending, and it is
   * reached the same way in both pockets.
   */
  async openOp(kind: "Move in" | "Move out" | "Make spendable" | "Send privately"): Promise<void> {
    if (kind === "Send privately") {
      await this.nav("Send privately").click();
      await expect(this.page.getByLabel("To", { exact: true })).toBeVisible();
      return;
    }
    if ((await this.page.getByRole("button", { name: kind, exact: true }).count()) === 0) {
      await this.openMove();
    }
    await this.page.getByRole("button", { name: kind, exact: true }).click();
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

  async close(): Promise<void> {
    await this.page.getByRole("button", { name: "Close" }).click();
  }
}
