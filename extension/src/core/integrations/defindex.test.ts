import { describe, it, expect, vi } from "vitest";
import { DefindexClient, DefindexError, describeApy, moveBody } from "./defindex";

const cfg = { baseUrl: "https://api.defindex.io", apiKey: "sk_test", network: "testnet" as const };

const mockFetch = (handler: (url: string, init?: RequestInit) => unknown) =>
  vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  })) as unknown as typeof fetch;

/**
 * What the live balance endpoint actually answers, recorded from the testnet
 * XLM vault on 2026-08-03. The OpenAPI document declares no 200 schema for that
 * path, so this literal is the only specification of it there is.
 */
const BALANCE_BODY = { dfTokens: "0", underlyingBalance: ["0"] };

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
      mockFetch((u) => (urls.push(u), BALANCE_BODY)),
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
      mockFetch((u) => ((seen = u), BALANCE_BODY)),
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
    // The STATUS is carried on the error for anything that wants to branch on
    // it; it is not the user's sentence. "The yield service returned 502." was
    // being drawn verbatim in the danger colour.
    const err = await new DefindexClient(cfg).vault("C").catch((e: Error & { status?: number }) => e);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/not answering right now/i);
    expect(err.message, "an HTTP status is not a sentence").not.toMatch(/502/);
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
      mockFetch((u) => ((seen = u), BALANCE_BODY)),
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
    expect(describeApy(19.41, 7).sentence).toContain("19.41%");
    expect(describeApy(19.41, 7).sentence).not.toContain("1941");
  });

  it("renders the spec's own account-performance example unchanged", () => {
    expect(describeApy(20.57381881828393, 1).sentence).toContain("20.57%");
  });

  it("always states the window and that it is not guaranteed", () => {
    const { sentence } = describeApy(5.23, 7);
    expect(sentence).toContain("5.23%");
    expect(sentence).toContain("7 days");
    expect(sentence).toMatch(/variable and not guaranteed/);
  });

  it("offers the bare figure separately, so no caller has to regex the sentence", () => {
    // The whole reason for the pair. Every caller wanted the figure for a table
    // cell and got a sentence, so one of them ran `/[\d.]+%/` over it and threw
    // the WINDOW away, which is the definition of the number.
    expect(describeApy(19.41, 7).figure).toBe("19.41%");
  });

  it("says so plainly when no yield is reported, and offers NO figure for it", () => {
    // `figure` is null rather than the sentinel string, because the sentinel was
    // being drawn as a rate: "Yield not reported" in the positive colour at
    // weight 600, and interpolated as "The vault reports Yield not reported".
    expect(describeApy(undefined, 7).sentence).toBe("Yield not reported");
    expect(describeApy(undefined, 7).figure).toBeNull();
  });

  it("says so plainly for a null or non-finite apy rather than printing NaN%", () => {
    // The 30d field is documented as "or null if calculation failed".
    expect(describeApy(null as unknown as number, 30).sentence).toBe("Yield not reported");
    expect(describeApy(null as unknown as number, 30).figure).toBeNull();
    expect(describeApy(NaN, 30).sentence).toBe("Yield not reported");
    expect(describeApy(NaN, 30).figure).toBeNull();
  });
});

describe("the vault balance response, which the spec does not describe", () => {
  it("reads shares out of dfTokens rather than a `shares` field that is never sent", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ dfTokens: "1234567", underlyingBalance: ["89"] })),
    );
    const pos = await new DefindexClient(cfg).position("CVAULT", "GUSER");
    // Cast straight to VaultPosition this was `undefined`, and the yield row
    // rendered an APY with nothing beside it.
    expect(pos.shares).toBe("1234567");
    expect(pos.underlying).toBe("89");
  });

  it("carries a zero position through as a zero, not as an error", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => BALANCE_BODY),
    );
    expect((await new DefindexClient(cfg).position("CVAULT", "GUSER")).shares).toBe("0");
  });

  it("refuses a body it cannot read rather than calling it empty", async () => {
    // "You hold nothing" and "I could not read what you hold" are different
    // facts, and only one of them is about the user.
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ balance: "5" })),
    );
    await expect(new DefindexClient(cfg).position("CVAULT", "GUSER")).rejects.toThrow(
      DefindexError,
    );
  });

  it("does not invent an underlying figure when the array is absent", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(() => ({ dfTokens: "7" })),
    );
    const pos = await new DefindexClient(cfg).position("CVAULT", "GUSER");
    expect(pos.shares).toBe("7");
    expect(pos.underlying).toBeUndefined();
  });
});

describe("actionable errors from the live API", () => {
  // Verified live on testnet: a deposit by an account with no trustline for the
  // vault's asset returns { errorCode: 13, message: "TokenErrors.MissingTrustline" }.
  it("maps a missing-trustline failure (code 13) to an authored message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ errorCode: 13, message: "TokenErrors.MissingTrustline" }),
      })) as unknown as typeof fetch,
    );
    await expect(
      new DefindexClient(cfg).buildDeposit("CVAULT", { caller: "GUSER", amounts: [1n] }),
    ).rejects.toThrow(/trustline/i);
  });

  it("falls back to a generic message for an unknown error code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({ errorCode: 999 }),
      })) as unknown as typeof fetch,
    );
    await expect(
      new DefindexClient(cfg).buildDeposit("CVAULT", { caller: "GUSER", amounts: [1n] }),
    ).rejects.toThrow(/not answering right now/i);
  });

  it("tells a refusal from an outage, because the remedies differ", async () => {
    // 4xx is "that request was wrong", which the user can act on; 5xx is "the
    // service is down", which they can only wait out. Both used to be one
    // sentence with a number in it, and 4xx is the commoner one: only errorCode
    // 13 is mapped, and the API returns 10 and 124 for ordinary mistakes.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({ errorCode: 124 }),
      })) as unknown as typeof fetch,
    );
    const err = await new DefindexClient(cfg)
      .buildDeposit("CVAULT", { caller: "GUSER", amounts: [1n] })
      .catch((e: Error & { status?: number }) => e);
    expect(err.message).toMatch(/refused that request/i);
    expect(err.message).not.toMatch(/not answering/i);
    expect(err.status, "the status is still carried, just not shown").toBe(400);
  });
});

describe("a vault balance is a number or it is refused", () => {
  const cfg = { baseUrl: "https://api.defindex.io", apiKey: "k", network: "testnet" as const };
  const answering = (body: unknown) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => body,
      })) as unknown as typeof fetch,
    );

  it("accepts a real numeric answer", () => {
    // The control, taken from the live testnet vault's actual response shape.
    answering({ dfTokens: "0", underlyingBalance: ["0"] });
    return expect(new DefindexClient(cfg).position("CVAULT", "GUSER")).resolves.toMatchObject({
      shares: "0",
    });
  });

  it("refuses a string that is not a number", () => {
    // This reached Home.tsx and the withdraw sheet and was printed where a
    // balance goes. React escapes it, so the harm is a fabricated figure rather
    // than an injection, which is exactly what this module says it refuses.
    answering({ dfTokens: "you have won a prize, visit example.com" });
    return expect(new DefindexClient(cfg).position("CVAULT", "GUSER")).rejects.toBeInstanceOf(
      DefindexError,
    );
  });

  it("refuses a numeric-looking value that is not one", () => {
    answering({ dfTokens: "1e9" });
    return expect(new DefindexClient(cfg).position("CVAULT", "GUSER")).rejects.toBeInstanceOf(
      DefindexError,
    );
  });

  it("drops an unreadable underlying rather than showing it", () => {
    answering({ dfTokens: "5", underlyingBalance: ["not a number"] });
    return expect(new DefindexClient(cfg).position("CVAULT", "GUSER")).resolves.toMatchObject({
      shares: "5",
      underlying: undefined,
    });
  });
});
