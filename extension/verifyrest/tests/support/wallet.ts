// The page object for the popup.
//
// Deliberately thin. It knows how to DRIVE the wallet the way a person does,
// and how to READ what is on screen; it holds no assertions of its own. A page
// object that asserts hides which spec cares about what, and a spec that never
// names its own expectations cannot be reviewed.
//
// Everything is selected by role, label or visible text. Nothing selects on a
// class, a style attribute or a test id, so a refactor of the styling cannot
// break the suite, and a change to the WORDS is supposed to break it: the words
// on a signing screen are the product.
import { expect, type Locator, type Page } from "@playwright/test";

/** A G-address, exactly as it must appear on screen: never truncated. */
export const ADDRESS_RE = /^G[A-Z2-7]{55}$/;

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
    return this.page.getByText("A Stellar wallet with two pockets");
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
    await this.page.getByLabel("Recovery phrase").fill(phrase);
    await this.page.getByLabel("New password", { exact: true }).fill(password);
    await this.page.getByRole("button", { name: "Import wallet" }).click();
    await this.waitForHome();
  }

  // ------------------------------------------------------------------- session

  async waitForHome(timeout = WAITS.onboarding): Promise<void> {
    await expect(this.page.getByText("PUBLIC POCKET", { exact: true })).toBeVisible({ timeout });
  }

  async lock(): Promise<void> {
    await this.page.getByRole("button", { name: "Lock" }).click();
    await expect(this.page.getByText(/Locked\. Enter your password/)).toBeVisible();
  }

  async unlock(password: string): Promise<void> {
    await this.page.getByLabel("Password", { exact: true }).fill(password);
    await this.page.getByRole("button", { name: "Unlock" }).click();
  }

  lockedNotice(): Locator {
    return this.page.getByText(/Locked\. Enter your password/);
  }

  /** The way out of a forgotten password. */
  async openRecover(): Promise<void> {
    await this.page.getByRole("button", { name: "Forgot your password?" }).click();
    await expect(this.page.getByText("Erase and restore").first()).toBeVisible();
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

  /** Reveal the receive address, then read it back in full. */
  async revealAddress(): Promise<string> {
    await this.page.getByRole("button", { name: "Receive" }).click();
    await expect(this.page.getByText("Your address")).toBeVisible();
    return this.readAddress();
  }

  /**
   * The address exactly as rendered. Whitespace is stripped because the block
   * is chunked in fours for legibility, and the chunks are separated by margin
   * rather than by characters.
   */
  async readAddress(): Promise<string> {
    const block = this.page.getByText(ADDRESS_RE).first();
    await expect(block).toBeVisible({ timeout: WAITS.ledgerRead });
    return (await block.innerText()).replace(/\s/g, "");
  }

  /** Any amount rendered as money: "1234.5670000 XLM". */
  money(): Locator {
    return this.page.getByText(/^-?[\d]+\.\d{7}\s*XLM$/);
  }

  /** The public XLM figure on the home screen, as a number. */
  async publicBalance(): Promise<number> {
    const shown = this.money().first();
    await expect(shown).toBeVisible({ timeout: WAITS.ledgerRead });
    return Number((await shown.innerText()).replace(/[^\d.]/g, ""));
  }

  // ---------------------------------------------------------------------- send

  async openSend(): Promise<void> {
    await this.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(this.page.getByLabel("Recipient")).toBeVisible();
  }

  /** Fill the compose form and ask for the confirm screen. */
  async composePayment(p: { to: string; amount: string; memo?: string }): Promise<void> {
    await this.page.getByLabel("Recipient").fill(p.to);
    await this.page.getByLabel("Amount (XLM)").fill(p.amount);
    if (p.memo !== undefined) await this.page.getByLabel("Memo (optional)").fill(p.memo);
    await this.page.getByRole("button", { name: "Review" }).click();
  }

  /** Approve the reviewed payment and wait for the receipt. Returns its hash. */
  async confirmPayment(): Promise<string> {
    await this.page.getByRole("button", { name: "Confirm and send" }).click();
    await expect(this.page.getByText("Sent", { exact: true })).toBeVisible({
      timeout: WAITS.submission,
    });
    return this.readHash();
  }

  /** A 64-character transaction hash from a receipt. */
  async readHash(): Promise<string> {
    const block = this.page.getByText(/^[0-9a-f]{64}$/);
    await expect(block.first()).toBeVisible({ timeout: WAITS.submission });
    return (await block.first().innerText()).replace(/\s/g, "");
  }

  // ------------------------------------------------------------- private pocket

  async openPrivatePocket(): Promise<void> {
    await this.page
      .getByRole("button", { name: /private pocket/i })
      .first()
      .click();
    await expect(this.page.getByText("Private pocket", { exact: true })).toBeVisible();
  }

  /** Register: the one-time, permanent set-up. Returns once it has confirmed. */
  async registerPrivatePocket(): Promise<void> {
    await expect(this.page.getByText("Not set up yet")).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await this.page.getByRole("button", { name: "Set up the private pocket" }).click();
    await this.approve();
    await expect(this.page.getByText(/Confirmed on the ledger/)).toBeVisible({
      timeout: WAITS.submission,
    });
  }

  /** Wait for the review screen, check nothing, and approve it. */
  async approve(): Promise<void> {
    await expect(this.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
    await this.page.getByRole("button", { name: "Approve" }).click();
  }

  /** Open one of the three operation forms. */
  async openOp(kind: "Move in" | "Move out" | "Send privately"): Promise<void> {
    await this.page.getByRole("button", { name: kind, exact: true }).click();
  }

  /** Fill an operation form and ask for the review screen. */
  async submitOp(fields: { amount: string; to?: string }): Promise<void> {
    if (fields.to !== undefined) await this.page.getByLabel("To", { exact: true }).fill(fields.to);
    await this.page.getByLabel("Amount (XLM)").fill(fields.amount);
    await this.page.getByRole("button", { name: "Review" }).click();
  }

  /**
   * The two private balances, as locators, in the order the screen states them.
   *
   * Spendable first, receiving second, always. The distinction is the point:
   * money that has arrived is not money that can be sent until it is merged,
   * and collapsing the two is what produces "why can't I send my own money".
   */
  spendableMoney(): Locator {
    return this.money().nth(0);
  }

  receivingMoney(): Locator {
    return this.money().nth(1);
  }

  /** The two private balances, as numbers. Null when nothing is reported. */
  async privateBalances(): Promise<{ spendable: number | null; receiving: number | null }> {
    await expect(this.page.getByText("SPENDABLE", { exact: true })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    const read = async (n: number): Promise<number | null> => {
      const m = this.money().nth(n);
      if ((await m.count()) === 0) return null;
      return Number((await m.innerText()).replace(/[^\d.]/g, ""));
    };
    return { spendable: await read(0), receiving: await read(1) };
  }

  async close(): Promise<void> {
    await this.page.getByRole("button", { name: "Close" }).click();
  }
}
