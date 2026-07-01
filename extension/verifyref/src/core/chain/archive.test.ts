import { describe, it, expect, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  computeSeam,
  archiveCoversSeam,
  ArchiveClient,
  ArchiveUnavailableError,
  IncompleteHistoryError,
  SEAM_MARGIN_LEDGERS,
} from "./archive";

const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const servers: http.Server[] = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** A real HTTP server answering with `body`, so the client's own parsing runs. */
function serving(body: string, status = 200): Promise<string> {
  return new Promise((resolve) => {
    const s = http.createServer((_q, r) => {
      r.writeHead(status, { "content-type": "application/json" });
      r.end(body);
    });
    servers.push(s);
    s.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
    );
  });
}

/** A server that accepts the connection and then says nothing, ever. */
function stalling(): Promise<string> {
  return new Promise((resolve) => {
    const s = http.createServer(() => {});
    servers.push(s);
    s.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${(s.address() as AddressInfo).port}`),
    );
  });
}

const page = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    events: [],
    from_ledger: 1,
    to_ledger: 1000,
    cursor: null,
    complete: true,
    ...over,
  });

describe("the hybrid seam", () => {
  it("sits strictly above the RPC floor", () => {
    // The floor advances as ledgers close. A seam placed exactly at it can be
    // BELOW it by the time a second request lands, leaving a range neither
    // source covers.
    const floor = 3_776_032;
    expect(computeSeam(floor)).toBeGreaterThan(floor);
    expect(computeSeam(floor) - floor).toBe(SEAM_MARGIN_LEDGERS);
  });

  it("keeps a margin wide enough for a slow request", () => {
    // 1000 ledgers is about 83 minutes at 5s each: far longer than any request.
    expect(SEAM_MARGIN_LEDGERS).toBeGreaterThanOrEqual(1000);
  });

  it("refuses to trust an archive that has not reached the seam", () => {
    const seam = 3_777_032;
    expect(
      archiveCoversSeam(
        { contract_id: "C", latest_ledger: 1, ingested_through: seam - 1, lag_seconds: 0 },
        seam,
      ),
    ).toBe(false);
    expect(
      archiveCoversSeam(
        { contract_id: "C", latest_ledger: 1, ingested_through: seam, lag_seconds: 0 },
        seam,
      ),
    ).toBe(true);
  });

  it("treats a never-ingested archive as not covering anything", () => {
    expect(
      archiveCoversSeam(
        { contract_id: "C", latest_ledger: null, ingested_through: null, lag_seconds: null },
        1,
      ),
    ).toBe(false);
  });
});

describe("failing closed", () => {
  it("raises rather than silently degrading to RPC-only", async () => {
    // The dangerous shape: fall back to RPC, persist a cursor from that leg,
    // and the skipped range's openings become UNRECOVERABLE once those ledgers
    // age out of RPC. Nothing else holds them.
    const client = new ArchiveClient("http://127.0.0.1:1");
    await expect(client.health("C")).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });

  it("says explicitly that it will not fall back", async () => {
    const client = new ArchiveClient("http://127.0.0.1:1");
    await expect(client.health("C")).rejects.toThrow(/will not fall back/i);
  });

  it("bounds the wait instead of hanging on an archive that never answers", async () => {
    // A server that accepts the connection and then stalls is the failure a
    // dead port does not cover. With no deadline this promise never settled,
    // and the popup spun with nothing scheduled to stop it.
    const url = await stalling();
    const client = new ArchiveClient(url, { timeoutMs: 300 });
    await expect(client.health("C")).rejects.toBeInstanceOf(ArchiveUnavailableError);
    await expect(client.health("C")).rejects.toThrow(/no answer within/i);
  }, 10_000);

  it("treats a body that is not JSON as the archive being unavailable", async () => {
    // A proxy error page or a captive portal arrives with a 200 and an HTML
    // body. Left unwrapped it escaped as a bare SyntaxError, missed the error
    // allowlist, and the user was told to check their connection.
    const url = await serving("<html>502 Bad Gateway</html>");
    await expect(new ArchiveClient(url).health("C")).rejects.toBeInstanceOf(
      ArchiveUnavailableError,
    );
  });

  it("refuses a page whose completeness flag is missing", async () => {
    // Absent is not true. Defaulting it either way invents an answer to the
    // one question that decides whether a gap is about to be skipped.
    const url = await serving(
      JSON.stringify({ events: [], from_ledger: 1, to_ledger: 2, cursor: null }),
    );
    await expect(new ArchiveClient(url).events("C", ACCOUNT)).rejects.toBeInstanceOf(
      ArchiveUnavailableError,
    );
  });

  it("refuses a page with no events list at all", async () => {
    const url = await serving("{}");
    await expect(new ArchiveClient(url).events("C", ACCOUNT)).rejects.toBeInstanceOf(
      ArchiveUnavailableError,
    );
  });

  it("refuses a page that reports complete: false", async () => {
    const url = await serving(page({ complete: false }));
    await expect(new ArchiveClient(url).events("C", ACCOUNT)).rejects.toBeInstanceOf(
      IncompleteHistoryError,
    );
  });

  it("refuses a page that narrows the window it was asked about", async () => {
    // `complete: true` about ledgers 900000-900010 is a true statement about a
    // question nobody asked. Reading the flag alone accepts it and inherits
    // the gap below 900000.
    const url = await serving(page({ from_ledger: 900_000, to_ledger: 900_010, complete: true }));
    await expect(
      new ArchiveClient(url).events("C", ACCOUNT, { fromLedger: 1, toLedger: 900_010 }),
    ).rejects.toBeInstanceOf(IncompleteHistoryError);
  });

  it("refuses a page that stops short of the ledger it was asked about", async () => {
    const url = await serving(page({ from_ledger: 1, to_ledger: 500, complete: true }));
    await expect(
      new ArchiveClient(url).events("C", ACCOUNT, { fromLedger: 1, toLedger: 1000 }),
    ).rejects.toBeInstanceOf(IncompleteHistoryError);
  });

  it("accepts a page that is complete across exactly the window asked for", async () => {
    const url = await serving(page());
    const got = await new ArchiveClient(url).events("C", ACCOUNT, {
      fromLedger: 1,
      toLedger: 1000,
    });
    expect(got.complete).toBe(true);
    expect(got.to_ledger).toBe(1000);
  });

  it("refuses a health report that omits how far it has ingested", async () => {
    // ingested_through decides whether the archive can be trusted below the
    // seam. An absent field must not read as zero, and must not read as fine.
    const url = await serving(JSON.stringify({ contract_id: "C", latest_ledger: 5 }));
    await expect(new ArchiveClient(url).health("C")).rejects.toBeInstanceOf(
      ArchiveUnavailableError,
    );
  });

  it("accepts a health report that says null explicitly", async () => {
    const url = await serving(
      JSON.stringify({
        contract_id: "C",
        latest_ledger: null,
        ingested_through: null,
        lag_seconds: null,
      }),
    );
    expect(await new ArchiveClient(url).health("C")).toMatchObject({ ingested_through: null });
  });
});
