// The migration case that carries the money: openings written by a previous
// version of this wallet.
//
// Split from `migration.spec.ts` because it submits real transactions, and the
// suite's convention is that `*.live.spec.ts` is opt-in via POCKET_LIVE_E2E.
// The mechanics are the same and described there: an old commit's `src` is
// archived, built into its own output directory, and swapped into the SAME
// extension path the current build then occupies, because Chrome derives the
// extension id from that path and the id is what namespaces the store.
import { test, expect } from "@playwright/test";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import {
  chainAccount,
  formatStroops,
  inspect,
  openingKeyFor,
  openingsOpenTheChain,
  storage,
  AUDITORID_PREFIX,
} from "./oracle";
import {
  open,
  installBuild,
  swappablePath,
  clearServiceWorkerCache,
  CURRENT_BUILD,
  OLD_BUILD,
  OLD_VERSION,
  NEW_VERSION,
  PASSWORD,
} from "./harness";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function requireBuild(path: string, how: string): void {
  if (!existsSync(path)) throw new Error(`no build at ${path}. Build it with: ${how}`);
}

test("openings written by a previous version still open the balance the contract holds", async ({}, testInfo) => {
  test.setTimeout(20 * 60_000);
  requireBuild(OLD_BUILD, "./tests/integrity/build-old.sh 7076c5a .output-t10-old");

  const at = swappablePath(testInfo.parallelIndex);
  const dir = mkdtempSync(join(tmpdir(), "pocket-t10-mig-"));
  let install: Awaited<ReturnType<typeof open>> | null = null;
  try {
    // ------------------------------------------------ the previous version
    // `7076c5a`: has the private pocket, does NOT have `pocket.staged`, does
    // NOT have `pocket.auditorid`, and does not know how to credit an inbound
    // transfer. Everything it leaves behind, the current build has to read.
    installBuild(OLD_BUILD, at, OLD_VERSION);
    install = await open(dir, at);
    const page = await install.popup();
    const w = new Wallet(page);
    await w.createWallet(PASSWORD);
    const address = await w.revealAddress();
    await ledger.fund(address);
    console.log(`  account ${address}, set up by 7076c5a`);

    await w.reopen();
    await w.waitForHome(WAITS.ledgerRead);
    await w.openPrivatePocket();
    await w.registerPrivatePocket();
    console.log("  7076c5a registered the private pocket");

    // Register only, and no shield. `7076c5a`'s OWN shield leaves it diverged:
    // driven through its own UI the deposit confirms and the very next read
    // says "Records do not match the ledger … for the receiving balance". That
    // is a defect of that commit, since fixed, and it is not what this test is
    // about, so the old build is asked for the one thing it does correctly:
    // register, and write the opening record that goes with it.
    //
    // A zero opening is still the record. Whether the current build can FIND
    // and OPEN it is the migration question, and the answer is visible without
    // any balance at all: a build that cannot read the record reports
    // `needsRecovery`, not `ready`.

    const oldStorage = await storage(page);
    const oldKeys = Object.keys(oldStorage).sort();
    const blobBefore = JSON.stringify(oldStorage[openingKeyFor(address)]);
    expect(blobBefore, "the old build must have written an opening").toBeTruthy();
    // The schema difference, established rather than assumed.
    expect(oldKeys.filter((k) => k.startsWith(AUDITORID_PREFIX))).toEqual([]);
    console.log(`  wrote with 7076c5a: ${oldKeys.join(", ")}`);
    await install.suspend();

    // ------------------------------------------------- upgrade in place
    //
    // Version bump AND service-worker cache clear, both required. See
    // `installBuild` and `clearServiceWorkerCache`: without them the popup is
    // the new build and the worker answering it is still the old one.
    clearServiceWorkerCache(dir);
    installBuild(CURRENT_BUILD, at, NEW_VERSION);
    install = await open(dir, at);
    const upgraded = await install.popup();
    const w2 = new Wallet(upgraded);
    await expect(w2.lockedNotice()).toBeVisible({ timeout: WAITS.onboarding });
    await w2.unlock(PASSWORD);
    await w2.waitForHome(WAITS.onboarding);
    await w2.openPrivatePocket();

    // `ready`, not `needsRecovery`. This is the whole migration question in one
    // assertion: `needsRecovery` is exactly what the current build says when the
    // opening record is missing or it cannot open it, and it comes with "this
    // device has no record of its balances". Silence or a wrong balance is the
    // failure the brief names; this is where either would appear.
    await expect(
      w2.spendableMoney(),
      "an upgraded install must report balances, not that it has no record of them",
    ).toHaveText(/^0\.0000000\s*XLM$/, { timeout: WAITS.ledgerRead });
    await expect(w2.receivingMoney()).toHaveText(/^0\.0000000\s*XLM$/);
    await expect(
      upgraded.getByText(/no record of its balances/),
      "the upgraded build must not report the old record as missing",
    ).toHaveCount(0);

    // And the record behind it must still be the money. Same check as
    // everywhere else in this slice: the sealed bytes, opened with the
    // password, against the accumulator the contract holds.
    const disk = await inspect(upgraded, PASSWORD);
    expect(disk.openings, "the upgraded build must find the old opening").not.toBeNull();
    expect(disk.openingKey, "under the same key the old build used").toBe(openingKeyFor(address));
    const chain = await chainAccount(address);
    const verdict = openingsOpenTheChain(disk.openings!, chain!);
    expect(verdict.ok, `after upgrading: ${verdict.detail}`).toBe(true);
    expect(formatStroops(disk.openings!.spendable.value)).toBe("0.0000000");

    // Untouched, not rewritten. An upgrade that re-seals the opening store has
    // taken a copy of the one irreplaceable record in the wallet and put it
    // through a code path nobody tested against the old format.
    const blobAfter = JSON.stringify((await storage(upgraded))[openingKeyFor(address)]);
    expect(blobAfter, "an upgrade must read the opening, not rewrite it").toBe(blobBefore);

    // The account keeps the auditor the old build permanently bound. The
    // current build allocates its own and records it under `pocket.auditorid`;
    // an upgraded install has no such record, and must not go and register a
    // second key to make one.
    const auditorKeys = Object.keys(await storage(upgraded)).filter((k) =>
      k.startsWith(AUDITORID_PREFIX),
    );
    expect(auditorKeys, "an upgrade must not register a second auditor key").toEqual([]);

    // Still usable, which is the only definition of "the record survived" that
    // means anything: the current build shields 25 XLM ON TOP of the previous
    // version's record, and the result opens the chain.
    await w2.openOp("Shield");
    await w2.submitOp({ amount: "25" });
    await w2.approve();
    await expect(upgraded.getByText(/Made spendable in a second transaction/)).toBeVisible({
      timeout: WAITS.submission,
    });
    await expect(w2.spendableMoney()).toHaveText(/^25\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });
    const after = await inspect(upgraded, PASSWORD);
    const chainAfter = await chainAccount(address);
    expect(
      openingsOpenTheChain(after.openings!, chainAfter!).ok,
      "and the record it wrote on top of the previous version's opens the chain too",
    ).toBe(true);
    expect(formatStroops(after.openings!.spendable.value)).toBe("25.0000000");
  } finally {
    await install?.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(at, { recursive: true, force: true });
  }
});
