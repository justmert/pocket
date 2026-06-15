// DeFindex, the yield integration for the PUBLIC pocket.
//
// Yield can only live in the public pocket, and that is a mathematical fact
// rather than a product choice. Confidential balances are Pedersen commitments,
// which are additively homomorphic and nothing more: you can add and subtract
// committed values without decrypting, but you cannot multiply, discover a
// price, or hold the state a lending pool needs.
//
// API shape verified against the live OpenAPI spec, because three of the five
// endpoints in our own specification were wrong:
//   - the submit endpoint is ROOT-level `POST /send`, not `/vault/{a}/send`
//   - there is no `launchtube` flag; `SendXdrDto` accepts only `xdr`
//   - `?network=` is REQUIRED on every vault endpoint and on /send
import { deadlineSignal, SERVICE_HTTP_TIMEOUT_MS } from "../chain/http";

export interface DefindexConfig {
  baseUrl: string;
  apiKey: string;
  network: "testnet" | "mainnet";
  /** Request deadline. Defaults to SERVICE_HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
}

export interface VaultInfo {
  address: string;
  name?: string;
  symbol?: string;
  assets?: { address: string; symbol?: string }[];
  /** Reported yield. The window differs per endpoint, so callers must label it. */
  apy?: number;
  totalSupply?: string;
}

export interface VaultPosition {
  shares: string;
  underlying?: string;
}

export class DefindexError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "DefindexError";
  }
}

export class DefindexClient {
  constructor(private readonly cfg: DefindexConfig) {}

  async vault(address: string): Promise<VaultInfo> {
    return this.request<VaultInfo>("GET", `/vault/${address}`);
  }

  /** A user's position. `from` is required. */
  async position(address: string, user: string): Promise<VaultPosition> {
    return this.request<VaultPosition>(
      "GET",
      `/vault/${address}/balance?from=${encodeURIComponent(user)}`,
    );
  }

  /**
   * Build an unsigned deposit. The wallet signs; DeFindex never sees a key.
   * `slippageBps` is on deposit as well as withdraw.
   */
  async buildDeposit(
    address: string,
    params: { from: string; amounts: string[]; slippageBps?: number },
  ): Promise<{ xdr: string }> {
    return this.request<{ xdr: string }>("POST", `/vault/${address}/deposit`, params);
  }

  async buildWithdraw(
    address: string,
    params: { from: string; amounts: string[]; slippageBps?: number },
  ): Promise<{ xdr: string }> {
    return this.request<{ xdr: string }>("POST", `/vault/${address}/withdraw`, params);
  }

  /**
   * Submit a transaction Pocket has already signed. Root-level, NOT under
   * /vault. Accepts only `xdr`: no launchtube, no sponsorship, no fee bump, so
   * the user pays their own fee.
   */
  async send(signedXdr: string): Promise<{ hash?: string }> {
    return this.request<{ hash?: string }>("POST", `/send`, { xdr: signedXdr });
  }

  private url(path: string): string {
    const sep = path.includes("?") ? "&" : "?";
    return `${this.cfg.baseUrl}${path}${sep}network=${this.cfg.network}`;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        method,
        // Without a deadline a yield endpoint that accepts the connection and
        // then stalls holds this promise open forever, and the public pocket
        // is behind the same worker.
        signal: deadlineSignal(this.cfg.timeoutMs ?? SERVICE_HTTP_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${this.cfg.apiKey}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      const why =
        e instanceof Error
          ? e.name === "TimeoutError" || e.name === "AbortError"
            ? `no answer within ${(this.cfg.timeoutMs ?? SERVICE_HTTP_TIMEOUT_MS) / 1000}s`
            : e.message
          : "network error";
      throw new DefindexError(`Could not reach the yield service (${why}).`);
    }
    if (!res.ok) {
      throw new DefindexError(`The yield service returned ${res.status}.`, res.status);
    }
    try {
      return (await res.json()) as T;
    } catch {
      // A proxy error page served with a 200 would otherwise escape as a bare
      // SyntaxError, which is neither this module's error type nor anything a
      // caller can distinguish from a bug in our own code.
      throw new DefindexError("The yield service sent a response Pocket could not read.");
    }
  }
}

/**
 * How an APY must be presented.
 *
 * Their API reports `apy` over a 7-day window on one endpoint and 30 on
 * another, in different units. Showing a bare percentage would be a financial
 * representation we cannot substantiate, so the window and the variability are
 * always stated with it.
 */
export function describeApy(apy: number | undefined, windowDays: number): string {
  if (apy === undefined) return "Yield not reported";
  return `${(apy * 100).toFixed(2)}% over the last ${windowDays} days, variable and not guaranteed`;
}
