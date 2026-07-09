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
//                  branch the worker uses for `diverged`.
//
// The refusal is now told in two places, and both halves are checked. The home
// screen's private tab states WHAT HAPPENED, and the Move sheet behind the one
// control that can act on it states WHAT REBUILDING IS. Either half clipped is
// the whole message: a user told their balances are gone and not told what can
// be done about it is a user who thinks their money is gone.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import {
  atEveryViewport,
  collectFailures,
  expectReachable,
  forEachViewport,
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

  // Half one, on the home screen: the heading, the worker's account of what
  // happened, and the one control that leads anywhere from here. The message is
  // long, and it is the only thing telling the user their money is safe.
  //
  // FINDING. The heading is RED at and below 266px, and is left red.
  //
  // The state used to have a screen to itself and its heading had the full
  // width of the frame. It is now the title of a prompt card, laid out in a row
  // between a 36px icon and the "Rebuild" chip, in a span with `flex: 1` and no
  // `overflow-wrap`. At 266px the title track is about 63px wide and the word
  // "rebuilding" needs 86, so 23px of it is cut off in place; at 200px and
  // below the track hits its floor and 79px is gone. The card does not grow,
  // the frame's `overflow: hidden` swallows the difference, and no scrollWidth
  // anywhere grows because ink overflow is not layout overflow. There is
  // nothing to scroll to. The characters are simply gone, on the one screen
  // whose whole job is to tell someone their money is still there.
  //
  // Reported per viewport rather than at the first red, so the report says how
  // much worse it gets rather than naming one width and inviting the reading
  // that it is cosmetic.
  const said = page.getByText(/This account has a private pocket but this device/);
  const onHome = () =>
    forEachViewport(page, [...REQUIRED_VIEWPORTS, ...NARROW_VIEWPORTS], async (vp) => {
      await expectReachable(
        page.getByText("Balances need rebuilding"),
        `private/needsRecovery @ ${vp.name}: the heading`,
      );
      await expectReachable(said, `private/needsRecovery @ ${vp.name}: what happened`);
      // Named rather than swept. A sweep of "every control" here finds the
      // account row, the pocket tabs and the bar, all of which are there
      // whatever the private pocket is doing, so it would pass on a prompt that
      // had rendered with no way out of the state at all.
      await expectReachable(
        page.getByRole("button", { name: "Rebuild", exact: true }),
        `private/needsRecovery @ ${vp.name}: the way to rebuild`,
      );
    });

  // Half two, inside the Move sheet: what rebuilding actually is, and the
  // control that starts it. It arrived with the rebuild-from-history work; a
  // layout that puts it out of reach makes the state a dead end again.
  // on a build with no archive the sentence is why rebuilding CANNOT happen,
  // not what it does. both wordings are the same job — the explanation a user in
  // this state has to be able to read at every width — so the matcher covers the
  // branch this build actually renders as well as the one it would with an
  // archive configured.
  const whatRebuildingIs = page.getByText(
    /Rebuilding replays your history|Rebuilding would replay your history/,
  );
  const inMoveSheet = () =>
    forEachViewport(page, [...REQUIRED_VIEWPORTS, ...NARROW_VIEWPORTS], async (vp) => {
      // one check, not two. this used to also require the "Rebuild from
      // history" control to be reachable; on a build with no archive that
      // control is deliberately absent (D-009), and the sentence above is now
      // the thing a user in this state has to be able to read. checking the
      // explanation IS checking the way out, because there is no other.
      await expectReachable(
        whatRebuildingIs,
        `private/needsRecovery + move @ ${vp.name}: why there is no way forward`,
      );
      await expectReachable(
        page.getByRole("button", { name: "Close" }),
        `private/needsRecovery + move @ ${vp.name}: Close`,
      );
    });

  // Both halves run whatever the first one says. The home heading is a known
  // red; letting it throw would mean the sheet's own copy and its one button
  // were never measured at any width and quietly looked verified.
  const audit = collectFailures("private/needsRecovery");
  await audit.check(onHome);
  await audit.check(() => atEveryViewport(page, "private/needsRecovery", REQUIRED_VIEWPORTS));

  await page.setViewportSize(FRAME);
  await wallet.openMove();

  await audit.check(inMoveSheet);
  await audit.check(() =>
    atEveryViewport(page, "private/needsRecovery + move", REQUIRED_VIEWPORTS),
  );
  audit.report();
});
