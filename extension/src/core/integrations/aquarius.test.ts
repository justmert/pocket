import { describe, it, expect, vi } from "vitest";
import { Address, nativeToScVal, xdr } from "@stellar/stellar-sdk/base";
import { AquariusClient, AquariusError, readRouteEndpoints } from "./aquarius";

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

/**
 * A REAL testnet route, captured from find-path on 2026-08-07 for
 * XLM -> USDC at 100 XLM. Two hops via AQUA. Pinned as bytes rather than
 * rebuilt, because the whole point of the reader is that it survives contact
 * with what the API actually sends.
 *
 *   hop 0: pair [XLM, AQUA], delivers AQUA
 *   hop 1: pair [USDC, AQUA], delivers USDC
 */
const REAL_ROUTE =
  "AAAAEAAAAAEAAAACAAAAEAAAAAEAAAADAAAAEAAAAAEAAAACAAAAEgAAAAHXkotywnA8z+r365/0701QSlWouXn8m0UOoshCtNHOYQAAABIAAAAB21hbnBbOBeG1hyTg3x0lsTNXF7+S8knLgMAUo6UXVzgAAAANAAAAICT5yZHESs8z//X0QDHEA4XSNdwhLXN56CS6PbHDU3HzAAAAEgAAAAHbWFucFs4F4bWHJODfHSWxM1cXv5LyScuAwBSjpRdXOAAAABAAAAABAAAAAwAAABAAAAABAAAAAgAAABIAAAABUEXNXsBymnaP1a0CUFhS308Cjc6DDlrFIgm6SEg7LwEAAAASAAAAAdtYW5wWzgXhtYck4N8dJbEzVxe/kvJJy4DAFKOlF1c4AAAADQAAACCy4C/PymyW+K1cvYTneEp3ezbZyWokWUAsT0WEYqq38AAAABIAAAABUEXNXsBymnaP1a0CUFhS308Cjc6DDlrFIgm6SEg7LwE=";
const XLM = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const USDC = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
const AQUA = "CDNVQW44C3HALYNVQ4SOBXY5EWYTGVYXX6JPESOLQDABJI5FC5LTRRUE";

/** Build a route with a chosen terminal token, to stand in for a hostile answer. */
function routeDelivering(pairA: string, pairB: string, terminal: string): string {
  const hop = xdr.ScVal.scvVec([
    xdr.ScVal.scvVec([
      nativeToScVal(Address.fromString(pairA)),
      nativeToScVal(Address.fromString(pairB)),
    ]),
    xdr.ScVal.scvBytes(Buffer.alloc(32)),
    nativeToScVal(Address.fromString(terminal)),
  ]);
  return xdr.ScVal.scvVec([hop]).toXDR("base64");
}

describe("reading what a swap route actually commits to", () => {
  it("reads the endpoints of a real testnet route", () => {
    const r = readRouteEndpoints(REAL_ROUTE);
    expect(r.hops).toBe(2);
    // The last hop delivers USDC, which is the only thing binding the asset the
    // user receives: swap_chained has no token_out argument.
    expect(r.terminal).toBe(USDC);
    // The first pool names its pair sorted, so the input is a member, not [0].
    expect(r.firstPair).toContain(XLM);
    expect(r.firstPair).toContain(AQUA);
  });

  it("reports the terminal of a single-hop route", () => {
    const r = readRouteEndpoints(routeDelivering(XLM, USDC, USDC));
    expect(r.hops).toBe(1);
    expect(r.terminal).toBe(USDC);
    expect(r.firstPair).toEqual([XLM, USDC]);
  });

  it("surfaces a route that delivers a different token, which is the attack", () => {
    // A hostile router answer: the user asked for USDC and the route ends in AQUA.
    // out_min is a bare scalar in the terminal token's units, so it would bound
    // the quantity of AQUA and never notice the substitution.
    const r = readRouteEndpoints(routeDelivering(XLM, AQUA, AQUA));
    expect(r.terminal).toBe(AQUA);
    expect(r.terminal).not.toBe(USDC);
  });

  it("refuses bytes that are not a route", () => {
    expect(() => readRouteEndpoints("not base64 at all!!")).toThrow(AquariusError);
    // A well-formed ScVal that is not a vector of hops.
    expect(() => readRouteEndpoints(xdr.ScVal.scvU32(7).toXDR("base64"))).toThrow(AquariusError);
    // An empty route commits to nothing and must not read as "delivers what you asked".
    expect(() => readRouteEndpoints(xdr.ScVal.scvVec([]).toXDR("base64"))).toThrow(AquariusError);
  });

  it("refuses a hop whose shape is not the three-part tuple", () => {
    const short = xdr.ScVal.scvVec([xdr.ScVal.scvVec([nativeToScVal(Address.fromString(XLM))])]);
    expect(() => readRouteEndpoints(short.toXDR("base64"))).toThrow(AquariusError);
  });
});
