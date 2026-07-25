// The range the archive CLAIMS has to be the range it actually scanned.
//
// soroban-rpc treats `startLedger` as inclusive and `endLedger` as EXCLUSIVE.
// `ingestRange(db, server, id, from, to)` asked for
// {startLedger: from, endLedger: to}, which scans [from, to) and never looks at
// `to` itself. It then called `recordRange(db, id, from, to)` claiming the
// closed interval, and `backfill` advanced with `from = to + 1`.
//
// So ledger `to` was skipped, never revisited, and reported as covered: one
// lost ledger every CHUNK (10,000), with the completeness signal saying the
// history is whole. An event on one of those ledgers is a private balance the
// rebuild cannot reconstruct, and that rebuild is the only thing standing
// between a restored wallet and money that is visible on chain and unspendable.
//
// A gap the archive admits to is recoverable. A gap it denies is not, which is
// why this is about the CLAIM as much as the scan.
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA } from "./schema.ts";
import { ingestRange } from "./ingest.ts";
import { coveredRange, accountEvents } from "./api.ts";

const ACCOUNT = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";
const CONTRACT = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";

/** Records what it was asked for, and answers with nothing. */
function recordingServer() {
  const asked: { startLedger?: number; endLedger?: number; cursor?: string }[] = [];
  return {
    asked,
    getEvents: async (req: { startLedger?: number; endLedger?: number; cursor?: string }) => {
      asked.push(req);
      return { events: [], latestLedger: 100_000 };
    },
  };
}

function db() {
  const d = new Database(":memory:");
  d.exec(SCHEMA);
  return d;
}

describe("the ledger window the archive asks for", () => {
  it("asks past the last ledger it intends to cover, because endLedger is exclusive", async () => {
    const server = recordingServer();
    await ingestRange(db(), server as never, CONTRACT, 1_000, 1_099);

    const first = server.asked[0];
    expect(first?.startLedger, "startLedger is inclusive and stays as asked").toBe(1_000);
    expect(
      first?.endLedger,
      "endLedger is EXCLUSIVE, so covering ledger 1099 means asking for 1100",
    ).toBe(1_100);
  });

  it("covers a single-ledger range at all", async () => {
    // The degenerate case the old arithmetic could never scan: from === to
    // asked for [n, n), which is empty.
    const server = recordingServer();
    await ingestRange(db(), server as never, CONTRACT, 5_000, 5_000);
    expect(server.asked[0]?.endLedger).toBe(5_001);
    expect(server.asked[0]?.endLedger).not.toBe(server.asked[0]?.startLedger);
  });

  it("claims exactly the closed interval it was asked to cover", async () => {
    // The other half. Scanning correctly and then claiming the wrong range
    // moves the lie rather than removing it.
    const d = db();
    await ingestRange(d, recordingServer() as never, CONTRACT, 2_000, 2_999);
    expect(coveredRange(d, CONTRACT)).toEqual({ from: 2_000, to: 2_999 });
  });

  it("leaves no hole where two consecutive chunks meet", async () => {
    // backfill advances with `from = to + 1`, so the boundary is where the
    // dropped ledger used to live: chunk one covered [1000, 1099) and claimed
    // through 1099, chunk two started at 1100, and 1099 was never scanned.
    const server = recordingServer();
    const d = db();
    await ingestRange(d, server as never, CONTRACT, 1_000, 1_099);
    await ingestRange(d, server as never, CONTRACT, 1_100, 1_199);

    const windows = server.asked.map((a) => [a.startLedger, a.endLedger]);
    expect(windows).toEqual([
      [1_000, 1_100],
      [1_100, 1_200],
    ]);
    // Every ledger from 1000 to 1199 falls inside one of the half-open windows
    // actually requested, which is the property the claim depends on.
    for (const n of [1_000, 1_099, 1_100, 1_199]) {
      const seen = windows.some(([s, e]) => n >= (s as number) && n < (e as number));
      expect(seen, `ledger ${n} was claimed but never scanned`).toBe(true);
    }
  });
});

describe("an archive with a gap in the middle", () => {
  // `coveredRange` answers about the FIRST contiguous block, and
  // `accountEvents` defaulted both bounds from it. So an unbounded request was
  // answered about the pre-gap window, `isComplete` was asked about that narrow
  // window and said true, and the caller was told it had the whole history
  // while every event after the gap was silently not served.
  //
  // A client replaying that answer builds a balance out of half its history and
  // has been told the half is whole. The wallet refuses to spend from a state
  // it cannot verify, so this ends as funds it will not touch.
  const server = () => recordingServer() as never;

  async function gapped() {
    const d = db();
    await ingestRange(d, server(), CONTRACT, 100, 199);
    // 200..299 never ingested.
    await ingestRange(d, server(), CONTRACT, 300, 399);
    return d;
  }

  it("does not report an unbounded query as complete", async () => {
    const d = await gapped();
    const page = accountEvents(d, CONTRACT, ACCOUNT);
    expect(page.complete, "a history with a hole in it was reported whole").toBe(false);
  });

  it("reports the window it actually spans, not just the first block", async () => {
    const d = await gapped();
    const page = accountEvents(d, CONTRACT, ACCOUNT);
    expect(page.from_ledger).toBe(100);
    expect(page.to_ledger, "the answer stopped at the gap and said nothing").toBe(399);
  });

  it("still reports complete when there is no gap", async () => {
    // The control. A signal that is always false is one clients learn to ignore,
    // which is the failure this whole mechanism exists to avoid.
    const d = db();
    await ingestRange(d, server(), CONTRACT, 100, 199);
    await ingestRange(d, server(), CONTRACT, 200, 299);
    expect(accountEvents(d, CONTRACT, ACCOUNT).complete).toBe(true);
  });
});
