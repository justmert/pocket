// The public-pocket integrations render, route, and gate their action.
//
// No funding and no chain writes: this proves the actions menu opens the Swap and
// the two CCTP screens, that each renders its own compose form, that Back returns
// home, and that a bridge that cannot be funded (no USDC held) keeps its Continue
// disabled rather than offering a dead end. The build → sign → submit paths are
// the worker's and are covered where a funded account exists; this is the wiring
// smoke test that tsc and the bundler cannot show.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";
// A well-formed 20-byte EVM address (40 hex): valid shape, so only the missing
// USDC balance can be what keeps Continue disabled.
const EVM = "0x00112233445566778899aabbccddeeff00112233";

test("the actions menu opens the swap and cross-chain screens", async ({ wallet }) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.onboarding);

  const openMenu = async () => {
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "Send", exact: true })).toBeVisible();
  };
  const back = async () => {
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await wallet.waitForHome();
  };

  // Swap: its own compose form, with the estimated-out readout.
  await openMenu();
  await page.getByRole("menuitem", { name: "Swap", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Swap", exact: true })).toBeVisible();
  await expect(page.getByText("Estimated", { exact: true })).toBeVisible();
  await back();

  // CCTP outbound: chain picker + EVM recipient. With no USDC held, Continue stays
  // disabled even once every field is filled.
  await openMenu();
  await page.getByRole("menuitem", { name: "Send to a chain", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Send to a chain", exact: true })).toBeVisible();
  const continueBtn = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueBtn).toBeDisabled();

  await page.getByRole("button", { name: "Choose the destination chain", exact: true }).click();
  const picker = page.getByRole("dialog", { name: "Choose a chain" });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: "Base", exact: true }).click();
  // the picker closing is proof the chain was chosen (domain set).
  await expect(picker).toBeHidden();
  await page.getByLabel("Recipient address on that chain", { exact: true }).fill(EVM);
  await page.getByLabel("Amount (USDC)", { exact: true }).fill("5");
  // every field valid, but no USDC to bridge: the action must remain refused.
  await expect(continueBtn).toBeDisabled();
  await back();

  // CCTP inbound: source chain + burn tx hash field.
  await openMenu();
  await page.getByRole("menuitem", { name: "Claim from a chain", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Claim from a chain", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Burn transaction hash", { exact: true })).toBeVisible();
  await back();
});
