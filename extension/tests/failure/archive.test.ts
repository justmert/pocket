// The archive: down, slow, rate-limited, and returning garbage.
//
// The refusal is the FEATURE here, not a limitation. If a configured archive
// cannot answer, the wallet must not fall back to the recent-history-only view:
// falling back would move the sync cursor past a gap, and the events in that gap
// are the only thing that can reopen a confidential balance. They age out of RPC
// retention and nothing else holds them, so the loss is permanent and silent.
//
// So every case below asserts a refusal, and the refusal has to be one the user
// can read. `ArchiveUnavailableError` and `IncompleteHistoryError` are on the
// name allowlist for exactly that reason.
//
// One test runs the REAL indexer, as a child process against a throwaway SQLite
// file, so the recovery half is measured against the service rather than a
// hand-written page.
import { describe, it, expect, afterEach, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ArchiveClient,
  ArchiveUnavailableError,
  IncompleteHistoryError,
  archiveCoversSeam,
  computeSeam,
  parseHealth,
  parsePage,
} from "../../src/core/chain/archive";
import { SERVICE_HTTP_TIMEOUT_MS } from "../../src/core/chain/http";
import { describeError } from "../../src/core/dispatch";
import { FaultServer, DEAD_ORIGIN_HTTP, type Fault } from "./_harness/faults";

const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const CONTRACT = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
const GENERIC = "Something went wrong. Try again.";

const open: FaultServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/** The archive speaks plain http, so the harness does too. */
async function archive(fault: Fault, timeoutMs = 4_000): Promise<ArchiveClient> {
  const server = await FaultServer.start({ fallback: fault, insecure: true });
  open.push(server);
  return new ArchiveClient(server.url, { timeoutMs });
}

const page = (over: Record<string, unknown> = {}): Fault => ({
  kind: "json",
  body: { events: [], from_ledger: 1, to_ledger: 1_000, cursor: null, complete: true, ...over },
});

/** Every way an archive can answer without answering. */
const GARBAGE: [string, Fault][] = [
  ["a 429 with retry-after", { kind: "rateLimited", retryAfter: "60" }],
  ["a 500", { kind: "text", status: 500, body: "internal error" }],
  ["a 503", { kind: "text", status: 503, body: "unavailable" }],
  [
    "a captive portal's HTML on a 200",
    { kind: "text", status: 200, contentType: "text/html", body: "<html>sign in</html>" },
  ],
  ["an empty 200 body", { kind: "text", status: 200, contentType: "application/json", body: "" }],
  ["a JSON body that is not an object", { kind: "json", body: [1, 2, 3] }],
  ["a JSON null", { kind: "json", body: null }],
  ["a truncated body", { kind: "truncated", body: '{"events":[],"comp' }],
  ["a socket closed mid-body", { kind: "closeMidBody", body: '{"events":[' }],
  ["a connection reset", { kind: "reset" }],
];

describe("an unavailable archive refuses rather than falling back", () => {
  it("refuses a dead port and says why falling back is not on offer", async () => {
    const client = new ArchiveClient(DEAD_ORIGIN_HTTP, { timeoutMs: 2_000 });
    await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(ArchiveUnavailableError);
    const said = await client.events(CONTRACT, ACCOUNT).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).toMatch(/will not fall back/i);
    expect(said).toMatch(/skip older events permanently/i);
    expect(said).not.toBe(GENERIC);
  });

  for (const [name, fault] of GARBAGE) {
    it(`refuses ${name} rather than returning an empty page`, async () => {
      const client = await archive(fault);
      await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(
        ArchiveUnavailableError,
      );
    });

    it(`refuses ${name} on the health check too`, async () => {
      const client = await archive(fault);
      await expect(client.health(CONTRACT)).rejects.toBeInstanceOf(ArchiveUnavailableError);
    });
  }

  it("refuses a server that accepts the connection and never answers", async () => {
    const client = await archive({ kind: "stall" }, 600);
    await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(ArchiveUnavailableError);
    const said = await client.events(CONTRACT, ACCOUNT).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).toMatch(/no answer within/i);
  });

  it("keeps a deadline short enough that a plain read cannot hang the popup", () => {
    // A bound, not a measurement. These are plain GETs against a local service,
    // so a ceiling well under the RPC's is right.
    expect(SERVICE_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SERVICE_HTTP_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });

  it("never puts the archive's own words on screen", async () => {
    const client = await archive({
      kind: "text",
      status: 500,
      body: "SECRET-ARCHIVE-STRING at 127.0.0.1",
    });
    const said = await client.events(CONTRACT, ACCOUNT).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).not.toContain("SECRET-ARCHIVE-STRING");
    expect(said).toContain("HTTP 500");
  });
});

describe("a page is refused unless it vouches for the window that was asked about", () => {
  it("refuses a page with no completeness flag", async () => {
    const client = await archive(page({ complete: undefined }));
    await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });

  it("refuses a page whose completeness flag is a string", async () => {
    const client = await archive(page({ complete: "true" }));
    await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });

  it("refuses a page that admits it is incomplete", async () => {
    const client = await archive(page({ complete: false }));
    await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(IncompleteHistoryError);
    const said = await client.events(CONTRACT, ACCOUNT).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).toMatch(/will not spend from them/i);
    expect(said).not.toBe(GENERIC);
  });

  it("refuses a complete page about a NARROWER window than the one asked about", async () => {
    // `complete: true` about ledgers 900000-900010 is a true statement about a
    // question nobody asked. Reading the flag alone would accept it.
    const client = await archive(page({ from_ledger: 900_000, to_ledger: 900_010 }));
    await expect(
      client.events(CONTRACT, ACCOUNT, { fromLedger: 1, toLedger: 1_000_000 }),
    ).rejects.toBeInstanceOf(IncompleteHistoryError);
  });

  it("refuses a page that starts where asked but stops short of the end", async () => {
    // The two halves of that window check are separate guards and need separate
    // tests: with only the case above, removing the `to_ledger` half changed
    // nothing and the suite stayed green. A page that begins correctly and ends
    // early is the likelier shape in practice, because an archive still
    // catching up truncates at the recent end.
    const client = await archive(page({ from_ledger: 1, to_ledger: 500 }));
    await expect(
      client.events(CONTRACT, ACCOUNT, { fromLedger: 1, toLedger: 900_000 }),
    ).rejects.toBeInstanceOf(IncompleteHistoryError);
  });

  it("refuses a page that ends where asked but starts late", async () => {
    const client = await archive(page({ from_ledger: 800_000, to_ledger: 900_000 }));
    await expect(
      client.events(CONTRACT, ACCOUNT, { fromLedger: 1, toLedger: 900_000 }),
    ).rejects.toBeInstanceOf(IncompleteHistoryError);
  });

  it("refuses a page whose window is not reported at all", async () => {
    const client = await archive(page({ from_ledger: undefined, to_ledger: undefined }));
    await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });

  it("refuses a page whose events field is missing", async () => {
    const client = await archive(page({ events: undefined }));
    await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });

  it("refuses a cursor that is neither a string nor null", async () => {
    const client = await archive(page({ cursor: 7 }));
    await expect(client.events(CONTRACT, ACCOUNT)).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });

  it("accepts a page that covers at least the window it was asked about", async () => {
    const client = await archive(page({ from_ledger: 1, to_ledger: 2_000 }));
    const got = await client.events(CONTRACT, ACCOUNT, { fromLedger: 100, toLedger: 1_500 });
    expect(got.complete).toBe(true);
  });
});

describe("health is refused unless it says what it ingested", () => {
  it("refuses a health report with no contract id", () => {
    expect(() => parseHealth({ latest_ledger: 1, ingested_through: 1, lag_seconds: 0 })).toThrow(
      ArchiveUnavailableError,
    );
  });

  it("refuses a missing ingested_through rather than reading it as zero", () => {
    // An absent ingested_through decides whether the archive can be trusted
    // below the seam. Zero and "did not say" are opposite answers.
    expect(() => parseHealth({ contract_id: CONTRACT, latest_ledger: 1, lag_seconds: 0 })).toThrow(
      ArchiveUnavailableError,
    );
  });

  it("accepts an explicit null, which is the archive saying it has nothing yet", () => {
    const h = parseHealth({
      contract_id: CONTRACT,
      latest_ledger: null,
      ingested_through: null,
      lag_seconds: null,
    });
    expect(h.ingested_through).toBeNull();
    // And an archive that has ingested nothing cannot cover the seam.
    expect(archiveCoversSeam(h, computeSeam(100_000))).toBe(false);
  });

  it("refuses a numeric field that is NaN", () => {
    // JSON cannot carry NaN, but a proxy that rewrites bodies can produce one
    // via a string, and Number.isFinite is what stands between that and a seam
    // computed from nonsense.
    expect(() =>
      parseHealth({
        contract_id: CONTRACT,
        latest_ledger: "1000",
        ingested_through: null,
        lag_seconds: null,
      }),
    ).toThrow(ArchiveUnavailableError);
  });

  it("does not let an archive short of the seam claim to cover it", () => {
    const seam = computeSeam(100_000);
    expect(seam).toBe(101_000);
    expect(
      archiveCoversSeam(
        { contract_id: CONTRACT, latest_ledger: 1, ingested_through: seam - 1, lag_seconds: 0 },
        seam,
      ),
    ).toBe(false);
    expect(
      archiveCoversSeam(
        { contract_id: CONTRACT, latest_ledger: 1, ingested_through: seam, lag_seconds: 0 },
        seam,
      ),
    ).toBe(true);
  });
});

describe("parsePage refuses every partial shape", () => {
  const bad: [string, unknown][] = [
    ["a string", "ok"],
    ["a number", 7],
    ["null", null],
    ["an array", []],
    [
      "events as an object",
      { events: {}, complete: true, from_ledger: 1, to_ledger: 2, cursor: null },
    ],
    [
      "from_ledger as a string",
      { events: [], complete: true, from_ledger: "1", to_ledger: 2, cursor: null },
    ],
  ];
  for (const [name, raw] of bad) {
    it(`refuses ${name}`, () => {
      expect(() => parsePage(raw)).toThrow(ArchiveUnavailableError);
    });
  }
});

describe("recovery: the real indexer, started and stopped by this test", () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const INDEXER = resolve(here, "../../../indexer/src/server.ts");
  let child: ChildProcess | null = null;
  let dir: string | null = null;

  afterAll(() => {
    child?.kill("SIGKILL");
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((ok) => s.listen(0, "127.0.0.1", ok));
    const { port } = s.address() as { port: number };
    await new Promise<void>((ok) => s.close(() => ok()));
    return port;
  }

  it("refuses while the archive is down, then answers once it is up", async () => {
    const port = await freePort();
    const url = `http://127.0.0.1:${port}`;
    const client = new ArchiveClient(url, { timeoutMs: 5_000 });

    // Down: nothing is listening yet.
    await expect(client.health(CONTRACT)).rejects.toBeInstanceOf(ArchiveUnavailableError);

    dir = mkdtempSync(join(tmpdir(), "pocket-archive-"));
    child = spawn(process.execPath, [INDEXER], {
      env: { ...process.env, PORT: String(port), DB_PATH: join(dir, "archive.db") },
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
      new Promise<boolean>((ok) => setTimeout(() => ok(false), 20_000)),
    ]);
    expect(up, `indexer did not start: ${stderr.join("")}`).toBe(true);

    // Up: a real health report from the real service, over a real socket.
    const health = await client.health(CONTRACT);
    expect(health.contract_id).toBe(CONTRACT);
    // An archive that has ingested nothing says so with null rather than zero.
    expect(health.ingested_through).toBeNull();

    // And an empty archive must not serve an empty page as a complete history.
    await expect(client.events(CONTRACT, ACCOUNT, { fromLedger: 1, toLedger: 10 })).rejects.toThrow(
      IncompleteHistoryError,
    );

    // Down again: the refusal returns, on the same client.
    child.kill("SIGKILL");
    child = null;
    await expect(
      (async () => {
        for (let i = 0; i < 40; i++) {
          try {
            await client.health(CONTRACT);
          } catch (e) {
            return e;
          }
          await new Promise((r) => setTimeout(r, 50));
        }
        return null;
      })(),
    ).resolves.toBeInstanceOf(ArchiveUnavailableError);
  }, 40_000);
});
