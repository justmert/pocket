import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA, recordRange, isComplete, ingestedThrough } from "./schema.ts";
import { accountEvents, latestCheckpoint, health, CHECKPOINT_TYPES } from "./api.ts";
import { eventPosition } from "./ingest.ts";

const C = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
const ALICE = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";
const BOB = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7";

let db: Database.Database;

function addEvent(
  id: string,
  ledger: number,
  ord: number,
  type: string,
  accounts: string[],
) {
  db.prepare(
    `INSERT INTO events (id, contract_id, ledger_seq, close_time, tx_hash,
       tx_application_order, event_index, event_type, topics_xdr, data_xdr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
  ).run(id, C, ledger, 1700000000 + ledger, `tx${id}`, ord, 0, type);
  for (const a of accounts) {
    db.prepare(`INSERT INTO attribution (event_id, account) VALUES (?, ?)`).run(id, a);
  }
}

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(SCHEMA);
});

describe("C3 completeness signal", () => {
  it("is false when nothing has been ingested", () => {
    expect(accountEvents(db, C, ALICE).complete).toBe(false);
  });

  it("is true only when the whole range is covered gap-free", () => {
    recordRange(db, C, 100, 200);
    expect(isComplete(db, C, 100, 200)).toBe(true);
    expect(isComplete(db, C, 100, 201)).toBe(false);
    expect(isComplete(db, C, 99, 200)).toBe(false);
  });

  it("does NOT report complete across a gap", () => {
    // This is the property the archive exists for. Serving an incomplete range
    // as complete lets a wallet reconstruct a plausible WRONG balance.
    recordRange(db, C, 100, 150);
    recordRange(db, C, 160, 200);
    expect(isComplete(db, C, 100, 200)).toBe(false);
  });

  it("coalesces adjacent ranges, which leave no gap", () => {
    recordRange(db, C, 100, 150);
    recordRange(db, C, 151, 200);
    expect(isComplete(db, C, 100, 200)).toBe(true);
  });

  it("coalesces overlapping ranges", () => {
    recordRange(db, C, 100, 160);
    recordRange(db, C, 150, 200);
    expect(isComplete(db, C, 100, 200)).toBe(true);
  });
});

describe("C2 ordered history", () => {
  beforeEach(() => {
    // Deliberately inserted out of order.
    addEvent("3", 2, 1, "merge", [ALICE]);
    addEvent("1", 1, 1, "register", [ALICE]);
    addEvent("2", 1, 2, "deposit", [ALICE]);
    recordRange(db, C, 1, 10);
  });

  it("returns events in canonical emission order", () => {
    // Replay is only correct in emission order: a merge and a deposit in the
    // same ledger give different state depending on which is applied first.
    const page = accountEvents(db, C, ALICE);
    expect(page.events.map((e) => e.id)).toEqual(["1", "2", "3"]);
  });

  it("orders within a ledger by application order", () => {
    const page = accountEvents(db, C, ALICE);
    const sameLedger = page.events.filter((e) => e.ledger_seq === 1);
    expect(sameLedger.map((e) => e.tx_application_order)).toEqual([1, 2]);
  });

  it("filters by type AFTER attribution, not by dropping from storage", () => {
    const page = accountEvents(db, C, ALICE, { types: ["deposit"] });
    expect(page.events.map((e) => e.id)).toEqual(["2"]);
    // The others are still stored and still reachable.
    expect(accountEvents(db, C, ALICE).events).toHaveLength(3);
  });

  it("paginates with a keyset cursor that cannot skip or repeat", () => {
    const first = accountEvents(db, C, ALICE, { limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual(["1", "2"]);
    expect(first.cursor).toBe("1:2:0");
    const second = accountEvents(db, C, ALICE, { limit: 2, cursor: first.cursor! });
    expect(second.events.map((e) => e.id)).toEqual(["3"]);
    expect(second.cursor).toBeNull();
  });
});

/**
 * The keyset is only a keyset if the values under it are distinct, and nothing
 * above proves that: `addEvent` is handed an ordinal and stores a literal 0 in
 * `event_index`, so every test in this file supplies a key that is already
 * unique by construction. The ingest path does not have that luxury. It derives
 * the key from the RPC's event id, and it used to derive it wrongly: the id's
 * trailing number restarts at zero for every operation, so three events from
 * three transactions in one ledger were all stored as (ledger, 0, 0).
 *
 * These ids are real, read from soroban-testnet ledger 4021819. They go in
 * through `eventPosition`, which is what `ingestRange` uses, so this exercises
 * the derivation rather than trusting it.
 */
describe("C2 ordered history, keyed the way ingest keys it", () => {
  const LEDGER = 4021819;
  // Three transactions in one ledger: application orders 0, 1 and 2.
  const IDS = [
    "0017273581075431424-0000000000",
    "0017273581075435520-0000000000",
    "0017273581075439616-0000000000",
  ];

  function addAsIngestWould(id: string, type: string, accounts: string[]) {
    const p = eventPosition(id);
    db.prepare(
      `INSERT INTO events (id, contract_id, ledger_seq, close_time, tx_hash,
         tx_application_order, event_index, event_type, topics_xdr, data_xdr)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '')`,
    ).run(id, C, LEDGER, 1700000000, `tx-${id}`, p.operation, p.index, type);
    for (const a of accounts) {
      db.prepare(`INSERT INTO attribution (event_id, account) VALUES (?, ?)`).run(id, a);
    }
  }

  beforeEach(() => {
    for (const id of IDS) addAsIngestWould(id, "transfer", [ALICE]);
    recordRange(db, C, LEDGER - 1, LEDGER + 1);
  });

  it("stores three events from one ledger under three distinct keys", () => {
    const keys = db
      .prepare(`SELECT tx_application_order AS o, event_index AS i FROM events`)
      .all() as { o: number; i: number }[];
    expect(new Set(keys.map((k) => `${k.o}:${k.i}`)).size).toBe(3);
  });

  it("returns every event when paged one at a time", () => {
    // The defect this pins: with all three under (4021819, 0, 0), the first
    // page emitted cursor "4021819:0:0" and the `>` comparison then excluded
    // all three, so the loop returned ONE event and terminated while an
    // unpaged read returned three, and every page still said complete: true.
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: ReturnType<typeof accountEvents> = accountEvents(db, C, ALICE, {
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.events.map((e) => e.id));
      cursor = page.cursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(IDS);
    expect(accountEvents(db, C, ALICE).events).toHaveLength(3);
  });

  it("pages in the same order an unpaged read returns", () => {
    const unpaged = accountEvents(db, C, ALICE).events.map((e) => e.id);
    const firstPage = accountEvents(db, C, ALICE, { limit: 2 });
    const rest = accountEvents(db, C, ALICE, { limit: 2, cursor: firstPage.cursor! });
    expect([...firstPage.events, ...rest.events].map((e) => e.id)).toEqual(unpaged);
  });
});

describe("attribution", () => {
  it("gives a transfer to BOTH parties", () => {
    // A Transfer belongs to the sender's AND the recipient's history.
    // Attribution comes from topics, never from the transaction source account.
    addEvent("t", 5, 1, "transfer", [ALICE, BOB]);
    recordRange(db, C, 1, 10);
    expect(accountEvents(db, C, ALICE).events.map((e) => e.id)).toEqual(["t"]);
    expect(accountEvents(db, C, BOB).events.map((e) => e.id)).toEqual(["t"]);
  });

  it("does not leak one account's events to another", () => {
    addEvent("a", 1, 1, "deposit", [ALICE]);
    recordRange(db, C, 1, 10);
    expect(accountEvents(db, C, BOB).events).toHaveLength(0);
  });
});

describe("C1 latest checkpoint", () => {
  it("returns the most recent checkpoint, not the most recent event", () => {
    // Deposit and merge are NOT checkpoints: they carry no (b_tilde, sigma).
    addEvent("w", 10, 1, "withdraw", [ALICE]);
    addEvent("d", 20, 1, "deposit", [ALICE]);
    addEvent("m", 30, 1, "merge", [ALICE]);
    recordRange(db, C, 1, 40);
    expect(latestCheckpoint(db, C, ALICE).event?.id).toBe("w");
  });

  it("respects an at_ledger bound", () => {
    addEvent("w1", 10, 1, "withdraw", [ALICE]);
    addEvent("w2", 30, 1, "withdraw", [ALICE]);
    recordRange(db, C, 1, 40);
    expect(latestCheckpoint(db, C, ALICE).event?.id).toBe("w2");
    expect(latestCheckpoint(db, C, ALICE, 20).event?.id).toBe("w1");
  });

  it("names exactly the four checkpoint types", () => {
    expect(CHECKPOINT_TYPES.sort()).toEqual(
      ["revoke_spender", "set_spender", "transfer", "withdraw"].sort(),
    );
  });

  it("returns null rather than guessing when there is no checkpoint", () => {
    addEvent("d", 1, 1, "deposit", [ALICE]);
    recordRange(db, C, 1, 10);
    expect(latestCheckpoint(db, C, ALICE).event).toBeNull();
  });
});

describe("C4 ingestion status", () => {
  it("reports how far ingestion has reached", () => {
    addEvent("a", 5, 1, "deposit", [ALICE]);
    recordRange(db, C, 1, 100);
    const h = health(db, C);
    expect(h.ingested_through).toBe(100);
    expect(h.latest_ledger).toBe(5);
  });

  it("reports null before anything is ingested, not zero", () => {
    // Zero would read as "ingested through the genesis ledger", which is a
    // different and much more dangerous claim than "nothing yet".
    expect(ingestedThrough(db, C)).toBeNull();
    expect(health(db, C).ingested_through).toBeNull();
  });
});

describe("deduplication", () => {
  it("stores an event once even if ingested twice", () => {
    // At-least-once ingestion is expected; crediting rules accumulate, so a
    // duplicate would inflate a balance.
    addEvent("x", 1, 1, "deposit", [ALICE]);
    expect(() => addEvent("x", 1, 1, "deposit", [ALICE])).toThrow();
    expect(db.prepare(`SELECT COUNT(*) AS n FROM events`).get()).toEqual({ n: 1 });
  });
});

describe("the completeness signal is honestly scoped", () => {
  it("reports the range it is actually speaking for", () => {
    addEvent("a", 500, 1, "deposit", [ALICE]);
    recordRange(db, C, 400, 600);
    const page = accountEvents(db, C, ALICE);
    // Not [0, MAX]: an archive cannot speak for ledgers it never held, and a
    // permanently-false signal is worse than none because clients learn to
    // ignore it.
    expect(page.from_ledger).toBe(400);
    expect(page.to_ledger).toBe(600);
    expect(page.complete).toBe(true);
  });

  it("still reports incomplete when the caller asks beyond what we hold", () => {
    addEvent("a", 500, 1, "deposit", [ALICE]);
    recordRange(db, C, 400, 600);
    expect(accountEvents(db, C, ALICE, { fromLedger: 100 }).complete).toBe(false);
  });

  it("reports incomplete when nothing has been ingested", () => {
    const page = accountEvents(db, C, ALICE);
    expect(page.complete).toBe(false);
    expect(page.events).toHaveLength(0);
  });

  it("a checkpoint is complete only if nothing since it could be missing", () => {
    addEvent("w", 450, 1, "withdraw", [ALICE]);
    recordRange(db, C, 400, 500);
    expect(latestCheckpoint(db, C, ALICE).complete).toBe(true);
    // A gap after the checkpoint means later events may be missing, so the
    // checkpoint alone is not enough to rebuild state.
    recordRange(db, C, 600, 700);
    expect(latestCheckpoint(db, C, ALICE, 700).complete).toBe(false);
  });
});

describe("completeness is about the range that was asked for", () => {
  it("reports a requested window beyond what it holds as incomplete", () => {
    // Hold 1000..2000, then ask for 1000..5000.
    recordRange(db, C, 1000, 2000);
    addEvent("e1", 1500, 1, "transfer", [ALICE]);

    const page = accountEvents(db, C, ALICE, { fromLedger: 1000, toLedger: 5000 });

    // The reply must be about the question asked. Narrowing to 2000 and then
    // saying "complete" is true about a different question and misleads any
    // client that reads the flag alone.
    expect(page.to_ledger).toBe(5000);
    expect(page.complete).toBe(false);
    // The events it does hold are still served.
    expect(page.events).toHaveLength(1);
  });

  it("still reports complete when the request fits inside what it holds", () => {
    recordRange(db, C, 1000, 5000);
    addEvent("e1", 1500, 1, "transfer", [ALICE]);

    const page = accountEvents(db, C, ALICE, { fromLedger: 1000, toLedger: 2000 });
    expect(page.to_ledger).toBe(2000);
    expect(page.complete).toBe(true);
  });
});

describe("the invocation payload, which is what makes a received transfer replayable", () => {
  // A transfer event publishes no c_transfer, so a recipient can derive a
  // candidate amount and has nothing to check it against. The commitment rides
  // in the transaction instead. The archive stores it, and if it does not serve
  // it back the wallet is exactly where it was: refusing to replay any payment
  // its owner ever received.
  function addWithPayload(id: string, ledger: number, payload: string | null) {
    db.prepare(
      `INSERT INTO events (id, contract_id, ledger_seq, close_time, tx_hash,
         tx_application_order, event_index, event_type, topics_xdr, data_xdr, payload_xdr)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'transfer', '', '', ?)`,
    ).run(id, C, ledger, 1700000000 + ledger, `tx${id}`, ledger, 0, payload);
    db.prepare(`INSERT INTO attribution (event_id, account) VALUES (?, ?)`).run(id, ALICE);
  }

  it("is served back on the event that carries it", () => {
    addWithPayload("p1", 10, "UEFZTE9BRA==");
    recordRange(db, C, 1, 100);
    const page = accountEvents(db, C, ALICE, { fromLedger: 1, toLedger: 100 });
    expect(page.events).toHaveLength(1);
    expect(page.events[0]!.payload_xdr).toBe("UEFZTE9BRA==");
  });

  it("is null, not absent, when the transaction could not be read", () => {
    // An honest null. The wallet refuses that one event rather than crediting
    // an amount it cannot verify, which is the behaviour it had before payloads
    // existed at all.
    addWithPayload("p2", 11, null);
    recordRange(db, C, 1, 100);
    const page = accountEvents(db, C, ALICE, { fromLedger: 1, toLedger: 100 });
    expect(page.events[0]!.payload_xdr ?? null).toBeNull();
  });

  it("does not disturb the events that never needed one", () => {
    addEvent("d1", 12, 12, "deposit", [ALICE]);
    recordRange(db, C, 1, 100);
    const page = accountEvents(db, C, ALICE, { fromLedger: 1, toLedger: 100 });
    expect(page.events[0]!.event_type).toBe("deposit");
    expect(page.events[0]!.payload_xdr ?? null).toBeNull();
  });
});

describe("migrating an archive that predates the payload column", () => {
  it("adds the column instead of failing at read time", async () => {
    // The failure this prevents: `CREATE TABLE IF NOT EXISTS` does nothing to an
    // existing table, so a deployed archive would keep a schema with no
    // payload_xdr and every query naming it would error. Simulated by creating
    // the table WITHOUT the column, exactly as an older build did.
    const { migrate } = await import("./schema.ts");
    const old = new Database(":memory:");
    old.exec(`CREATE TABLE events (
      id TEXT PRIMARY KEY, contract_id TEXT NOT NULL, ledger_seq INTEGER NOT NULL,
      close_time INTEGER NOT NULL, tx_hash TEXT NOT NULL,
      tx_application_order INTEGER NOT NULL, event_index INTEGER NOT NULL,
      event_type TEXT NOT NULL, topics_xdr TEXT NOT NULL, data_xdr TEXT NOT NULL)`);
    const before = (old.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(before).not.toContain("payload_xdr");

    migrate(old);
    const after = (old.prepare(`PRAGMA table_info(events)`).all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(after).toContain("payload_xdr");

    // And running it again is safe, because it runs on every open.
    expect(() => migrate(old)).not.toThrow();
  });
});
