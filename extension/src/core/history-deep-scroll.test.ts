// Scrolling past the newest thousand payment records.
//
// `publicHistory` walked Horizon from the NEWEST page on every call and skipped
// forward to the cursor. Its own comment called the cost "some repeated reads
// on deep scrolls". The real cost was that the skip is bounded by
// MAX_PAGES x PAGE = 1000 records: once a cursor sat past record 1000, all
// twenty pages were skipped, the call returned zero entries with `more: true`,
// and the controller then derived its next cursor from the last entry, of which
// there was none. Null cursor, `loadMore` returns early forever, and Activity
// stops partway back with nothing on screen saying it was truncated.
//
// An account using the integrations reaches that wall much sooner, because
// every swap, bridge and yield move is an `invoke_host_function` record
// consuming the same page budget.
import { describe, it, expect, vi, beforeEach } from "vitest";
import "../lib/polyfill";
import { publicHistory, encodeCursor, decodeCursor } from "./chain/history";

const ME = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const THEM = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

/** Every URL the walk asked Horizon for, in order. */
let asked: string[] = [];

/** A payment record `n` steps back from the newest. */
const record = (n: number) => ({
  id: `${1_000_000 - n}`,
  paging_token: `tok-${n}`,
  type: "payment",
  created_at: new Date(1_700_000_000_000 - n * 60_000).toISOString(),
  transaction_hash: `h${n}`,
  from: THEM,
  to: ME,
  asset_type: "native",
  amount: "1.0000000",
});

/** 4000 records, served 50 at a time, resuming on `cursor` exactly as Horizon does. */
function horizon(total = 4000) {
  return async (url: string) => {
    asked.push(url);
    const m = /[?&]cursor=([^&]+)/.exec(url);
    const from = m ? Number(decodeURIComponent(m[1]!).replace("tok-", "")) + 1 : 0;
    const page = [];
    for (let n = from; n < Math.min(from + 50, total); n++) page.push(record(n));
    return { _embedded: { records: page } };
  };
}

beforeEach(() => {
  asked = [];
  vi.stubGlobal("fetch", async (url: string) => ({
    ok: true,
    json: async () => horizon()(url),
  }));
});

const read = (before: ReturnType<typeof decodeCursor>) =>
  publicHistory({ horizonUrl: "https://h", account: ME, before, limit: 30 });

/**
 * A cursor sitting exactly at record `n`, the way a real one would.
 *
 * `(at, id)` and the token have to describe the same position: the token says
 * where Horizon resumes and `(at, id)` says what has already been shown, and a
 * pair that disagrees would filter out everything the resume returned.
 */
const cursorAt = (n: number) =>
  decodeCursor(
    encodeCursor({
      at: 1_700_000_000_000 - n * 60_000,
      id: `${1_000_000 - n}`,
      token: `tok-${n}`,
    }),
  );

describe("history deeper than the page budget", () => {
  it("resumes from the cursor's token instead of walking from the newest page", async () => {
    const page = await read(cursorAt(2500));
    // The FIRST request already carries the token. Without it, the walk starts
    // at the newest page and burns its whole budget skipping.
    expect(asked[0]).toContain("cursor=tok-2500");
    expect(page.entries).toHaveLength(30);
  });

  it("reaches record 3000, which the skip could never get to", async () => {
    // 1000 records was the hard ceiling. This is three times past it, in one
    // call, because the resume costs one request rather than twenty.
    const page = await read(cursorAt(3000));
    expect(page.entries.length).toBeGreaterThan(0);
    expect(asked).toHaveLength(1);
  });

  it("still works for a cursor issued before tokens existed", async () => {
    // Old cursors carry no token and must not become an error or an empty page.
    const page = await read(decodeCursor(encodeCursor({ at: 9_999_999_999_999, id: "zzz" })));
    expect(asked[0]).not.toContain("cursor=");
    expect(page.entries).toHaveLength(30);
  });

  it("reports a paging token for every entry it returns", async () => {
    // The caller needs one per entry, because the merge with the private side
    // decides which of them survive the page.
    const page = await read(null);
    for (const e of page.entries) expect(page.tokenOf[e.id], e.id).toBeTruthy();
  });

  it("round-trips the token through the cursor codec", async () => {
    const c = decodeCursor(encodeCursor({ at: 5, id: "e", token: "tok-77" }));
    expect(c).toEqual({ at: 5, id: "e", token: "tok-77" });
  });

  it("drops a token that is not a string rather than trusting it", async () => {
    const bad = Buffer.from(JSON.stringify({ at: 5, id: "e", token: 12 }), "utf8").toString(
      "base64",
    );
    expect(decodeCursor(bad)).toEqual({ at: 5, id: "e" });
  });
});
