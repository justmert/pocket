import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import {
  addressOf,
  fund,
  launch,
  onboard,
  send,
  storage,
  TOKEN,
  waitForFunded,
} from "./harness";

// Rebuild from history, end to end, against a real archive of the real chain.
//
// This is the one path in the wallet whose failure is PERMANENT. Openings are
// the only thing that makes an on-chain commitment spendable; nothing else in
// the world holds them. If rebuilding does not work, a user who loses local
// state watches their money on the ledger forever.
//
// It had never once completed. `decodeStored` read the archive's `topics_xdr`
// as an ScVec, and the indexer writes it as a bare concatenation of the
// ledger's own topic ScVals, so every event threw on the first four bytes.
// Measured against the archive: 0 of 1,069 real events decoded. Every part of
// the feature was tested except the seam between the two halves, and the seam
// was the whole feature.
//
// So this test spends real testnet XLM and does the destructive thing: it
// shields money, DELETES the openings, and asks the wallet to get them back.
test.describe.configure({ mode: "default" });

const INDEXER = resolve(import.meta.dirname, "../../../indexer");

// The archive the EXTENSION was built to talk to. Both halves have to agree, so
// they are supplied together rather than defaulted: the build takes
// VITE_ARCHIVE_URL, an already-running `indexer/src/server.ts` serves this file,
// and this test writes the account's events into it mid-run. Defaulting either
// would produce a green run against an archive that answers about nothing.
const DB_PATH = process.env.POCKET_TEST_ARCHIVE_DB;
const ARCHIVE = process.env.POCKET_TEST_ARCHIVE_URL ?? "http://127.0.0.1:8791";

/** Wait for the review screen, whatever it is called on the way there. */
async function waitForReview(page: Page): Promise<void> {
  await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({ timeout: 300_000 });
}

async function openPocket(page: Page): Promise<void> {
  await page.getByRole("button", { name: /private pocket/i }).click();
}

test("a wallet that lost its openings gets them back from the archive", async () => {
  test.setTimeout(1_200_000);
  if (!DB_PATH) {
    throw new Error(
      "POCKET_TEST_ARCHIVE_DB is not set. This test needs the same SQLite file that the " +
        "running indexer serves and that the extension's VITE_ARCHIVE_URL points at.",
    );
  }
  const w = await launch();
  const page = await w.popup();
  await onboard(page);
  const address = await addressOf(page);
  await fund(address);
  await waitForFunded(address);
  const openingsKey = `pocket.openings.${TOKEN}.${address}`;

  try {
    // A fresh account, so its whole confidential history is register, deposit,
    // merge. Deliberately no inbound transfer: a RECEIVED transfer cannot be
    // rebuilt from events at all, because the contract passes C_transfer in the
    // invocation payload and does not publish it in the event. That limit is
    // real, is stated in the README, and is not what this test is about.
    await openPocket(page);
    await expect(page.getByText(/Not set up yet/)).toBeVisible({ timeout: 120_000 });
    await page.getByRole("button", { name: "Set up the private pocket" }).click();
    await waitForReview(page);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText(/Confirmed on the ledger/)).toBeVisible({ timeout: 300_000 });
    await expect(page.getByText("SPENDABLE")).toBeVisible({ timeout: 180_000 });

    await page.getByRole("button", { name: "Move in" }).click();
    await page.getByRole("textbox", { name: "Amount" }).fill("25");
    await page.getByRole("button", { name: "Review" }).click();
    await waitForReview(page);
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("PUBLIC POCKET")).toBeVisible({ timeout: 600_000 });

    // No second navigation: the private-pocket read goes to the worker, which is
    // the same thing the screen calls. Clicking through again only adds a way
    // for the test to fail on a label.
    // Decimal strings, not stroops: `privatePocket` answers in what the screen
    // shows. Summed because a shield is deposit THEN merge, and either side may
    // hold the money depending on where the merge got to.
    const total = (p?: { spendable?: string; receiving?: string }) =>
      Number(p?.spendable ?? "0") + Number(p?.receiving ?? "0");
    const pocket = async () =>
      total((await send<{ spendable?: string; receiving?: string }>(page, {
        type: "privatePocket",
      })).data);

    // POLLED, not read once. "PUBLIC POCKET" is back on screen when the flow
    // returns, which is not the same instant the merge is confirmed and its
    // openings are written. Reading once here measured a race and reported 0.
    await expect
      .poll(pocket, {
        message: "the shield must move 25 XLM into the private pocket",
        timeout: 600_000,
        intervals: [5_000],
      })
      .toBe(25);
    const shielded = await pocket();

    // Everything above is on chain now. Ingest it into a throwaway archive, the
    // same way an operator would, with the real backfill against real RPC.
    // Backfilled in a LOOP, until the archive actually holds the merge.
    //
    // A single run raced the ledger: the shield's merge closed one ledger after
    // the backfill's window ended, so the archive held register and deposit and
    // honestly reported its range as complete THROUGH THAT WINDOW. The wallet
    // then refused, correctly, because a rebuilt spendable that is missing the
    // merge does not reproduce what the contract holds. Failing closed on a
    // lagging archive is the behaviour we want; a test that mistakes it for a
    // bug is the thing to fix.
    const backfill = () =>
      execFileSync("node", ["--experimental-strip-types", "src/backfill.ts"], {
        cwd: INDEXER,
        env: { ...process.env, DB_PATH, CONTRACT_ID: TOKEN },
        timeout: 900_000,
      });
    const servedTypes = async (): Promise<string[]> => {
      backfill();
      const url =
        `${ARCHIVE}/v1/tokens/${TOKEN}/accounts/${address}/events?limit=200`;
      const r = (await (await fetch(url)).json()) as { events: { event_type: string }[] };
      return r.events.map((e) => e.event_type);
    };
    await expect
      .poll(servedTypes, {
        message: "the archive must ingest the merge before a rebuild can reproduce the chain",
        timeout: 300_000,
        intervals: [15_000],
      })
      .toContain("merge");

    // THE DESTRUCTIVE STEP. This is the situation the feature exists for: the
    // commitments are on chain, the openings are gone, and only a replay can
    // reproduce them.
    await page.evaluate(
      (key) => chrome.storage.local.remove(key),
      openingsKey,
    );
    expect(Object.keys(await storage(page)), "the openings must actually be gone").not.toContain(
      openingsKey,
    );

    const rebuilt = await send<{ spendable?: string; receiving?: string }>(page, {
      type: "rebuildFromHistory",
    });
    expect(rebuilt.ok, `rebuild refused: ${rebuilt.error ?? ""}`).toBe(true);

    // The number has to come back, and it has to come back because the CHAIN
    // agreed: `recoverOpenings` re-commits the replayed openings and refuses
    // unless they reproduce the commitments the contract holds. A wrong replay
    // cannot reach this line.
    expect(total(rebuilt.data), "the rebuilt balance must equal what was shielded").toBe(shielded);

    // And it must be on disk again, or the next read starts from nothing.
    expect(Object.keys(await storage(page))).toContain(openingsKey);
  } finally {
    await w.close();
  }
});
