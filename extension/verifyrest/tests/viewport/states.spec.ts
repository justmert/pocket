// The two screens a user cannot navigate to: the unfinished-transaction screen
// that sits in front of the whole wallet, and the private pocket refusing to
// spend from a record it cannot verify.
//
// Neither is reached by clicking, so neither is reached by clicking here. They
// are reached by putting the STORED STATE into the shape that produces them and
// letting the real worker and the real screen do the rest. That is a different
// thing from mocking: nothing in `core/` is replaced, the controller reads its
// own storage through its own code path, and what renders is what would render
// on the user's machine in the same condition.
//
//   InFlight       `pocket.inflight` holds an unresolved submission. The record
//                  is plain `{hash, maxTime}` by design (see lib/storage.ts),
//                  so writing one is writing exactly what the wallet writes.
//   needsRecovery  a registered pocket whose openings are gone. That is the
//                  real consequence of losing the vault, and it is the same
//                  branch of PrivatePocket.tsx that renders `diverged`.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import {
  atEveryViewport,
  expectReachable,
  FRAME,
  NARROW_VIEWPORTS,
  REQUIRED_VIEWPORTS,
} from "./audit";

const PASSWORD = "a-strong-test-password";

/** A well-formed hash. It resolves to nothing on chain, and is never polled. */
const HASH = "9f1c4a7e3b2d508614af09c7e5d3b2a1908f7e6d5c4b3a29180706f5e4d3c2b1";

async function injectInFlight(
  page: import("@playwright/test").Page,
  record: { hash: string; maxTime: number },
): Promise<void> {
  await page.evaluate((r) => chrome.storage.local.set({ "pocket.inflight": r }), record);
  await page.reload();
}

test("the unfinished-transaction screen keeps its hash and its buttons on screen", async ({
  wallet,
}) => {
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome();

  // Still inside its time window: one button, and the wallet refuses to offer
  // a way past it, which is the whole point of the screen.
  await injectInFlight(page, { hash: HASH, maxTime: Math.floor(Date.now() / 1000) + 3600 });
  await expect(page.getByText("Unfinished transaction")).toBeVisible({
    timeout: WAITS.onboarding,
  });
  await expect(page.getByText(/It can still be included until/)).toBeVisible();

  for (const vp of [...REQUIRED_VIEWPORTS, ...NARROW_VIEWPORTS]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectReachable(page.getByText(HASH), `inflight/live @ ${vp.name}: the hash`);
    // Read back rather than merely located: a hash the user cannot copy in full
    // is a hash they cannot look up, and this screen exists to be looked up.
    expect(
      (await page.getByText(HASH).innerText()).replace(/\s/g, ""),
      `inflight/live @ ${vp.name}: all 64 characters`,
    ).toBe(HASH);
    await expectReachable(
      page.getByRole("button", { name: "Check now" }),
      `inflight/live @ ${vp.name}: Check now`,
    );
    await expect(
      page.getByRole("button", { name: "Continue anyway" }),
      `inflight/live @ ${vp.name}: no way past while it can still land`,
    ).toHaveCount(0);
  }

  // Expired: the taller variant, two buttons, and the one where a clipped
  // "Continue anyway" would leave the user stuck on this screen forever.
  await page.setViewportSize(FRAME);
  await injectInFlight(page, { hash: HASH, maxTime: Math.floor(Date.now() / 1000) - 3600 });
  await expect(page.getByText(/Its time window has passed/)).toBeVisible({
    timeout: WAITS.onboarding,
  });

  for (const vp of [...REQUIRED_VIEWPORTS, ...NARROW_VIEWPORTS]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectReachable(
      page.getByRole("button", { name: "Check now" }),
      `inflight/expired @ ${vp.name}: Check now`,
    );
    await expectReachable(
      page.getByRole("button", { name: "Continue anyway" }),
      `inflight/expired @ ${vp.name}: Continue anyway`,
    );
  }
});

test("the private pocket's refusal to spend states itself fully inside the frame", async ({
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await wallet.registerPrivatePocket();
  await expect(wallet.spendableMoney()).toHaveText(/^0\.0000000\s*XLM$/, {
    timeout: WAITS.ledgerRead,
  });

  // Erase the openings, which is exactly what losing the vault does. The pocket
  // is still registered on chain, so the worker's own logic lands on
  // needsRecovery: it has commitments it cannot open.
  const removed = await page.evaluate(async () => {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith("pocket.openings."));
    await chrome.storage.local.remove(keys);
    return keys.length;
  });
  expect(removed, "the pocket must have had openings stored to begin with").toBeGreaterThan(0);

  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await expect(page.getByText("Balances need rebuilding")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // The message is the screen. It is long, it is the only thing telling the
  // user their money is safe, and it is rendered in the same branch that
  // renders `diverged`, whose message is longer still.
  // Both notices, separately. The screen states what happened in one box and
  // what can be done about it in another, and either one being clipped is the
  // whole message.
  const said = page.getByText(/This account has a private pocket but this device/);
  const whatRebuildingIs = page.getByText(/Rebuilding replays your event history/);
  for (const vp of [...REQUIRED_VIEWPORTS, ...NARROW_VIEWPORTS]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await expectReachable(said, `private/needsRecovery @ ${vp.name}: what happened`);
    await expectReachable(
      whatRebuildingIs,
      `private/needsRecovery @ ${vp.name}: what rebuilding does`,
    );
    // The one control that can act on the state. It arrived with the
    // rebuild-from-history work; a layout that puts it out of reach would make
    // the screen a dead end again.
    await expectReachable(
      page.getByRole("button", { name: "Rebuild from history" }),
      `private/needsRecovery @ ${vp.name}: Rebuild from history`,
    );
    await expectReachable(
      page.getByText("Balances need rebuilding"),
      `private/needsRecovery @ ${vp.name}: the heading`,
    );
    // No balance is invented for a pocket that cannot be opened, so a sweep of
    // "every control" would find only Close. Named, so the screen having gone
    // blank could not pass.
    await expectReachable(
      page.getByRole("button", { name: "Close" }),
      `private/needsRecovery @ ${vp.name}: Close`,
    );
  }

  await atEveryViewport(page, "private/needsRecovery", REQUIRED_VIEWPORTS);
});
