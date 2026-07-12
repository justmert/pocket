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
   * the swap_chained `swaps_chain` argument. The wallet decodes it to an ScVal;
   * it is not re-encoded, so a wrong route cannot be constructed here.
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
