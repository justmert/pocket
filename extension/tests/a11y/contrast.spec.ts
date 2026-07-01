// Contrast, measured on every visible text node of every reachable screen, in
// both schemes.
//
// A sweep rather than a list of hand-picked selectors. The pairs somebody
// thinks to check are the pairs the designer already looked at; the ones that
// fail are the tint-behind-a-tint combinations nobody drew on purpose --
// `exposed` amber on its own 10% wash, `faint` grey on a field, a disabled
// label on a surface.
//
// Every colour is composited from the root down before the ratio is taken,
// because this palette is full of translucent layers and reading
// `backgroundColor` off the element alone gives `rgba(0,0,0,0)` and a
// meaningless number.
import { test, expect } from "../support/fixtures";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { contrastViolations, AA } from "../support/a11y";
import { offline, RPC_HOST } from "../support/stub";

const PASSWORD = "a-strong-test-password";
const SCHEMES = ["light", "dark"] as const;

const SCREENS: { name: string; open: (w: Wallet, harness: unknown) => Promise<void> }[] = [
  { name: "onboarding", open: async () => {} },
  {
    name: "create-form",
    open: async (w) => {
      await w.page.getByRole("button", { name: "Create a new wallet" }).click();
      // Both notices on screen at once: the short-password rule and the
      // mismatch rule, which are the two `info` tints.
      await w.page.getByLabel("Password", { exact: true }).fill("short");
      await w.page.getByLabel("Confirm password").fill("different");
      await expect(w.page.getByText("Use at least eight characters.")).toBeVisible();
    },
  },
  {
    name: "backup",
    open: async (w) => {
      await w.page.getByRole("button", { name: "Create a new wallet" }).click();
      await w.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
      await w.page.getByLabel("Confirm password").fill(PASSWORD);
      await w.page.getByRole("button", { name: "Create wallet" }).click();
      await expect(w.page.getByText("Write this down")).toBeVisible({ timeout: WAITS.onboarding });
    },
  },
  {
    name: "home",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.waitForHome(WAITS.ledgerRead);
    },
  },
  {
    name: "home-funded",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await ledger.fund(await w.revealAddress());
      await w.reopen();
      await w.waitForHome(WAITS.ledgerRead);
    },
  },
  {
    name: "unlock",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.lock();
    },
  },
  {
    name: "recover-warning",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.lock();
      await w.openRecover();
    },
  },
  {
    name: "recover-form",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.lock();
      await w.openRecover();
      await w.page.getByRole("button", { name: "I understand, continue" }).click();
      await w.page.getByLabel(/Recovery phrase/).fill("one two three");
      await expect(w.page.getByText(/A recovery phrase is 12 or 24 words/)).toBeVisible();
    },
  },
  {
    name: "send-error",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.openSend();
      await w.composePayment({ to: "not-an-address", amount: "1" });
      await expect(w.page.getByText(/does not look like a Stellar address/i)).toBeVisible({
        timeout: WAITS.ledgerRead,
      });
    },
  },
  {
    name: "private-unfunded",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.waitForHome(WAITS.ledgerRead);
      await w.openPrivatePocket();
      await expect(w.page.getByText("Fund this account first")).toBeVisible({
        timeout: WAITS.ledgerRead,
      });
    },
  },
  {
    name: "private-unregistered",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await ledger.fund(await w.revealAddress());
      await w.reopen();
      await w.waitForHome(WAITS.ledgerRead);
      await w.openPrivatePocket();
      await expect(w.page.getByText("Not set up yet")).toBeVisible({ timeout: WAITS.ledgerRead });
    },
  },
];

for (const screen of SCREENS) {
  for (const scheme of SCHEMES) {
    test(`${screen.name} meets AA contrast in ${scheme}`, async ({ wallet }) => {
      test.setTimeout(4 * 60_000);
      await wallet.page.emulateMedia({ colorScheme: scheme });
      await wallet.reopen();
      await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
      await screen.open(wallet, null);

      const violations = await contrastViolations(wallet.page);
      const report = violations
        .map(
          (v) =>
            `"${v.text}" ${v.ratio}:1 (needs ${v.required}) ` +
            `${v.color} on ${v.background} @ ${v.fontSizePx}px/${v.fontWeight}`,
        )
        .join("\n  ");
      expect(violations, `contrast failures on ${screen.name} in ${scheme}:\n  ${report}`).toEqual(
        [],
      );
    });
  }
}

test("the error state's own colours are readable in both schemes", async ({ harness, wallet }) => {
  // The danger tint is the one a user reads while deciding whether their money
  // is safe, and it is a wash over a surface, so it is exactly the kind of pair
  // a spot check misses.
  test.setTimeout(4 * 60_000);
  for (const scheme of SCHEMES) {
    await wallet.page.emulateMedia({ colorScheme: scheme });
    await offline(harness.context, RPC_HOST);
    await wallet.reopen();
    if (scheme === "light") await wallet.createWallet(PASSWORD);
    await wallet.waitForHome(WAITS.ledgerRead);
    await expect(wallet.page.getByText(/Something went wrong|check your connection/i)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });

    const violations = await contrastViolations(wallet.page);
    expect(
      violations,
      `error-state contrast failures in ${scheme}: ${JSON.stringify(violations)}`,
    ).toEqual([]);
  }
  expect(AA.text).toBe(4.5);
});
