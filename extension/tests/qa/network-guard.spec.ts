// The mainnet refusal, asked of a real running service worker.
//
// tests/qa/network-guard.test.ts asserts the guard exists in the source and that
// the manifest does not undo it. This asks the built extension, running, to do
// the thing, and watches it refuse — because a guard that is present in source
// and bypassed at runtime is not a guard, and only one of these two files can
// tell the difference.
import { test, expect, askWorker } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

test("a running worker refuses to be pointed at mainnet, and stays on testnet", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  const before = await askWorker<{ network: string }>(page, { type: "status" });
  expect(before.network).toBe("testnet");

  // The ask, made exactly as the popup would make it. `askWorker` rejects when
  // the worker answers with an error, so the refusal is the rejection.
  await expect(
    askWorker(page, { type: "setNetwork", network: "mainnet" }),
    "the worker accepted a switch to mainnet",
  ).rejects.toThrow(/testnet-only/i);

  // And the refusal left nothing half-applied. A guard that throws after
  // mutating state is the worst of both.
  const after = await askWorker<{ network: string }>(page, { type: "status" });
  expect(after.network, "the refused switch changed the network anyway").toBe("testnet");

  // Repetition must not escalate. Permission is never granted by asking twice.
  for (let i = 0; i < 5; i++) {
    await expect(
      askWorker(page, { type: "setNetwork", network: "mainnet" }),
      `attempt ${i + 2} succeeded where the first was refused`,
    ).rejects.toThrow();
  }
  const last = await askWorker<{ network: string }>(page, { type: "status" });
  expect(last.network).toBe("testnet");
});

test("nothing in a full session ever reaches a host outside the expected set", async ({
  wallet,
  ambient,
}) => {
  test.setTimeout(4 * 60_000);
  // The ambient assertions already fail a test on an unexpected host. This test
  // exists to make that check deliberate on the flow that does the most network
  // work, rather than leaving it as a side effect of whatever else was running.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openSend();
  await wallet.page.keyboard.press("Escape");
  // wait for the sheet to be gone rather than racing its 240ms exit; clicking
  // through a closing dialog is a flake in the test, not a defect in the wallet.
  await expect(wallet.page.locator("[role='dialog']")).toHaveCount(0);
  await wallet.openMove();
  await wallet.page.keyboard.press("Escape");
  await expect(wallet.page.locator("[role='dialog']")).toHaveCount(0);
  await wallet.lock();
  await wallet.unlock(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  expect(
    ambient.violations.filter((v) => v.kind === "unexpected-host"),
    "a full create-send-move-lock-unlock session reached a host outside the expected set",
  ).toEqual([]);
});
