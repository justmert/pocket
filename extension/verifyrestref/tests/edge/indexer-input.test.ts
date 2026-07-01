// The archive's HTTP surface, fed the input it will actually get.
//
// This is the one component in the system with a SQL engine behind it, and its
// parameters arrive in a URL from anyone who can reach the port. Every query
// string below goes over a real socket to the real `indexer/src/server.ts`,
// started as a child process against a real SQLite file this test seeded, so
// the answers are the ones an operator would get.
//
// Nothing is mocked. The database is the fixture, not a stand-in for one: an
// injection test that runs against a stub proves the stub is safe.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
// POCKET_INDEXER_SRC points this suite at a COPY of the archive's source, which
// is how a mutation is shown to turn these tests red without ever editing the
// tree nine other agents are reading. Relative imports and node_modules still
// resolve, because the copy lives inside indexer/.
const INDEXER = process.env.POCKET_INDEXER_SRC ?? resolve(here, "../../../indexer/src/server.ts");
const INDEXER_PKG = resolve(here, "../../../indexer/package.json");

// better-sqlite3 is the indexer's dependency, not the extension's, so it is
// resolved from where it actually lives rather than being added here.
const requireFromIndexer = createRequire(INDEXER_PKG);

const CONTRACT = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
const MINE = "GCAXOGG3DK6GKLRBUTE7WHIY2GPOAQCXLUX4O5VO6IRT43564LX5SG3M";
const SOMEBODY_ELSE = "GBKQRVPOLWHN53KIWJQJBHGHIE7VXDGEEJXW7SZ3D3MQBWQVZFQRS454";

/** The window the fixture archive can speak for, contiguous. */
const FROM = 100;
const TO = 104;
/** Five events for MINE inside it, one per ledger, plus a bulk tail. */
const MINE_EVENTS = 5;
/** Enough to prove the server's own 1,000-row ceiling actually clamps. */
const BULK = 1_100;

interface Page {
  from_ledger: number;
  to_ledger: number;
  events: { id: string; ledger_seq: number; event_type: string }[];
  cursor: string | null;
  complete: boolean;
}

let base = "";
let child: ChildProcess | null = null;
let dir = "";

async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
  const { port } = s.address() as { port: number };
  await new Promise<void>((ok) => s.close(() => ok()));
  return port;
}

/** A real archive holding a known history, built with the indexer's own schema. */
function seed(path: string): void {
  // Structurally typed rather than imported: better-sqlite3 is the indexer's
  // dependency and its types are not installed in extension/.
  interface Statement {
    run(...args: unknown[]): unknown;
  }
  interface Db {
    pragma(p: string): unknown;
    exec(sql: string): unknown;
    prepare(sql: string): Statement;
    transaction(fn: () => void): () => void;
    close(): void;
  }
  const Database = requireFromIndexer("better-sqlite3") as new (p: string) => Db;
  const { SCHEMA } = requireFromIndexer("./src/schema.ts") as { SCHEMA: string };
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const event = db.prepare(
    `INSERT INTO events (id, contract_id, ledger_seq, close_time, tx_hash,
                         tx_application_order, event_index, event_type, topics_xdr, data_xdr)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const attribute = db.prepare(`INSERT INTO attribution (event_id, account) VALUES (?, ?)`);
  const types = ["deposit", "withdraw", "transfer", "rollover", "transfer"];

  const insert = db.transaction(() => {
    for (let i = 0; i < MINE_EVENTS; i += 1) {
      const id = `mine-${i}`;
      event.run(id, CONTRACT, FROM + i, 1_700_000_000 + i, `hash-${i}`, 0, i, types[i]!, "AAAA", "BBBB");
      attribute.run(id, MINE);
    }
    // Somebody else's history, in the same window and the same contract. Every
    // "no rows came back" assertion below is worthless without it: an empty
    // answer from an empty table proves nothing.
    for (let i = 0; i < 3; i += 1) {
      const id = `theirs-${i}`;
      event.run(id, CONTRACT, FROM + i, 1_700_000_000 + i, `hash-t-${i}`, 1, i, "transfer", "CCCC", "DDDD");
      attribute.run(id, SOMEBODY_ELSE);
    }
    // A bulk tail on the last ledger of the window, for the limit ceiling.
    for (let i = 0; i < BULK; i += 1) {
      const id = `bulk-${i}`;
      event.run(id, CONTRACT, TO, 1_700_000_100, `hash-b-${i}`, 2, i, "deposit", "EEEE", "FFFF");
      attribute.run(id, MINE);
    }
    db.prepare(`INSERT INTO ranges (contract_id, from_ledger, to_ledger) VALUES (?, ?, ?)`).run(
      CONTRACT,
      FROM,
      TO,
    );
  });
  insert();
  db.close();
}

async function get(path: string): Promise<{ status: number; body: unknown; text: string }> {
  const res = await fetch(`${base}${path}`);
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: res.status, body, text };
}

/** The events route for one account, with an arbitrary query string. */
const eventsPath = (account: string, query = "") =>
  `/v1/tokens/${encodeURIComponent(CONTRACT)}/accounts/${encodeURIComponent(account)}/events${query}`;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "pocket-t2-archive-"));
  const dbPath = join(dir, "archive.db");
  seed(dbPath);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [INDEXER], {
    env: { ...process.env, PORT: String(port), DB_PATH: dbPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stderr: string[] = [];
  child.stderr?.on("data", (b: Buffer) => stderr.push(b.toString()));
  // Wait on the service's own readiness line, not on a sleep.
  const up = await Promise.race([
    new Promise<boolean>((ok) => {
      child?.stdout?.on("data", (b: Buffer) => {
        if (b.toString().includes("listening")) ok(true);
      });
    }),
    // Not a sleep: the race above resolves on the service's own readiness line
    // and this is only the bound on it. Generous because ten agents share this
    // machine and one run here missed a 30-second bound purely on scheduling
    // delay, which reports as "the indexer did not start" and is not true.
    new Promise<boolean>((ok) => setTimeout(() => ok(false), 120_000)),
  ]);
  expect(up, `indexer did not start within 120s: ${stderr.join("")}`).toBe(true);
});

afterAll(() => {
  child?.kill("SIGKILL");
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("the fixture is real, so an empty answer means something", () => {
  it("serves the seeded history for the account that owns it", async () => {
    const { status, body } = await get(eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}`));
    const page = body as Page;
    expect(status).toBe(200);
    expect(page.complete).toBe(true);
    // No `limit` given, so the server's own default of 200 applies. Asserting
    // the default rather than "some events came back" is the point: a default
    // that silently became 20 or 2,000 would change what every client that
    // omits the parameter believes it has read.
    expect(page.events.length).toBe(200);
    expect(page.events[0]!.id).toBe("mine-0");
    expect(page.cursor, "a page cut off at the default must carry a cursor").not.toBeNull();
  });

  it("never returns another account's events", async () => {
    const { body } = await get(eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}&limit=1000`));
    const ids = (body as Page).events.map((e) => e.id);
    expect(ids.some((id) => id.startsWith("theirs-"))).toBe(false);
    const theirs = await get(
      eventsPath(SOMEBODY_ELSE, `?from_ledger=${FROM}&to_ledger=${TO}`),
    );
    expect((theirs.body as Page).events).toHaveLength(3);
  });
});

describe("SQL injection, in every parameter that reaches a query", () => {
  const PAYLOADS = [
    `' OR '1'='1`,
    `' OR 1=1 --`,
    `'; DROP TABLE events; --`,
    `") OR ("1"="1`,
    `1; DELETE FROM attribution`,
    `%27%20OR%201%3D1`,
    `' UNION SELECT * FROM events --`,
  ];

  it("cannot make the account filter match somebody else", async () => {
    for (const p of PAYLOADS) {
      const { status, body } = await get(eventsPath(p, `?from_ledger=${FROM}&to_ledger=${TO}`));
      expect(status, `payload ${p}`).toBe(200);
      expect((body as Page).events, `payload ${p} returned rows`).toHaveLength(0);
    }
  });

  it("cannot make the contract filter match anything", async () => {
    for (const p of PAYLOADS) {
      const { status, body } = await get(
        `/v1/tokens/${encodeURIComponent(p)}/accounts/${MINE}/events`,
      );
      expect(status, `payload ${p}`).toBe(200);
      expect((body as Page).events, `payload ${p} returned rows`).toHaveLength(0);
      // And health must answer about the contract that was asked for, not
      // about whatever the payload matched.
      const h = await get(`/v1/health?contract_id=${encodeURIComponent(p)}`);
      expect((h.body as { contract_id: string; latest_ledger: number | null }).contract_id).toBe(p);
      expect((h.body as { latest_ledger: number | null }).latest_ledger).toBeNull();
    }
  });

  it("cannot break out of the types filter", async () => {
    for (const p of PAYLOADS) {
      const { status, body } = await get(
        eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}&types=${encodeURIComponent(p)}`),
      );
      expect(status, `payload ${p}`).toBe(200);
      expect((body as Page).events, `payload ${p} returned rows`).toHaveLength(0);
    }
    // A real type still works, so the filter is doing something and the empty
    // answers above are not simply a broken query.
    const ok = await get(eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}&types=withdraw`));
    expect((ok.body as Page).events).toHaveLength(1);
  });

  it("cannot destroy or empty the archive", async () => {
    for (const p of [...PAYLOADS, `x'); DROP TABLE attribution; --`]) {
      await get(eventsPath(MINE, `?types=${encodeURIComponent(p)}&cursor=${encodeURIComponent(p)}`));
      await get(`/v1/tokens/${encodeURIComponent(p)}/accounts/${encodeURIComponent(p)}/checkpoint`);
    }
    // The whole point: after every payload above, the archive still holds
    // exactly what it held before. A dropped table would answer 500 here, and
    // a deleted attribution row would answer 200 with nothing.
    const { status, body } = await get(
      eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}&limit=1000`),
    );
    expect(status).toBe(200);
    expect((body as Page).events).toHaveLength(1_000);
  });
});

describe("malformed parameters answer 400 rather than serialising null", () => {
  const BAD = ["abc", "-1", "1.5", "1e999", "NaN", "Infinity", "١٢٣", "null", "<script>"];

  it("refuses a from_ledger that is not a non-negative integer", async () => {
    for (const v of BAD) {
      const { status, body } = await get(eventsPath(MINE, `?from_ledger=${encodeURIComponent(v)}`));
      expect(status, `from_ledger=${v}`).toBe(400);
      // The message has to name the parameter. "bad request" sends an operator
      // to read the source to find out which of seven parameters was wrong.
      expect((body as { error: string }).error, `from_ledger=${v}`).toContain("from_ledger");
    }
  });

  it("refuses a malformed to_ledger, limit and at_ledger the same way", async () => {
    for (const [name, path] of [
      ["to_ledger", eventsPath(MINE, "?to_ledger=abc")],
      ["limit", eventsPath(MINE, "?limit=-5")],
      [
        "at_ledger",
        `/v1/tokens/${CONTRACT}/accounts/${MINE}/checkpoint?at_ledger=not-a-number`,
      ],
    ] as const) {
      const { status, body } = await get(path);
      expect(status, name).toBe(400);
      expect((body as { error: string }).error, name).toContain(name);
    }
  });

  it("never answers a malformed window with a null ledger range", async () => {
    const { status, text } = await get(eventsPath(MINE, "?from_ledger=abc&to_ledger=xyz"));
    expect(status).toBe(400);
    // The failure mode this replaced: NaN propagating into from/to and
    // serialising as `null`, so the caller got a 200 describing a window that
    // cannot exist.
    expect(text).not.toContain(`"from_ledger":null`);
    expect(text).not.toContain(`"complete":true`);
  });

  it("does not quietly reinterpret a value that is not a decimal integer", async () => {
    // `numParam` promises "a non-negative integer" and implements it with
    // `Number()`, which also accepts hexadecimal, whitespace and exponent
    // notation. None of those is a ledger sequence anyone typed, and each is
    // answered about a DIFFERENT window than the one in the request.
    const coerced: string[] = [];
    for (const [given, becomes] of [
      ["0x10", 16],
      ["  ", 0],
      ["1e3", 1000],
      ["+7", 7],
    ] as const) {
      const { status, body } = await get(eventsPath(MINE, `?from_ledger=${encodeURIComponent(given)}`));
      if (status === 400) continue;
      const page = body as Page;
      if (page.from_ledger === becomes) coerced.push(`"${given}" was read as ledger ${becomes}`);
    }
    expect(coerced, coerced.join("\n")).toEqual([]);
  });

  it("requires contract_id on health rather than answering about nothing", async () => {
    const { status, body } = await get("/v1/health");
    expect(status).toBe(400);
    expect((body as { error: string }).error).toContain("contract_id");
  });
});

describe("boundaries of the requested window", () => {
  it("includes the events sitting exactly on from_ledger and to_ledger", async () => {
    const inclusive = await get(eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${FROM}`));
    expect((inclusive.body as Page).events.map((e) => e.ledger_seq)).toEqual([FROM]);

    const oneIn = await get(eventsPath(MINE, `?from_ledger=${FROM + 1}&to_ledger=${TO - 1}`));
    const seqs = (oneIn.body as Page).events.map((e) => e.ledger_seq);
    expect(seqs).toEqual([FROM + 1, FROM + 2, FROM + 3]);
    expect(seqs, "an off-by-one at the lower bound would show up here").not.toContain(FROM);
    expect(seqs, "and an off-by-one at the upper bound here").not.toContain(TO);
  });

  it("calls a window it does not fully hold incomplete, one ledger past either end", async () => {
    const exact = await get(eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}`));
    expect((exact.body as Page).complete, "the exact window is held").toBe(true);

    const low = await get(eventsPath(MINE, `?from_ledger=${FROM - 1}&to_ledger=${TO}`));
    expect((low.body as Page).complete, "one ledger before the archive starts").toBe(false);

    const high = await get(eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO + 1}`));
    expect((high.body as Page).complete, "one ledger after the archive ends").toBe(false);
  });

  it("does not call an impossible window complete", async () => {
    // from > to describes a window with no ledgers in it. Answering "complete,
    // nothing here" is a true-sounding statement about a question nobody could
    // have meant, and a client replaying history reads it as "no events".
    const { body } = await get(eventsPath(MINE, `?from_ledger=${TO}&to_ledger=${FROM}`));
    const page = body as Page;
    expect(page.events).toHaveLength(0);
    expect(page.complete, "an inverted window must not be reported as complete").toBe(false);
  });

  it("reports the window that was asked about, not the one it happens to hold", async () => {
    const { body } = await get(eventsPath(MINE, `?from_ledger=1&to_ledger=999999`));
    const page = body as Page;
    expect(page.from_ledger).toBe(1);
    expect(page.to_ledger).toBe(999999);
    expect(page.complete).toBe(false);
  });
});

describe("pagination edges", () => {
  it("walks the whole history in small pages without skipping or repeating", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const query = `?from_ledger=${FROM}&to_ledger=${FROM + 4}&limit=2&types=deposit,withdraw,transfer,rollover${
        cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""
      }`;
      const page: Page = (await get(eventsPath(MINE, query))).body as Page;
      seen.push(...page.events.map((e) => e.id));
      cursor = page.cursor;
      if (!cursor) break;
    }
    const named = seen.filter((id) => id.startsWith("mine-"));
    expect(named, "every seeded event exactly once, in order").toEqual([
      "mine-0",
      "mine-1",
      "mine-2",
      "mine-3",
      "mine-4",
    ]);
    expect(new Set(seen).size, "no event may be served twice").toBe(seen.length);
  });

  it("clamps limit to its documented ceiling instead of serving everything", async () => {
    const { body } = await get(
      eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}&limit=1000000`),
    );
    const page = body as Page;
    expect(page.events).toHaveLength(1_000);
    // Truncated means there IS more, so a cursor has to be offered: without
    // one the client stops and believes it has the whole history.
    expect(page.cursor, "a truncated page must carry a cursor").not.toBeNull();
  });

  it("does not serve limit=0 as a complete page of nothing", async () => {
    // The archive's whole contract is that `complete: true` means gap-free
    // across the requested window. A zero-row page that also says complete and
    // offers no cursor tells a replaying client its history is empty.
    const { status, body } = await get(
      eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}&limit=0`),
    );
    const page = body as Page;
    const lies = status === 200 && page.events.length === 0 && page.complete && page.cursor === null;
    expect(lies, "limit=0 must be refused, or must not claim a complete empty history").toBe(false);
  });

  it("answers a cursor past the end with an empty page and no cursor", async () => {
    const { body } = await get(
      eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}&cursor=999999:0:0`),
    );
    const page = body as Page;
    expect(page.events).toHaveLength(0);
    expect(page.cursor).toBeNull();
  });

  it("does not answer a malformed cursor with a complete empty page", async () => {
    // "abc" parses to NaN, and `NaN ?? 0` is NaN, not 0: nullish coalescing
    // does not catch it. Whatever the driver then does with a NaN binding, the
    // one answer that must not come back is "your history is complete and
    // empty", because that is indistinguishable from the truth.
    for (const bad of ["abc", "", ":::", "1:2", "-1:-1:-1", "x:y:z", "1e999:0:0"]) {
      const { status, body } = await get(
        eventsPath(MINE, `?from_ledger=${FROM}&to_ledger=${TO}&cursor=${encodeURIComponent(bad)}`),
      );
      const page = body as Page;
      const lies = status === 200 && page.events.length === 0 && page.complete;
      expect(lies, `cursor="${bad}" claimed a complete empty history`).toBe(false);
    }
  });
});

describe("the surface itself", () => {
  it("refuses a write method rather than advertising one", async () => {
    const res = await fetch(`${base}${eventsPath(MINE)}`, { method: "POST" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toContain("GET");
  });

  it("answers an unknown path with 404 and no internal detail", async () => {
    const { status, text } = await get("/v1/nope");
    expect(status).toBe(404);
    expect(text).not.toMatch(/at .*\.ts:|node_modules|SqliteError/);
  });

  it("survives a very long, unicode or empty identifier without leaking a stack", async () => {
    for (const account of ["A".repeat(10_000), "\u{1f642}\u{1f642}", "مرحبا", "%00", ".."]) {
      const { status, text } = await get(eventsPath(account, `?from_ledger=${FROM}`));
      expect([200, 400, 404], `account=${account.slice(0, 12)}`).toContain(status);
      expect(text, `account=${account.slice(0, 12)}`).not.toMatch(
        /at .*\.ts:|node_modules|SqliteError|ENOENT/,
      );
    }
  });

  it("never lets an event page be cached by an intermediary", async () => {
    const res = await fetch(`${base}${eventsPath(MINE)}`);
    // A cached page carries a `complete` flag that was true when it was served
    // and may not be now, and a stale completeness claim is the one thing this
    // archive must never emit.
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
