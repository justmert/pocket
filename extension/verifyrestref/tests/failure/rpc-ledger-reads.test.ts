// Soroban RPC: down, slow, rate-limited, and returning garbage, on every read
// that can turn into a number on screen.
//
// The property under test is one sentence: a balance is only ever rendered from
// an answer the client verified, and "this account is absent" is only ever
// concluded from the one response shape that means absent. Everything else must
// raise, because in a wallet a confident wrong number is the worst possible bug.
// An error on screen costs a reload. A fabricated balance is acted on.
//
// The calibration case is real: an RPC reply carrying no `entries` field at all
// rendered 0.0000000 on a funded wallet, because stellar-sdk parses
// `(raw.entries ?? [])` and so cannot tell "field missing" from "array empty".
import { describe, it, expect, afterEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { Asset } from "@stellar/stellar-sdk/base";
import "../../src/lib/polyfill";
import {
  readNative,
  readTrustline,
  AccountNotFoundError,
  formatAmount,
} from "../../src/core/chain/balances";
import { readAccountTtl, readInstanceTtl } from "../../src/core/chain/ttl";
import { planKeepAlive } from "../../src/core/chain/keepalive";
import { withRequestDeadline } from "../../src/core/chain/http";
import { describeError } from "../../src/core/dispatch";
import { FaultServer, DEAD_ORIGIN, rpcOk, rpcError, type Fault } from "./_harness/faults";
import {
  accountKey,
  accountEntry,
  trustlineKey,
  trustlineEntry,
  entryFor,
  entriesResult,
  fundedAccountResult,
} from "./_harness/ledger";

const ACCOUNT = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const STRANGER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
const USDC = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");

/** What describeError falls back to. Nothing from the wire may be more specific. */
const GENERIC = "Something went wrong. Try again, and check your connection.";

const open: FaultServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

async function serving(fault: Fault | Record<string, Fault>): Promise<rpc.Server> {
  const server = await FaultServer.start(
    typeof fault === "object" && "kind" in fault
      ? { fallback: fault as Fault }
      : { byMethod: fault as Record<string, Fault> },
  );
  open.push(server);
  return withRequestDeadline(new rpc.Server(server.url), 4_000);
}

/**
 * Every way a dependency can answer badly without refusing the connection.
 *
 * Deliberately includes the two that look benign: a 200 whose body is HTML (a
 * captive portal or a proxy) and a well-formed JSON-RPC envelope with no
 * `entries` field. Both parse far enough to reach code that assumes an answer.
 */
const GARBAGE: [string, Fault][] = [
  ["a 429 with retry-after", { kind: "rateLimited", retryAfter: "30" }],
  ["a 500", { kind: "text", status: 500, body: "upstream failure" }],
  [
    "a 502 HTML error page",
    { kind: "text", status: 502, contentType: "text/html", body: "<html>bad gateway</html>" },
  ],
  [
    "HTML on a 200",
    {
      kind: "text",
      status: 200,
      contentType: "text/html",
      body: "<html><body>SECRET-RPC-STRING</body></html>",
    },
  ],
  ["an empty 200 body", { kind: "text", status: 200, contentType: "application/json", body: "" }],
  ["a JSON-RPC error object", rpcError("SECRET-RPC-STRING")],
  ["result: null", rpcOk(null)],
  ["a result that is a bare string", rpcOk("SECRET-RPC-STRING")],
  ["a result with no entries field at all", rpcOk({ latestLedger: 9 })],
  ["entries: null", rpcOk({ entries: null, latestLedger: 9 })],
  ["entries as an object rather than a list", rpcOk({ entries: {}, latestLedger: 9 })],
  ["a truncated body", { kind: "truncated", body: '{"jsonrpc":"2.0","id":1,"resu' }],
  ["a socket closed mid-body", { kind: "closeMidBody", body: '{"jsonrpc":"2.0","id":1,' }],
  ["a connection reset", { kind: "reset" }],
];

describe("readNative: a degraded RPC never yields a balance", () => {
  for (const [name, fault] of GARBAGE) {
    it(`refuses ${name} rather than reporting the account absent`, async () => {
      const server = await serving(fault);
      await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
    });
  }

  it("refuses a dead port", async () => {
    const server = withRequestDeadline(new rpc.Server(DEAD_ORIGIN), 4_000);
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });

  it("refuses a server that accepts the connection and never answers", async () => {
    const server = await serving({ kind: "stall" });
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });

  it("treats an explicit empty entries array as the ONE shape meaning absent", async () => {
    // The RPC's canonical "no such ledger entry", and the only path allowed to
    // reach the zero rendering. Verified against live testnet: a genuinely
    // absent account replies with an explicit `entries: []`.
    const server = await serving(rpcOk(entriesResult([])));
    await expect(readNative(server, ACCOUNT)).rejects.toBeInstanceOf(AccountNotFoundError);
  });

  it("refuses an entry keyed for a different account", async () => {
    // A byte-identical key echo is the identity check. An RPC that answers
    // about somebody else must not have its balance rendered as ours.
    const server = await serving(
      rpcOk(
        entriesResult([entryFor(accountKey(STRANGER), accountEntry(STRANGER, 123_456_789_000n))]),
      ),
    );
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
    await expect(readNative(server, ACCOUNT)).rejects.toThrow(/different entry|answered about/i);
  });

  it("refuses the right key echoed beside a stranger's account body", async () => {
    // The nastier version: the echo is correct, the body is not. Without the
    // second check this returned a stranger's balance without complaint.
    const server = await serving(
      rpcOk(
        entriesResult([entryFor(accountKey(ACCOUNT), accountEntry(STRANGER, 123_456_789_000n))]),
      ),
    );
    await expect(readNative(server, ACCOUNT)).rejects.toThrow(/answered about/i);
  });

  it("refuses a trustline entry served in answer to an account question", async () => {
    const server = await serving(
      rpcOk(
        entriesResult([entryFor(accountKey(ACCOUNT), trustlineEntry(ACCOUNT, USDC, 500_000_000n))]),
      ),
    );
    await expect(readNative(server, ACCOUNT)).rejects.toThrow(/asked for an account entry/i);
  });

  it("refuses an entry whose xdr field is not a string", async () => {
    const server = await serving(
      rpcOk({
        entries: [{ key: accountKey(ACCOUNT).toXDR("base64"), xdr: 42, lastModifiedLedgerSeq: 1 }],
        latestLedger: 9,
      }),
    );
    await expect(readNative(server, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
  });
});

describe("readNative: recovery once the RPC comes back", () => {
  it("returns the real balance after a run of failures on the same client", async () => {
    // One client, one connection pool, one server that starts broken and heals.
    // A wallet that degrades honestly but never recovers is still broken.
    const server = await FaultServer.start({
      script: [{ kind: "rateLimited" }, { kind: "reset" }, rpcOk({ latestLedger: 9 })],
      fallback: rpcOk(fundedAccountResult(ACCOUNT, 99_000_000_000n, { subEntries: 1 })),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    for (let i = 0; i < 3; i++) {
      await expect(readNative(client, ACCOUNT)).rejects.not.toBeInstanceOf(AccountNotFoundError);
    }
    const healed = await readNative(client, ACCOUNT);
    expect(formatAmount(healed.raw)).toBe("9900.0000000");
    expect(healed.subEntryCount).toBe(1);
  });

  it("recovers after a stall that hit the request deadline", async () => {
    const server = await FaultServer.start({
      script: [{ kind: "stall" }],
      fallback: rpcOk(fundedAccountResult(ACCOUNT, 1_0000000n)),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 700);

    await expect(readNative(client, ACCOUNT)).rejects.toThrow();
    expect(formatAmount((await readNative(client, ACCOUNT)).raw)).toBe("1.0000000");
  });
});

describe("readTrustline: the same rule for credit assets", () => {
  for (const [name, fault] of GARBAGE) {
    it(`refuses ${name} rather than reporting no trustline`, async () => {
      const server = await serving(fault);
      await expect(readTrustline(server, ACCOUNT, USDC)).rejects.toThrow();
    });
  }

  it("returns null only for an explicit empty entries array", async () => {
    const server = await serving(rpcOk(entriesResult([])));
    await expect(readTrustline(server, ACCOUNT, USDC)).resolves.toBeNull();
  });

  it("refuses a trustline for a different asset than the one asked about", async () => {
    const other = new Asset("EURC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    const server = await serving(
      rpcOk(
        entriesResult([
          entryFor(trustlineKey(ACCOUNT, USDC), trustlineEntry(ACCOUNT, other, 500_000_000n)),
        ]),
      ),
    );
    await expect(readTrustline(server, ACCOUNT, USDC)).rejects.toThrow(/another asset/i);
  });

  it("refuses a trustline held by a different account", async () => {
    const server = await serving(
      rpcOk(
        entriesResult([
          entryFor(trustlineKey(ACCOUNT, USDC), trustlineEntry(STRANGER, USDC, 500_000_000n)),
        ]),
      ),
    );
    await expect(readTrustline(server, ACCOUNT, USDC)).rejects.toThrow(/answered about/i);
  });

  it("reads the real balance once the RPC recovers", async () => {
    const server = await FaultServer.start({
      script: [{ kind: "rateLimited" }],
      fallback: rpcOk(
        entriesResult([
          entryFor(trustlineKey(ACCOUNT, USDC), trustlineEntry(ACCOUNT, USDC, 250_000_000n)),
        ]),
      ),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);
    await expect(readTrustline(client, ACCOUNT, USDC)).rejects.toThrow();
    const tl = await readTrustline(client, ACCOUNT, USDC);
    expect(formatAmount(tl!.raw)).toBe("25.0000000");
    expect(tl!.authorized).toBe(true);
  });
});

describe("a degraded RPC never puts its own words on screen", () => {
  // The allowlist in describeError is a NAME allowlist with no shape heuristic,
  // so nothing an RPC authored can reach a user. Pinned end to end here rather
  // than by reading the list.
  const talkative: [string, Fault][] = [
    ["a JSON-RPC error message", rpcError("SECRET-RPC-STRING")],
    [
      "an HTML body on a 200",
      { kind: "text", status: 200, contentType: "text/html", body: "<p>SECRET-RPC-STRING</p>" },
    ],
    ["a 429 body", { kind: "rateLimited" }],
    ["a result that is a bare string", rpcOk("SECRET-RPC-STRING")],
  ];

  for (const [name, fault] of talkative) {
    it(`reduces ${name} to a message we authored`, async () => {
      const server = await serving(fault);
      const said = await readNative(server, ACCOUNT).then(
        () => "resolved, which is itself a failure",
        (e) => describeError(e),
      );
      expect([GENERIC, "Something went wrong."]).toContain(said);
      expect(said).not.toContain("SECRET-RPC-STRING");
    });
  }

  it("does not leak the host or port of the endpoint it could not reach", async () => {
    const server = withRequestDeadline(new rpc.Server(DEAD_ORIGIN), 4_000);
    const said = await readNative(server, ACCOUNT).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).toBe(GENERIC);
    expect(said).not.toContain("127.0.0.1");
  });

  it("does not leak the endpoint when the deadline fires", async () => {
    const server = await serving({ kind: "stall" });
    const said = await readNative(server, ACCOUNT).then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).not.toContain("127.0.0.1");
    expect([GENERIC, "Something went wrong."]).toContain(said);
  });
});

describe("readAccountTtl: a dormant pocket must not read as a fresh one", () => {
  // The state this decides is which sentence the private-pocket screen shows.
  // "dormant, reactivate it" and "set one up, it binds an auditor permanently"
  // are opposite instructions, and the second one is not reversible.

  it("reports archived when the entry's liveUntil has passed", async () => {
    const server = await serving(
      rpcOk(
        entriesResult(
          [
            entryFor(accountKey(ACCOUNT), accountEntry(ACCOUNT, 1n), {
              liveUntilLedgerSeq: 500,
            }),
          ],
          1_000,
        ),
      ),
    );
    await expect(readAccountTtl(server, TOKEN, ACCOUNT, "testnet")).resolves.toEqual({
      kind: "archived",
    });
  });

  it("refuses a dead port rather than reporting the entry absent", async () => {
    const server = withRequestDeadline(new rpc.Server(DEAD_ORIGIN), 4_000);
    await expect(readAccountTtl(server, TOKEN, ACCOUNT, "testnet")).rejects.toThrow();
  });

  for (const [name, fault] of GARBAGE) {
    it(`does not conclude "absent" from ${name}`, async () => {
      const server = await serving(fault);
      const said = await readAccountTtl(server, TOKEN, ACCOUNT, "testnet").then(
        (v) => v.kind,
        () => "raised",
      );
      expect(said).not.toBe("absent");
    });
  }

  it("recovers and reports a healthy expiry once the RPC returns", async () => {
    const server = await FaultServer.start({
      script: [{ kind: "reset" }],
      fallback: rpcOk(
        entriesResult(
          [
            entryFor(accountKey(ACCOUNT), accountEntry(ACCOUNT, 1n), {
              // Roughly 30 days at the measured testnet close time.
              liveUntilLedgerSeq: 1_000 + 520_000,
            }),
          ],
          1_000,
        ),
      ),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);
    await expect(readAccountTtl(client, TOKEN, ACCOUNT, "testnet")).rejects.toThrow();
    const ttl = await readAccountTtl(client, TOKEN, ACCOUNT, "testnet");
    expect(ttl.kind).toBe("healthy");
  });
});

describe("readInstanceTtl: one archived verifier breaks the whole deployment", () => {
  for (const [name, fault] of GARBAGE) {
    it(`does not conclude "absent" from ${name}`, async () => {
      const server = await serving(fault);
      const said = await readInstanceTtl(server, TOKEN, "testnet").then(
        (v) => v.kind,
        () => "raised",
      );
      expect(said).not.toBe("absent");
    });
  }
});

describe("the keep-alive scheduler must not stand down on an unread TTL", () => {
  // What a wrong "absent" costs, stated as the consequence rather than the
  // internal state. `absent` means "this account was never registered", and the
  // planner answers by sleeping for a week. On testnet the archival floor is
  // about seven days, so a single unread TTL at the wrong moment is the entry
  // archiving on a schedule nobody watched.
  for (const [name, fault] of GARBAGE) {
    it(`does not schedule a week of silence after ${name}`, async () => {
      const server = await serving(fault);
      const decision = await readAccountTtl(server, TOKEN, ACCOUNT, "testnet").then(
        (ttl) => {
          const plan = planKeepAlive(ttl, false);
          return ttl.kind === "absent" && !plan.due
            ? "stood down for a week on an unread TTL"
            : "acted on a TTL it read";
        },
        () => "refused, which the caller retries",
      );
      expect(decision).not.toBe("stood down for a week on an unread TTL");
    });
  }

  it("does bump when the entry it really read is inside the window", async () => {
    // The healthy half: a TTL that was genuinely read and is genuinely short
    // must produce a bump, or the whole mechanism is decoration.
    const server = await serving(
      rpcOk(
        entriesResult(
          [
            entryFor(accountKey(ACCOUNT), accountEntry(ACCOUNT, 1n), {
              // Under the 7-day threshold at the measured testnet close time.
              liveUntilLedgerSeq: 1_000 + 50_000,
            }),
          ],
          1_000,
        ),
      ),
    );
    const ttl = await readAccountTtl(server, TOKEN, ACCOUNT, "testnet");
    expect(ttl.kind).toBe("expiring");
    expect(planKeepAlive(ttl, false).due).toBe(true);
  });
});
