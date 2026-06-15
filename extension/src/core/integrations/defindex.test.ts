import { describe, it, expect, vi } from "vitest";
import { DefindexClient, DefindexError, describeApy } from "./defindex";

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
    await c.buildDeposit("CVAULT", { from: "GUSER", amounts: ["100"] });
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
      from: "GUSER",
      amounts: ["100"],
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

describe("APY presentation", () => {
  it("always states the window and that it is not guaranteed", () => {
    const s = describeApy(0.0523, 7);
    expect(s).toContain("5.23%");
    expect(s).toContain("7 days");
    expect(s).toMatch(/variable and not guaranteed/);
  });

  it("says so plainly when no yield is reported", () => {
    expect(describeApy(undefined, 7)).toBe("Yield not reported");
  });
});
