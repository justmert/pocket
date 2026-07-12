// Aquarius, the in-app swap for the PUBLIC pocket.
//
// Keyless and non-custodial in the strongest sense: this client fetches only
// ROUTING data (a swap_chain_xdr and an estimate). The wallet then BUILDS the
// swap_chained invocation against the router contract itself and signs it, so
// Aquarius never sees a key and never hands us an envelope to sign blind. That
// is a better shape than an aggregator that returns a pre-built transaction.
//
// find-path / find-path-strict-receive were verified live against the testnet
// API; the swap_chained argument types were read off the DEPLOYED router
// contract (D10), not the docs. `amount` in the response is the estimated output
// (strict-send) or the required input (strict-receive), in 7-decimal stroops.
import { Address, xdr } from "@stellar/stellar-sdk/base";
import { deadlineSignal, SERVICE_HTTP_TIMEOUT_MS } from "../chain/http";

export interface AquariusConfig {
  /** e.g. https://amm-api-testnet.aqua.network/api/external/v2 */
  apiUrl: string;
  /** Request deadline. Defaults to SERVICE_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface SwapPath {
  /**
   * Base64 ScVal, a Vec<(Vec<Address>, BytesN<32>, Address)>, passed VERBATIM as
   * the swap_chained `swaps_chain` argument.
   *
   * It is not re-encoded, and that is worth exactly nothing on its own. Not
   * re-encoding stops US corrupting a route we were handed; it says nothing
   * about a route that was wrong on arrival, and this value arrives from a
   * third-party HTTP host. `readRouteEndpoints` below is what actually checks
   * it, and `controller.buildSwap` refuses on mismatch.
   */
  swapChainXdr: string;
  /** Estimated output (strict-send) or required input (strict-receive), stroops. */
  amount: bigint;
  /** Pool contract ids on the route. */
  pools: string[];
  /** Tokens on the route, for display. */
  tokens: string[];
}

export class AquariusError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "AquariusError";
  }
}

/** What a route actually commits to, read out of the bytes that get signed. */
export interface RouteEndpoints {
  /**
   * The first hop's pool pair. The token being spent must be one of these.
   *
   * A pool names its pair SORTED, not as (in, out), so which member is the
   * input is not positional. Membership is the only thing that can be checked.
   */
  firstPair: string[];
  /** The token the LAST hop delivers. This is what the user actually receives. */
  terminal: string;
  hops: number;
}

/**
 * Read the endpoints a `swaps_chain` commits to.
 *
 * `swap_chained` takes (user, swaps_chain, token_in, in_amount, out_min) and has
 * NO token_out argument, so the asset the user receives is decided entirely by
 * the last hop of this structure. `out_min` is a bare scalar denominated in
 * whatever that token turns out to be, so it bounds quantity and cannot bind
 * identity. Without reading the route there is nothing at all tying the delivered
 * asset to the one the confirm screen names.
 *
 * The shape was read off a live testnet route rather than from the docs (D10).
 * Each hop is a 3-tuple:
 *
 *   [0] Vec<Address>   the pool's token pair, sorted ascending
 *   [1] BytesN<32>     the pool identifier
 *   [2] Address        the token this hop delivers
 *
 * A real XLM to USDC route came back as two hops via AQUA:
 *   hop 0: pair [XLM, AQUA], out AQUA
 *   hop 1: pair [USDC, AQUA], out USDC
 *
 * Throws rather than returning null on anything unexpected. A route we cannot
 * read is a route we must not sign, and the caller turns this into a refusal.
 */
export function readRouteEndpoints(swapChainXdr: string): RouteEndpoints {
  let root: xdr.ScVal;
  try {
    root = xdr.ScVal.fromXDR(swapChainXdr, "base64");
  } catch {
    throw new AquariusError("The swap route could not be decoded, so Pocket will not sign it.");
  }
  if (root.switch().name !== "scvVec") throw badRoute("it is not a list of hops");
  const hops = root.vec() ?? [];
  if (hops.length === 0) throw badRoute("it contains no hops");

  const addressAt = (hop: xdr.ScVal, index: number): string => {
    const parts = hop.switch().name === "scvVec" ? (hop.vec() ?? []) : [];
    if (parts.length !== 3) throw badRoute("a hop is not a three-part tuple");
    const at = parts[index]!;
    if (at.switch().name !== "scvAddress") throw badRoute("a hop names no delivered token");
    return Address.fromScVal(at).toString();
  };

  const first = hops[0]!;
  const firstParts = first.switch().name === "scvVec" ? (first.vec() ?? []) : [];
  if (firstParts.length !== 3) throw badRoute("a hop is not a three-part tuple");
  const pair = firstParts[0]!;
  if (pair.switch().name !== "scvVec") throw badRoute("the first hop names no token pair");
  const firstPair = (pair.vec() ?? []).map((a) => {
    if (a.switch().name !== "scvAddress") throw badRoute("a pool pair holds a non-address");
    return Address.fromScVal(a).toString();
  });

  return {
    firstPair,
    terminal: addressAt(hops[hops.length - 1]!, 2),
    hops: hops.length,
  };
}

function badRoute(why: string): AquariusError {
  // The reason is authored here and interpolates nothing from the wire, so this
  // is safe to surface through describeError's allowlist.
  return new AquariusError(`Pocket could not read the swap route (${why}), so it will not sign it.`);
}

interface FindPathResponse {
  success?: unknown;
  swap_chain_xdr?: unknown;
  amount?: unknown;
  pools?: unknown;
  tokens?: unknown;
}

export class AquariusClient {
  constructor(private readonly cfg: AquariusConfig) {}

  /** Best strict-send route: how much `tokenOut` for a fixed `tokenIn` amount. */
  async findPath(tokenIn: string, tokenOut: string, amount: bigint): Promise<SwapPath> {
    return this.path("/find-path/", tokenIn, tokenOut, amount);
  }

  /** Best strict-receive route: how much `tokenIn` for a fixed `tokenOut` amount. */
  async findPathStrictReceive(
    tokenIn: string,
    tokenOut: string,
    amount: bigint,
  ): Promise<SwapPath> {
    return this.path("/find-path-strict-receive/", tokenIn, tokenOut, amount);
  }

  private async path(
    endpoint: string,
    tokenIn: string,
    tokenOut: string,
    amount: bigint,
  ): Promise<SwapPath> {
    const body = await this.request(endpoint, {
      token_in_address: tokenIn,
      token_out_address: tokenOut,
      amount: amount.toString(),
    });
    if (body?.success !== true || typeof body.swap_chain_xdr !== "string") {
      // No route, or a shape we cannot trust. Refused rather than defaulted: a
      // zero estimate is indistinguishable on screen from a real thin market.
      throw new AquariusError("No swap route was found for that pair and amount.");
    }
    // `amount` is stroops. Parse to bigint, refusing anything non-integral rather
    // than coercing a float and silently changing what the user swaps.
    const raw = typeof body.amount === "string" ? body.amount : String(body.amount ?? "");
    if (!/^\d+$/.test(raw)) {
      throw new AquariusError("The swap route returned an unreadable amount.");
    }
    return {
      swapChainXdr: body.swap_chain_xdr,
      amount: BigInt(raw),
      pools: Array.isArray(body.pools) ? body.pools.map(String) : [],
      tokens: Array.isArray(body.tokens) ? body.tokens.map(String) : [],
    };
  }

  private async request(path: string, body: unknown): Promise<FindPathResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.cfg.apiUrl}${path}`, {
        method: "POST",
        // Without a deadline a swap endpoint that accepts the connection and then
        // stalls holds this promise open forever, behind the same worker.
        signal: deadlineSignal(this.cfg.timeoutMs ?? SERVICE_HTTP_TIMEOUT_MS),
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      const why =
        e instanceof Error
          ? e.name === "TimeoutError" || e.name === "AbortError"
            ? `no answer within ${(this.cfg.timeoutMs ?? SERVICE_HTTP_TIMEOUT_MS) / 1000}s`
            : e.message
          : "network error";
      throw new AquariusError(`Could not reach the swap service (${why}).`);
    }
    if (!res.ok) {
      throw new AquariusError(`The swap service returned ${res.status}.`, res.status);
    }
    try {
      return (await res.json()) as FindPathResponse;
    } catch {
      throw new AquariusError("The swap service sent a response Pocket could not read.");
    }
  }
}
