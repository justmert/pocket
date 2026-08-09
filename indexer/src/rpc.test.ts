import { afterEach, describe, expect, it } from "vitest";
import {
  ResilientRpc,
  RpcTimeoutError,
  isTransient,
  resolveRpcUrls,
  type RpcLike,
} from "./rpc.ts";

// A getEvents/getHealth-shaped stub. The real surface is large; only these two
// are used, so the wrapper is exercised through them.
function stub(opts: {
  health?: () => Promise<unknown>;
  events?: (req: unknown) => Promise<unknown>;
}): RpcLike {
  return {
    getHealth: opts.health ?? (async () => ({ status: "healthy" })),
    getEvents: opts.events ?? (async () => ({ events: [], latestLedger: 1 })),
  } as unknown as RpcLike;
}

const transient = (status: number) => ({ response: { status } });
const logicError = () => new Error("startLedger must be within the ledger range");

describe("isTransient", () => {
  it("treats rate limits, server faults, dropped sockets and timeouts as transient", () => {
    expect(isTransient(transient(429))).toBe(true);
    expect(isTransient(transient(500))).toBe(true);
    expect(isTransient(transient(503))).toBe(true);
    expect(isTransient({ status: 502 })).toBe(true);
    expect(isTransient({ code: "ECONNRESET" })).toBe(true);
    expect(isTransient({ name: "AbortError" })).toBe(true);
    expect(isTransient(new RpcTimeoutError("x"))).toBe(true);
    expect(isTransient(new Error("fetch failed"))).toBe(true);
    expect(isTransient(new Error("Too Many Requests"))).toBe(true);
  });

  it("does NOT treat logic or client errors as transient", () => {
    // The load-bearing one: the retention-floor error must propagate so backfill
    // re-clamps instead of the wrapper masking it with a failover.
    expect(isTransient(logicError())).toBe(false);
    expect(isTransient(transient(400))).toBe(false);
    expect(isTransient(transient(404))).toBe(false);
    expect(isTransient(new Error("something specific and non-networky"))).toBe(false);
  });
});

describe("resolveRpcUrls", () => {
  const saved = { urls: process.env.RPC_URLS, url: process.env.RPC_URL };
  afterEach(() => {
    if (saved.urls === undefined) delete process.env.RPC_URLS;
    else process.env.RPC_URLS = saved.urls;
    if (saved.url === undefined) delete process.env.RPC_URL;
    else process.env.RPC_URL = saved.url;
  });

  it("parses RPC_URLS as a trimmed, non-empty comma list and prefers it", () => {
    process.env.RPC_URLS = "https://a.example, https://b.example ,,";
    process.env.RPC_URL = "https://ignored.example";
    expect(resolveRpcUrls()).toEqual(["https://a.example", "https://b.example"]);
  });

  it("honours a lone RPC_URL as a single endpoint", () => {
    delete process.env.RPC_URLS;
    process.env.RPC_URL = "https://only.example";
    expect(resolveRpcUrls()).toEqual(["https://only.example"]);
  });

  it("falls back to two verified public endpoints when nothing is set", () => {
    delete process.env.RPC_URLS;
    delete process.env.RPC_URL;
    const urls = resolveRpcUrls();
    expect(urls.length).toBe(2);
    expect(urls[0]).toContain("soroban-testnet.stellar.org");
    expect(urls[1]).toContain("ankr.com");
  });
});

describe("ResilientRpc", () => {
  it("fails over to the next endpoint on a transient error", async () => {
    const r = new ResilientRpc(
      [
        stub({ health: async () => Promise.reject(transient(503)) }),
        stub({ health: async () => ({ status: "healthy", latestLedger: 42 }) }),
      ],
      ["primary", "fallback"],
    );
    await expect(r.getHealth()).resolves.toMatchObject({ latestLedger: 42 });
  });

  it("propagates a logic error WITHOUT trying the next endpoint", async () => {
    let secondCalled = false;
    const r = new ResilientRpc(
      [
        stub({ health: async () => Promise.reject(logicError()) }),
        stub({
          health: async () => {
            secondCalled = true;
            return { status: "healthy" };
          },
        }),
      ],
      ["primary", "fallback"],
    );
    await expect(r.getHealth()).rejects.toThrow(/within the ledger range/);
    expect(secondCalled).toBe(false);
  });

  it("sticks to the last endpoint that worked", async () => {
    let c0 = 0;
    let c1 = 0;
    const r = new ResilientRpc(
      [
        stub({
          health: async () => {
            c0++;
            return Promise.reject(transient(429));
          },
        }),
        stub({
          health: async () => {
            c1++;
            return { status: "healthy" };
          },
        }),
      ],
      ["primary", "fallback"],
    );
    await r.getHealth();
    await r.getHealth();
    // Primary tried once (first call), then the working fallback is reused.
    expect(c0).toBe(1);
    expect(c1).toBe(2);
  });

  it("rejects with the last error when every endpoint is down", async () => {
    const r = new ResilientRpc(
      [
        stub({ health: async () => Promise.reject(transient(500)) }),
        stub({ health: async () => Promise.reject(transient(502)) }),
      ],
      ["a", "b"],
    );
    await expect(r.getHealth()).rejects.toBeTruthy();
  });

  it("times out a stalled endpoint and fails over", async () => {
    const r = new ResilientRpc(
      [
        stub({ health: () => new Promise(() => {}) }), // never resolves
        stub({ health: async () => ({ status: "healthy", latestLedger: 7 }) }),
      ],
      ["stalled", "fallback"],
      50, // 50ms deadline
    );
    await expect(r.getHealth()).resolves.toMatchObject({ latestLedger: 7 });
  });

  it("passes the getEvents request through unchanged", async () => {
    let seen: unknown;
    const r = new ResilientRpc(
      [
        stub({
          events: async (req) => {
            seen = req;
            return { events: [], latestLedger: 1 };
          },
        }),
      ],
      ["only"],
    );
    const req = { startLedger: 5, filters: [], limit: 200 };
    await r.getEvents(req as never);
    expect(seen).toEqual(req);
  });

  it("throws if constructed with no endpoints", () => {
    expect(() => new ResilientRpc([], [])).toThrow();
    expect(() => ResilientRpc.fromUrls([])).toThrow();
  });
});
