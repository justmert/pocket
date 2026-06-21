// The user path, end to end through the controller, against a degraded RPC.
//
// Every other spec here checks a client function. This one checks the thing the
// popup actually calls, because that is where an honest refusal turns into a
// number on screen or does not. `balances()` renders 0.0000000 for exactly one
// error class and rethrows the rest; `privatePocket()` picks between four
// sentences, one of which asks the user for a permanent, irreversible
// registration. A degraded dependency must not be able to reach either.
//
// The only thing faked is `chrome.storage.local`, because there is no browser
// here. The vault crypto, the derivation, the HTTP client and the parsing are
// all the real ones, and the RPC is a real socket this test controls.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../../src/lib/polyfill";
import { FaultServer, rpcOk, rpcError, type Fault, type RecordedRequest } from "./_harness/faults";
import { accountKey, accountEntry, entryFor, entriesResult } from "./_harness/ledger";

const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string) => (store.has(k) ? { [k]: store.get(k) } : {}),
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
    },
  },
});

const { WalletController } = await import("../../src/core/controller");
const { NETWORKS } = await import("../../src/core/config");
const { describeError } = await import("../../src/core/dispatch");
const { AccountNotFoundError } = await import("../../src/core/chain/balances");
const { SorobanDataBuilder, xdr } = await import("@stellar/stellar-sdk/base");
const { G, H, IDENTITY, encodePoint } = await import("../../src/core/crypto/grumpkin");

const GENERIC = "Something went wrong. Try again, and check your connection.";
const REAL_RPC = NETWORKS.testnet.rpcUrl;
const SOROBAN_DATA = new SorobanDataBuilder().build().toXDR("base64");
const RECIPIENT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

const open: FaultServer[] = [];

beforeEach(() => {
  store.clear();
});

afterEach(async () => {
  NETWORKS.testnet.rpcUrl = REAL_RPC;
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/**
 * Point the wallet at a dependency this test controls.
 *
 * The wallet is created against a benign answer and the fault is applied
 * afterwards, so the address is known before any request is routed. Creating a
 * wallet touches no network at all, but healing after keeps the two concerns
 * apart.
 */
async function wallet(
  opts: {
    byMethod?: Record<string, Fault | ((r: RecordedRequest) => Fault)>;
    fallback?: Fault | ((r: RecordedRequest) => Fault);
    script?: Fault[];
  } = {},
) {
  const server = await FaultServer.start({ fallback: rpcOk(entriesResult([])) });
  open.push(server);
  NETWORKS.testnet.rpcUrl = server.url;
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("a-strong-password");
  if (opts.byMethod || opts.fallback || opts.script) server.heal(opts);
  return { controller: c, server, address };
}

/** A healthy answer about this wallet's own account entry. */
const fundedAccount = (address: string, stroops = 100_0000000n): Fault =>
  rpcOk(entriesResult([entryFor(accountKey(address), accountEntry(address, stroops))]));

const simError = (message: string): Fault =>
  rpcOk({ latestLedger: 1_000, error: message, events: [] });

const simArchived = (): Fault =>
  rpcOk({
    latestLedger: 1_000,
    minResourceFee: "100",
    transactionData: SOROBAN_DATA,
    events: [],
    results: [],
    restorePreamble: { minResourceFee: "5000", transactionData: SOROBAN_DATA },
  });

/** The garbage every read must survive without inventing an answer. */
const GARBAGE: [string, Fault][] = [
  ["a 429", { kind: "rateLimited", retryAfter: "30" }],
  ["a 500", { kind: "text", status: 500, body: "upstream failure" }],
  [
    "HTML on a 200",
    { kind: "text", status: 200, contentType: "text/html", body: "<html>portal</html>" },
  ],
  ["an empty 200 body", { kind: "text", status: 200, contentType: "application/json", body: "" }],
  ["a JSON-RPC error object", rpcError("SECRET-RPC-STRING")],
  ["result: null", rpcOk(null)],
  ["a result with no entries field", rpcOk({ latestLedger: 9 })],
  ["entries: null", rpcOk({ entries: null, latestLedger: 9 })],
  ["a truncated body", { kind: "truncated", body: '{"jsonrpc":"2.0","id":1,"resu' }],
  ["a connection reset", { kind: "reset" }],
];

describe("balances(): a zero on screen is a claim about the ledger", () => {
  for (const [name, fault] of GARBAGE) {
    it(`refuses ${name} rather than rendering 0.0000000`, async () => {
      const { controller } = await wallet({ fallback: fault });
      const shown = await controller.balances().then(
        (b) => `rendered ${b[0]?.amount}`,
        () => "refused",
      );
      expect(shown).toBe("refused");
    });
  }

  it("refuses a dependency that accepts the connection and never answers", async () => {
    const { controller } = await wallet({ fallback: { kind: "stall" } });
    // The wallet's own 30s deadline governs here. Bounded by the outer race so
    // an unbounded read fails the test rather than hanging the run.
    const shown = await Promise.race([
      controller.balances().then(
        (b) => `rendered ${b[0]?.amount}`,
        () => "refused",
      ),
      new Promise<string>((ok) => setTimeout(() => ok("never settled"), 45_000)),
    ]);
    expect(shown).toBe("refused");
  }, 60_000);

  it("renders zero for the one shape that means the account is not there yet", async () => {
    const { controller } = await wallet({ fallback: rpcOk(entriesResult([])) });
    const b = await controller.balances();
    expect(b[0]).toMatchObject({ id: "native", code: "XLM", amount: "0.0000000" });
  });

  it("renders the real balance, less the reserve, when the RPC is healthy", async () => {
    const { controller, server, address } = await wallet();
    server.heal({ fallback: fundedAccount(address) });
    const b = await controller.balances();
    // 100 XLM held, 2 base reserves of 0.5 locked, so 99 spendable.
    expect(b[0]?.amount).toBe("99.0000000");
    expect(b[0]?.total).toBe("100.0000000");
    expect(b[0]?.reserved).toBe("1.0000000");
  });

  it("recovers on the next call once the RPC comes back", async () => {
    const { controller, server, address } = await wallet({ fallback: { kind: "rateLimited" } });
    await expect(controller.balances()).rejects.toThrow();
    server.heal({ fallback: fundedAccount(address, 50_0000000n) });
    expect((await controller.balances())[0]?.amount).toBe("49.0000000");
  });

  it("says nothing the RPC authored when it refuses", async () => {
    const { controller } = await wallet({ fallback: rpcError("SECRET-RPC-STRING") });
    const said = await controller.balances().then(
      () => "resolved",
      (e) => describeError(e),
    );
    expect(said).not.toContain("SECRET-RPC-STRING");
    expect(said).not.toContain("127.0.0.1");
    expect([GENERIC, "Something went wrong."]).toContain(said);
  });

  it("distinguishes a genuinely absent account from an unanswered read", async () => {
    // The typed AccountNotFoundError is what earns the zero, and nothing else
    // may produce it. Same wallet, same client, two answers.
    const { controller, server } = await wallet({ fallback: rpcOk(entriesResult([])) });
    expect((await controller.balances())[0]?.amount).toBe("0.0000000");

    server.heal({ fallback: rpcOk({ latestLedger: 9 }) });
    const err = await controller.balances().then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).not.toBeInstanceOf(AccountNotFoundError);
    expect(err).toBeInstanceOf(Error);
  });
});

describe("privatePocket(): four sentences, one of them irreversible", () => {
  /**
   * Route by which ledger key is being asked about.
   *
   * `readNative` and `getAccount` both read the ACCOUNT entry; the TTL read asks
   * about the token's contract data. Routing on the key is what lets one leg be
   * degraded while its neighbours answer, which is how a partially degraded RPC
   * actually behaves.
   */
  const routeByKey = (address: string, healthy: Fault, contractData: Fault) => {
    const wanted = accountKey(address).toXDR("base64");
    return (req: RecordedRequest): Fault => (req.body.includes(wanted) ? healthy : contractData);
  };

  it("reports unfunded only when the account entry is genuinely absent", async () => {
    const { controller } = await wallet({ fallback: rpcOk(entriesResult([])) });
    const p = await controller.privatePocket();
    expect(p.state).toBe("unfunded");
  });

  for (const [name, fault] of GARBAGE) {
    it(`does not report unfunded from ${name}`, async () => {
      const { controller } = await wallet({ fallback: fault });
      const state = await controller.privatePocket().then(
        (p) => p.state,
        () => "refused",
      );
      expect(state).not.toBe("unfunded");
      expect(state).toBe("refused");
    });
  }

  for (const [name, fault] of GARBAGE) {
    it(`does not offer the permanent registration after ${name} on the simulated read`, async () => {
      // The account exists, so the read gets that far. The confidential read is
      // the degraded leg. "unregistered" here would put a permanent,
      // auditor-binding action in front of a user whose pocket may already
      // exist, on the strength of a response nobody could parse.
      const { controller, server, address } = await wallet();
      server.heal({
        byMethod: { getLedgerEntries: fundedAccount(address), simulateTransaction: fault },
        fallback: fault,
      });
      const state = await controller.privatePocket().then(
        (p) => p.state,
        () => "refused",
      );
      expect(state).not.toBe("unregistered");
    });
  }

  it("does not offer the permanent registration when the TTL read is degraded", async () => {
    // The shape that matters most. The confidential entry is ARCHIVED, which
    // simulates with a restore preamble, so the account is genuinely dormant.
    // The TTL read is the only thing that can tell dormant from never-registered
    // and it is the leg that is broken. "unregistered" is then a claim about the
    // ledger that was never read from the ledger, and its remedy is permanent.
    const { controller, server, address } = await wallet();
    server.heal({
      byMethod: {
        getLedgerEntries: routeByKey(
          address,
          fundedAccount(address),
          // The degraded leg: a well-formed envelope carrying no entries field.
          rpcOk({ latestLedger: 9 }),
        ),
        simulateTransaction: simArchived(),
      },
    });

    const outcome = await controller.privatePocket().then(
      (p) => p.state,
      () => "refused",
    );
    expect(["archived", "refused"]).toContain(outcome);
    expect(outcome).not.toBe("unregistered");
  });

  it("reports archived when the TTL read says so", async () => {
    const { controller, server, address } = await wallet();
    server.heal({
      byMethod: {
        getLedgerEntries: routeByKey(
          address,
          fundedAccount(address),
          rpcOk(
            entriesResult(
              [
                entryFor(accountKey(address), accountEntry(address, 1n), {
                  liveUntilLedgerSeq: 500,
                }),
              ],
              1_000,
            ),
          ),
        ),
        simulateTransaction: simError("HostError: Error(Contract, #3501)"),
      },
    });

    const p = await controller.privatePocket();
    expect(p.state).toBe("archived");
    expect(p.message).toMatch(/dormant/i);
  });

  it("never puts the RPC's own words on the private pocket screen", async () => {
    const { controller, server, address } = await wallet();
    server.heal({
      byMethod: {
        getLedgerEntries: fundedAccount(address),
        simulateTransaction: simError("SECRET-RPC-STRING at 127.0.0.1"),
      },
    });
    const said = await controller.privatePocket().then(
      (p) => p.message ?? "",
      (e) => describeError(e),
    );
    expect(said).not.toContain("SECRET-RPC-STRING");
    expect(said).not.toContain("127.0.0.1");
  });
});

describe("the inbound-credit path must not route around the error allowlist", () => {
  // `creditInboundTransfers` catches everything and puts `e.message` into
  // `lastInboundFailure`, which `privatePocket()` interpolates RAW into the
  // diverged screen's message. Its comment says "The message is authored by us,
  // so it is safe to surface", and that is true of the two errors it was written
  // for. The catch is not that narrow: it also catches transport errors, decode
  // errors and TypeErrors, none of which we authored.
  //
  // `describeError`'s allowlist exists precisely so an RPC-authored string
  // cannot reach a user. This path does not go through it.

  /** A stored opening for this wallet, sealed the way the controller seals it. */
  async function storeOpenings(address: string, token: string) {
    const { getSession } = await import("../../src/core/session");
    const { sealPayload } = await import("../../src/core/vault/vault");
    const { openingKey } = await import("../../src/lib/storage");
    const session = getSession();
    if (!session) throw new Error("the wallet under test is locked");
    store.set(
      openingKey(token, address),
      await sealPayload(session.dek, {
        spendable: { value: "0", randomness: "0" },
        receiving: { value: "0", randomness: "0" },
        syncedThrough: 0,
      }),
    );
  }

  /** A confidential account whose receiving side does NOT match the stored zero. */
  function divergedAccount(): Fault {
    const bytes = (p: { x: bigint; y: bigint }) =>
      xdr.ScVal.scvBytes(Buffer.from(encodePoint(p)));
    const entry = (name: string, val: xdr.ScVal) =>
      new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
    return rpcOk({
      latestLedger: 1_000,
      minResourceFee: "100",
      transactionData: SOROBAN_DATA,
      events: [],
      results: [
        {
          auth: [],
          xdr: xdr.ScVal
            .scvMap([
              entry("auditor_id", xdr.ScVal.scvU32(1)),
              // Non-identity, so it cannot open to the stored zero and the
              // pocket is genuinely diverged.
              entry("receiving_commitment", bytes(H)),
              entry("spendable_commitment", bytes(IDENTITY)),
              entry("spending_public_key", bytes(G)),
              entry("viewing_public_key", bytes(H)),
            ])
            .toXDR("base64"),
        },
      ],
    });
  }

  it("does not put the RPC's own words on the diverged screen", async () => {
    const { controller, server, address } = await wallet();
    const token = NETWORKS.testnet.confidential[0]!.token;
    await storeOpenings(address, token);

    server.heal({
      byMethod: {
        getLedgerEntries: fundedAccount(address),
        simulateTransaction: divergedAccount(),
        getHealth: rpcOk({ status: "healthy", latestLedger: 1_000, oldestLedger: 1 }),
        // The inbound search is the degraded leg, and its error is authored by
        // the HTTP client, not by us.
        getEvents: rpcError("SECRET-RPC-STRING"),
      },
    });

    const p = await controller.privatePocket();
    expect(p.state).toBe("diverged");
    expect(p.message ?? "").not.toContain("SECRET-RPC-STRING");
  });

  it("does not put a transport failure's wording on the diverged screen", async () => {
    const { controller, server, address } = await wallet();
    const token = NETWORKS.testnet.confidential[0]!.token;
    await storeOpenings(address, token);

    server.heal({
      byMethod: {
        getLedgerEntries: fundedAccount(address),
        simulateTransaction: divergedAccount(),
        getHealth: rpcOk({ status: "healthy", latestLedger: 1_000, oldestLedger: 1 }),
        getEvents: { kind: "rateLimited", retryAfter: "60" },
      },
    });

    const p = await controller.privatePocket();
    expect(p.state).toBe("diverged");
    const said = p.message ?? "";
    // Nothing from the HTTP client, and nothing naming the endpoint.
    expect(said).not.toMatch(/status code|AxiosError|ECONNREFUSED/i);
    expect(said).not.toContain("127.0.0.1");
  });
});

describe("buildPayment(): refuses to build against a ledger it could not read", () => {
  for (const [name, fault] of GARBAGE) {
    it(`refuses to build after ${name}`, async () => {
      const { controller } = await wallet({ fallback: fault });
      await expect(
        controller.buildPayment({ to: RECIPIENT, amount: "1", assetId: "native" }),
      ).rejects.toThrow();
    });
  }

  it("refuses to build a second payment while one is unresolved", async () => {
    // The unfinished-transaction screen only appears on popup mount, so a popup
    // left open after a timeout would otherwise walk straight into composing a
    // second payment against a sequence number the first may still consume.
    const { controller, server, address } = await wallet();
    server.heal({ fallback: fundedAccount(address) });
    store.set("pocket.inflight", {
      hash: "c23d994e",
      maxTime: Math.floor(Date.now() / 1000) + 600,
    });
    const said = await controller
      .buildPayment({ to: RECIPIENT, amount: "1", assetId: "native" })
      .then(
        () => "built a second payment",
        (e) => describeError(e),
      );
    expect(said).toMatch(/has not resolved yet/i);
    expect(said).not.toBe(GENERIC);
  });

  it("builds again once the unresolved envelope can never apply", async () => {
    // Past its maxTime the first envelope is decidably dead, so a rebuild is
    // safe. Refusing forever would strand the wallet on a transaction that can
    // never land.
    const { controller, server, address } = await wallet();
    server.heal({ fallback: fundedAccount(address) });
    store.set("pocket.inflight", {
      hash: "c23d994e",
      maxTime: Math.floor(Date.now() / 1000) - 60,
    });
    const built = await controller.buildPayment({
      to: RECIPIENT,
      amount: "1",
      assetId: "native",
    });
    expect(built.summary.amount).toBe("1.0000000");
  });
});
