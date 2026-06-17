import { describe, it, expect, vi } from "vitest";
import { DefindexClient, DefindexError, describeApy, moveBody } from "./defindex";

const cfg = { baseUrl: "https://api.defindex.io", apiKey: "sk_test", network: "testnet" as const };

const mockFetch = (handler: (url: string, init?: RequestInit) => unknown) =>
  vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  })) as unknown as typeof fetch;

describe("the endpoint shape our own specification got wrong", () => {
  it("submits to ROOT /send, not /vault/{address}/send", async () => {
    let seen = "";
    vi.stubGlobal(
      "fetch",
      mockFetch((url) => ((seen = url), {})),
    );
    await new DefindexClient(cfg).send("AAAA");
    expect(seen).toContain("/send?");
    expect(seen).not.toContain("/vault/");
  });

  it("sends only `xdr`, because there is no launchtube option", async () => {
    let body: unknown;
    vi.stubGlobal(
      "fetch",
      mockFetch((_u, init) => ((body = JSON.parse(String(init?.body))), {})),
    );
    await new DefindexClient(cfg).send("AAAA");
    expect(body).toEqual({ xdr: "AAAA" });
    expect(body).not.toHaveProperty("launchtube");
  });

  it("puts ?network= on EVERY request, since calls omitting it fail", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      mockFetch((u) => (urls.push(u), {})),
    );
    const c = new DefindexClient(cfg);
    await c.vault("CVAULT");
    await c.position("CVAULT", "GUSER");
    await c.buildDeposit("CVAULT", { caller: "GUSER", amounts: [100n] });
    await c.send("AAAA");
    expect(urls).toHaveLength(4);
    for (const u of urls) expect(u).toContain("network=testnet");
  });

  it("appends ?network= correctly when the path already has a query", async () => {
    let seen = "";
    vi.stubGlobal(
      "fetch",
      mockFetch((u) => ((seen = u), {})),
    );
    await new DefindexClient(cfg).position("CVAULT", "GUSER");
    expect(seen).toContain("from=GUSER");
    expect(seen).toContain("&network=testnet");
  });

  it("accepts slippageBps on deposit, not only on withdraw", async () => {
    let body: unknown;
    vi.stubGlobal(
      "fetch",
      mockFetch((_u, init) => ((body = JSON.parse(String(init?.body))), {})),
    );
    await new DefindexClient(cfg).buildDeposit("CVAULT", {
      caller: "GUSER",
      amounts: [100n],
      slippageBps: 50,
    });
    expect(body).toMatchObject({ slippageBps: 50 });
  });

  it("authenticates with a bearer token", async () => {
    let headers: Record<string, string> = {};
    vi.stubGlobal(
      "fetch",
      mockFetch((_u, init) => ((headers = init?.headers as Record<string, string>), {})),
    );
    await new DefindexClient(cfg).vault("CVAULT");
    expect(headers.authorization).toBe("Bearer sk_test");
  });
});

describe("failure handling", () => {
  it("reports an unreachable service as a typed error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    await expect(new DefindexClient(cfg).vault("C")).rejects.toBeInstanceOf(DefindexError);
  });

  it("surfaces a non-2xx rather than parsing garbage", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
    await expect(new DefindexClient(cfg).vault("C")).rejects.toThrow(/502/);
  });

  it("reports a body that is not JSON as this module's own error", async () => {
    // A proxy error page arrives with a 200. Left unwrapped it escaped as a
    // bare SyntaxError, which a caller cannot tell from a bug in our own code.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token '<'");
        },
      })) as unknown as typeof fetch,
    );
    await expect(new DefindexClient(cfg).vault("C")).rejects.toBeInstanceOf(DefindexError);
  });

  it("bounds the wait rather than hanging on a service that never answers", async () => {
    // Real socket, real stall: the yield service accepts the connection and
    // says nothing. Without a deadline this promise never settled.
    const { createServer } = await import("node:http");
    const s = createServer(() => {});
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as { port: number }).port;
    vi.unstubAllGlobals();
    try {
      await expect(
        new DefindexClient({
          ...cfg,
          baseUrl: `http://127.0.0.1:${port}`,
          timeoutMs: 300,
        }).vault("C"),
      ).rejects.toThrow(/no answer within/i);
    } finally {
      s.close();
    }
  }, 10_000);
});

describe("the user parameter is named differently on the POSTs and the GET", () => {
  // Verified against https://api.defindex.io/api-json on 2026-07-31.
  // DepositDto and WithdrawDto both declare required: ["amounts","caller"] and
  // have NO `from` property. GET /vault/{address}/balance requires `from` as a
  // query parameter. Sending `from` in a body omits a required field and 400s,
  // so every deposit and withdraw would have failed.
  const bodyOf = async (fn: (c: DefindexClient) => Promise<unknown>) => {
    let body: unknown;
    vi.stubGlobal(
      "fetch",
      mockFetch((_u, init) => ((body = JSON.parse(String(init?.body))), {})),
    );
    await fn(new DefindexClient(cfg));
    return body as Record<string, unknown>;
  };

  it("names the user `caller` in a deposit body, never `from`", async () => {
    const body = await bodyOf((c) => c.buildDeposit("CVAULT", { caller: "GUSER", amounts: [1n] }));
    expect(body.caller).toBe("GUSER");
    expect(body).not.toHaveProperty("from");
  });

  it("names the user `caller` in a withdraw body, never `from`", async () => {
    const body = await bodyOf((c) => c.buildWithdraw("CVAULT", { caller: "GUSER", amounts: [1n] }));
    expect(body.caller).toBe("GUSER");
    expect(body).not.toHaveProperty("from");
  });

  it("still names it `from` on the balance QUERY, which is the asymmetry", async () => {
    // Guards against someone "tidying" the two names into one and creating a
    // second bug while fixing the first.
    let seen = "";
    vi.stubGlobal(
      "fetch",
      mockFetch((u) => ((seen = u), {})),
    );
    await new DefindexClient(cfg).position("CVAULT", "GUSER");
    expect(seen).toContain("from=GUSER");
    expect(seen).not.toContain("caller=");
  });

  it("sends amounts as JSON numbers, which is what the DTO declares", async () => {
    const body = await bodyOf((c) =>
      c.buildDeposit("CVAULT", { caller: "GUSER", amounts: [1000000n, 2000000n] }),
    );
    expect(body.amounts).toEqual([1000000, 2000000]);
    for (const a of body.amounts as unknown[]) expect(typeof a).toBe("number");
  });

  it("refuses an amount too large to be a JSON number rather than rounding it", async () => {
    // Sending a different amount than the user approved is the worst thing this
    // module could do, and Number(bigint) does it silently above 2^53-1.
    expect(() =>
      moveBody({ caller: "GUSER", amounts: [BigInt(Number.MAX_SAFE_INTEGER) + 1n] }, "deposit"),
    ).toThrow(DefindexError);
  });

  it("refuses a negative amount and an empty amounts list", () => {
    expect(() => moveBody({ caller: "G", amounts: [-1n] }, "withdraw")).toThrow(DefindexError);
    expect(() => moveBody({ caller: "G", amounts: [] }, "deposit")).toThrow(DefindexError);
  });

  it("refuses slippage outside the documented 0..10000 basis points", () => {
    expect(() => moveBody({ caller: "G", amounts: [1n], slippageBps: 10_001 }, "deposit")).toThrow(
      DefindexError,
    );
    expect(() => moveBody({ caller: "G", amounts: [1n], slippageBps: -1 }, "deposit")).toThrow(
      DefindexError,
    );
  });

  it("omits slippageBps entirely when the caller did not set one", async () => {
    const body = await bodyOf((c) => c.buildDeposit("CVAULT", { caller: "G", amounts: [1n] }));
    expect(body).not.toHaveProperty("slippageBps");
  });
});

describe("APY presentation", () => {
  // The spec documents apy ALREADY IN PERCENT on every endpoint: "Current Last
  // 7d APY (%)" example 19.41, "24-hour Annual Percentage Yield (%)" example
  // 20.57381881828393. Multiplying by 100 rendered a real 19.41% vault as
  // "1941.00%", which is a financial misstatement, not a formatting slip.
  it("treats the reported number as a percentage, not a fraction", () => {
    expect(describeApy(19.41, 7)).toContain("19.41%");
    expect(describeApy(19.41, 7)).not.toContain("1941");
  });

  it("renders the spec's own account-performance example unchanged", () => {
    expect(describeApy(20.57381881828393, 1)).toContain("20.57%");
  });

  it("always states the window and that it is not guaranteed", () => {
    const s = describeApy(5.23, 7);
    expect(s).toContain("5.23%");
    expect(s).toContain("7 days");
    expect(s).toMatch(/variable and not guaranteed/);
  });

  it("says so plainly when no yield is reported", () => {
    expect(describeApy(undefined, 7)).toBe("Yield not reported");
  });

  it("says so plainly for a null or non-finite apy rather than printing NaN%", () => {
    // The 30d field is documented as "or null if calculation failed".
    expect(describeApy(null as unknown as number, 30)).toBe("Yield not reported");
    expect(describeApy(NaN, 30)).toBe("Yield not reported");
  });
});
