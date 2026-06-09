import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { SCHEMA, recordRange, isComplete, ingestedThrough } from "./schema.ts";
import { accountEvents, latestCheckpoint, health, CHECKPOINT_TYPES } from "./api.ts";

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
