import { describe, it, expect, vi } from "vitest";
import { AquariusClient, AquariusError } from "./aquarius";

const cfg = { apiUrl: "https://amm-api-testnet.aqua.network/api/external/v2" };

/** ok:true fetch whose body is whatever the handler returns. */
const okFetch = (handler: (url: string, init?: RequestInit) => unknown) =>
  vi.fn(async (url: string, init?: RequestInit) => ({
    ok: true,
    status: 200,
    json: async () => handler(url, init),
  })) as unknown as typeof fetch;

/** A response shaped like the live testnet find-path answer. */
const PATH_BODY = {
  success: true,
  swap_chain_xdr: "AAAAEAAAAAEAAAAE", // opaque to the client; passed through verbatim
  amount: "7871870479",
  pools: ["CBLLSKUH6N6HGFV5MSAMMJWJFYNUFEH7EGH2T4HJKOVMIZNJ23BZSMCM"],
  tokens: ["native", "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"],
};

describe("AquariusClient.findPath", () => {
  it("posts to /find-path/ with the token pair and amount, and parses the route", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    vi.stubGlobal(
      "fetch",
      okFetch((url, init) => {
        seenUrl = url;
        seenBody = JSON.parse(String(init?.body));
        return PATH_BODY;
      }),
    );
    const path = await new AquariusClient(cfg).findPath("CIN", "COUT", 100000000n);
    expect(seenUrl).toBe(`${cfg.apiUrl}/find-path/`);
    expect(seenBody).toEqual({
      token_in_address: "CIN",
      token_out_address: "COUT",
      amount: "100000000",
    });
    // amount is parsed to a bigint (stroops), never a float.
    expect(path.amount).toBe(7871870479n);
    expect(path.swapChainXdr).toBe(PATH_BODY.swap_chain_xdr);
    expect(path.pools).toEqual(PATH_BODY.pools);
    expect(path.tokens).toEqual(PATH_BODY.tokens);
  });

  it("uses the strict-receive endpoint for findPathStrictReceive", async () => {
    let seenUrl = "";
    vi.stubGlobal(
      "fetch",
      okFetch((url) => ((seenUrl = url), PATH_BODY)),
    );
    await new AquariusClient(cfg).findPathStrictReceive("CIN", "COUT", 1n);
    expect(seenUrl).toBe(`${cfg.apiUrl}/find-path-strict-receive/`);
  });

  it("accepts a numeric amount and still yields a bigint", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch(() => ({ ...PATH_BODY, amount: 12345 })),
    );
    const path = await new AquariusClient(cfg).findPath("CIN", "COUT", 1n);
    expect(path.amount).toBe(12345n);
  });

  it("refuses a no-route answer rather than returning a zero estimate", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch(() => ({ success: false, detail: "No path found" })),
    );
    await expect(new AquariusClient(cfg).findPath("CIN", "COUT", 1n)).rejects.toBeInstanceOf(
      AquariusError,
    );
  });

  it("refuses a non-integral amount rather than coercing a float", async () => {
    vi.stubGlobal(
      "fetch",
      okFetch(() => ({ ...PATH_BODY, amount: "1.5" })),
    );
    await expect(new AquariusClient(cfg).findPath("CIN", "COUT", 1n)).rejects.toBeInstanceOf(
      AquariusError,
    );
  });

  it("surfaces an HTTP error as a typed AquariusError with the status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 502,
        json: async () => ({}),
      })) as unknown as typeof fetch,
    );
    await expect(new AquariusClient(cfg).findPath("CIN", "COUT", 1n)).rejects.toMatchObject({
      name: "AquariusError",
      status: 502,
    });
  });
});
