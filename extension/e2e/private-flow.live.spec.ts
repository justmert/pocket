import { test, expect, chromium, type BrowserContext, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// The whole private pocket, driven the way a user drives it: clicks in the
// popup, real proving in the offscreen document, real transactions on testnet.
//
// Everything below this has been verified separately. What this proves is that
// the pieces are WIRED: that a person who installs the extension can register a
// confidential account, move money in, and send it privately, without a script.
const EXT = resolve(dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");
const FRIENDBOT = "https://friendbot.stellar.org";
const PASSWORD = "a strong test password";
const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";

let ctx: BrowserContext;
let id: string;
let dir: string;
let page: Page;
let address: string;

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-live-"));
  ctx = await chromium.launchPersistentContext(dir, {
    channel: "chromium",
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  id = new URL(sw.url()).host;
  page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/popup.html`);
});

test.afterAll(async () => {
  await ctx?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("creates a wallet and funds it", async () => {
  test.setTimeout(120_000);
  // Same steps as the offline suite's helper, so the two cannot drift apart.
  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(PASSWORD);
  await page.getByRole("textbox", { name: "Confirm password" }).fill(PASSWORD);
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Write this down")).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "I have written it down" }).click();
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });

  // Read the address the wallet actually derived, from its own receive view.
  await page.getByRole("button", { name: "Receive" }).click();
  const text = await page.getByText(/^G[A-Z2-7]{55}$/).first().innerText();
  address = text.replace(/\s/g, "");
  expect(address).toMatch(/^G[A-Z2-7]{55}$/);

  const res = await fetch(`${FRIENDBOT}?addr=${address}`);
  expect(res.ok, `friendbot must fund ${address}`).toBe(true);
  console.log(`  account under test: ${address}`);
});

test("registers a confidential account with a real proof", async () => {
  test.setTimeout(300_000);
  await page.reload();
  await expect(page.getByRole("button", { name: "Public pocket" })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: /private pocket/i }).click();

  // A funded, unregistered account. The three permanent facts must be stated
  // before the button that commits to them.
  await expect(page.getByText(/Private pocket not set up/)).toBeVisible({ timeout: 60_000 });
  // Stated twice on purpose: once in the summary, once in the list above the
  // button. Assert the list item, which is the one adjacent to the commitment.
  // The D8 promise, stated where the user commits to it permanently.
  await expect(page.getByText(/derived from your recovery phrase/)).toBeVisible();
  await expect(page.getByText(/only you can\s+read your amounts/)).toBeVisible();
  await expect(page.getByText(/cannot be changed later/)).toBeVisible();
  await expect(page.getByText(/Only amounts are hidden/)).toBeVisible();

  await page.getByRole("button", { name: "Set up the private pocket" }).click();

  // Proving, then the review screen listing every effect.
  await expect(page.getByText(/What this does/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/Bind your OWN auditor key/)).toBeVisible();
  await expect(page.getByText(/Nobody else can read your amounts/)).toBeVisible();
  await expect(page.getByText(/not reversible/)).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Confirmed in ledger/)).toBeVisible({ timeout: 180_000 });
});

test("shields XLM and makes it spendable", async () => {
  test.setTimeout(300_000);
  await expect(page.getByText(/SPENDABLE/)).toBeVisible({ timeout: 120_000 });

  await page.getByRole("button", { name: "Move in" }).click();
  await page.getByRole("textbox", { name: "Amount" }).fill("25");
  // The deposit amount is public. The screen must say so before the review.
  await expect(page.getByText(/This amount is public/i)).toBeVisible();
  await page.getByRole("button", { name: "Review" }).click();

  await expect(page.getByText(/deposit amount is PUBLIC/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Approve" }).click();

  // Shield is two transactions: the deposit credits RECEIVING, and the merge
  // that follows is what makes it spendable.
  await expect(page.getByText(/Made spendable in a second transaction/)).toBeVisible({
    timeout: 240_000,
  });
});

test("sends a confidential transfer to another account", async () => {
  test.setTimeout(300_000);
  // The recipient must itself have a private pocket, so use the account we
  // already registered on this deployment.
  const RECIPIENT = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";

  await expect(page.getByText(/SPENDABLE/)).toBeVisible({ timeout: 120_000 });
  await page.getByRole("button", { name: "Send privately" }).click();
  await page.getByRole("textbox", { name: "To", exact: true }).fill(RECIPIENT);
  await page.getByRole("textbox", { name: "Amount" }).fill("5");
  await page.getByRole("button", { name: "Review" }).click();

  // The honest framing, at the moment of signing: amount hidden, addresses not.
  await expect(page.getByText(/AMOUNT is hidden/)).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/Both addresses are PUBLIC/)).toBeVisible();
  // Never truncated at confirm: a 4+4 lookalike costs about an hour to grind.
  await expect(page.getByText(RECIPIENT.slice(0, 20))).toBeVisible();

  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Confirmed in ledger/)).toBeVisible({ timeout: 240_000 });
});

test("the account bound its OWN auditor key, not the operator's", async () => {
  test.setTimeout(120_000);
  // D8, end to end. Before this, registration passed a hardcoded auditorId 0,
  // which on our deployment is the DEPLOYER's key: every user permanently
  // granted the operator read access to every amount. The binding is immutable
  // for the life of the account, so this is unrepairable if it is wrong.
  const REGISTRY = "CDE5JETGXV7TOUUDQPUTGLJB6TCUUIIWJJTLWFX4RNH36XABKCEPNTEV";
  const DEPLOYER = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7";

  // Read the auditor id the account actually bound, from the token contract.
  const bound = await page.evaluate(
    () =>
      new Promise<number | undefined>((res) => {
        chrome.runtime.sendMessage({ type: "privatePocket" }, (r) =>
          res(r?.ok ? r.data?.auditorId : undefined),
        );
      }),
  );

  expect(bound, "the pocket must report the auditor it bound").not.toBeUndefined();
  expect(bound, "must NOT be the operator's id 0").not.toBe(0);

  // And that id must be owned by this account, not by the deployer.
  const owner = await rpcOwnerOf(REGISTRY, bound as number);
  expect(owner, `auditor #${bound} must be owned by the account itself`).toBe(address);
  expect(owner).not.toBe(DEPLOYER);
  console.log(`  bound auditor #${bound}, owned by ${owner.slice(0, 8)}… (self)`);
});

test("the ledger agrees with what the UI claimed", async () => {
  test.setTimeout(120_000);
  // "Confirmed" on a screen is not evidence. This asks the public ledger,
  // through Horizon, sharing no code with the wallet's own read path.
  const acc = await (
    await fetch(`https://horizon-testnet.stellar.org/accounts/${address}`)
  ).json();
  const native = acc.balances.find((b: { asset_type: string }) => b.asset_type === "native");
  const moved = 10_000 - Number(native.balance);

  // Friendbot funds exactly 10,000 XLM. Shielding 25 moves it out of the
  // PUBLIC balance into the confidential one, so the delta is 25 plus fees
  // and nothing else. That is the shield, observed from outside the wallet.
  expect(moved, "25 XLM plus fees must have left the public balance").toBeGreaterThan(25);
  expect(moved, "and nothing beyond fees").toBeLessThan(26);

  const txs = await (
    await fetch(`https://horizon-testnet.stellar.org/accounts/${address}/transactions?limit=20`)
  ).json();
  const records = txs._embedded.records as { successful: boolean }[];
  // register, deposit, merge, transfer. Counting is not enough: a FAILED
  // transaction still appears here, so every one must have succeeded.
  expect(records.length).toBeGreaterThanOrEqual(4);
  expect(
    records.every((r) => r.successful),
    "every transaction the wallet submitted must have succeeded",
  ).toBe(true);

  console.log(
    `  ${records.length} successful transactions, ${moved.toFixed(4)} XLM shielded plus fees`,
  );
});

/** owner_of(id) on the registry, read straight from RPC. */
async function rpcOwnerOf(registry: string, id: number): Promise<string> {
  const { rpc, TransactionBuilder, Contract, Account, nativeToScVal, BASE_FEE, scValToNative } =
    await import("@stellar/stellar-sdk");
  const server = new rpc.Server("https://soroban-testnet.stellar.org");
  const acc = await server.getAccount(address);
  const tx = new TransactionBuilder(new Account(address, acc.sequenceNumber()), {
    fee: BASE_FEE,
    networkPassphrase: "Test SDF Network ; September 2015",
  })
    .addOperation(new Contract(registry).call("owner_of", nativeToScVal(id, { type: "u32" })))
    .setTimeout(30)
    .build();
  const sim = await server.simulateTransaction(tx);
  if ("error" in sim) throw new Error(String(sim.error));
  return scValToNative((sim as { result: { retval: unknown } }).result.retval as never) as string;
}
