// DeFindex, the yield integration for the PUBLIC pocket.
//
// Yield can only live in the public pocket, and that is a mathematical fact
// rather than a product choice. Confidential balances are Pedersen commitments,
// which are additively homomorphic and nothing more: you can add and subtract
// committed values without decrypting, but you cannot multiply, discover a
// price, or hold the state a lending pool needs.
//
// API shape verified against the live OpenAPI spec at
// https://api.defindex.io/api-json (NOT /openapi.json, which 404s), because
// three of the five endpoints in our own specification were wrong:
//   - the submit endpoint is ROOT-level `POST /send`, not `/vault/{a}/send`
//   - there is no `launchtube` flag; `SendXdrDto` accepts only `xdr`
//   - `?network=` is REQUIRED on every vault endpoint and on /send
//
// Two asymmetries in that spec that look like typos and are not. Both were got
// wrong here once already, so they are written down rather than remembered:
//
//   1. The POST bodies name the user `caller`. The GET balance query names the
//      same user `from`. DepositDto and WithdrawDto declare
//      `required: ["amounts", "caller"]` and have no `from` property at all, so
//      a body carrying `from` is missing a required field and 400s.
//   2. `amounts` items are `type: "number"`, not strings, on both POSTs.
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
  /** Vault shares held, from the response's `dfTokens`. Not an XLM amount. */
  shares: string;
  /** What those shares are currently worth in the underlying, if reported. */
  underlying?: string;
}

/**
 * A deposit or withdrawal, before it is shaped for the wire.
 *
 * `amounts` is bigint because every amount in this wallet is an integral
 * subunit count and stays that way until it is formatted. The wire wants JSON
 * numbers, and that conversion is the only place precision can be lost, so it
 * happens once, in `moveBody`, where it can be checked.
 */
export interface MoveParams {
  /** The user. Serialised as `caller`, which is what the DTO requires. */
  caller: string;
  amounts: bigint[];
  /** Basis points, 0..10000. */
  slippageBps?: number;
}

/**
 * Shape a deposit or withdrawal for the wire, refusing to round.
 *
 * `amounts` items are declared `type: "number"` in the spec, so a bigint has to
 * become a JSON number. Above 2^53-1 that conversion silently changes the
 * value, and silently sending a different amount than the user approved is the
 * worst thing this module could do. 2^53-1 subunits is about 900 million units
 * at 7 decimals, so no honest amount reaches it and anything that does is a bug
 * worth stopping.
 */
export function moveBody(
  p: MoveParams,
  what: "deposit" | "withdraw",
): { caller: string; amounts: number[]; slippageBps?: number } {
  const amounts = p.amounts.map((a) => {
    if (a < 0n) throw new DefindexError(`Cannot ${what} a negative amount.`);
    if (a > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new DefindexError(
        `That ${what} amount is too large to send to the yield service without losing precision.`,
      );
    }
    return Number(a);
  });
  if (amounts.length === 0) throw new DefindexError(`a ${what} needs at least one amount`);
  if (p.slippageBps !== undefined && (p.slippageBps < 0 || p.slippageBps > 10_000)) {
    throw new DefindexError("slippageBps must be between 0 and 10000");
  }
  return {
    // NOT `from`. The DTO has no such property, so a body carrying it is
    // missing a required field and the request 400s.
    caller: p.caller,
    amounts,
    ...(p.slippageBps !== undefined ? { slippageBps: p.slippageBps } : {}),
  };
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

  /**
   * A user's position.
   *
   * `from` here is correct and is NOT the same name the POST bodies use. This
   * is the one endpoint whose user parameter is called `from`; see the header.
   */
  async position(address: string, user: string): Promise<VaultPosition> {
    // The body is NOT this shape, so it is mapped rather than cast. The live
    // endpoint answers {"dfTokens":"0","underlyingBalance":["0"]} and the
    // OpenAPI document declares no 200 schema for this path at all - only 400
    // and 403 - so there was nothing to check the old cast against. Read as
    // `VaultPosition`, `shares` was undefined on every real response, and the
    // yield row rendered the APY with the position beside it blank.
    // Re-verified against the live testnet vault on 2026-08-03.
    const body = await this.request<{ dfTokens?: unknown; underlyingBalance?: unknown }>(
      "GET",
      `/vault/${address}/balance?from=${encodeURIComponent(user)}`,
    );
    // A SHAPE check is not a VALUE check, and this is rendered as a balance.
    //
    // `typeof x === "string"` alone let any string through to `Home.tsx` and the
    // withdraw sheet, where it is printed as "<x> shares". That is not a route
    // to funds moving and React escapes it, so it is not an injection; it is
    // simply the fabricated-figure failure the comment below already names,
    // arriving through the field rather than instead of it. `describeApy` next
    // door validates with `Number.isFinite`, so the module was already applying
    // this discipline one function away.
    if (typeof body?.dfTokens !== "string" || !/^\d+(\.\d+)?$/.test(body.dfTokens)) {
      // Refused rather than defaulted to "0". A zero here is indistinguishable
      // on screen from a real empty position, and telling someone they hold
      // nothing when the answer was unreadable is the fabricated-balance
      // failure this module exists to avoid.
      // Written for a user, not a reader of this file. `DefindexError` is on
      // `dispatch.ts` SAFE_ERRORS, so whatever is written here is drawn verbatim
      // in the danger colour, and "carried no readable dfTokens" names an API
      // field nobody outside this module has heard of. The module's own register
      // three lines away already had it right.
      throw new DefindexError("The yield service sent a balance Pocket could not read.");
    }
    const underlying = Array.isArray(body.underlyingBalance)
      ? body.underlyingBalance[0]
      : undefined;
    return {
      shares: body.dfTokens,
      // Same rule: this is shown as an amount, so it has to look like one.
      underlying:
        typeof underlying === "string" && /^\d+(\.\d+)?$/.test(underlying) ? underlying : undefined,
    };
  }

  /**
   * Build an unsigned deposit. The wallet signs; DeFindex never sees a key.
   * `slippageBps` is on deposit as well as withdraw.
   */
  async buildDeposit(address: string, params: MoveParams): Promise<{ xdr: string }> {
    return this.request<{ xdr: string }>(
      "POST",
      `/vault/${address}/deposit`,
      moveBody(params, "deposit"),
    );
  }

  async buildWithdraw(address: string, params: MoveParams): Promise<{ xdr: string }> {
    return this.request<{ xdr: string }>(
      "POST",
      `/vault/${address}/withdraw`,
      moveBody(params, "withdraw"),
    );
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
      // Map a KNOWN, actionable failure to an authored message, without leaking
      // an arbitrary service string. DeFindex reports a deposit/withdraw that
      // the account cannot make for lack of a trustline on the vault's asset as
      // errorCode 13 ("TokenErrors.MissingTrustline"). Verified live on testnet.
      let code: unknown;
      try {
        code = (await res.json())?.errorCode;
      } catch {
        /* no readable body; fall through to the generic message */
      }
      if (code === 13) {
        throw new DefindexError(
          "You need a trustline for this vault's asset before you can deposit or withdraw.",
          res.status,
        );
      }
      // An HTTP status is not a sentence. This is the MOST LIKELY message a user
      // sees from this module: only errorCode 13 is mapped above, and the API
      // returns 10 and 124 for ordinary mistakes, all of which arrived as "The
      // yield service returned 400." The status is still carried on the error for
      // anything that wants to branch on it; it is simply not the user's line.
      throw new DefindexError(
        res.status >= 500
          ? "The yield service is not answering right now. Try again in a moment."
          : "The yield service refused that request. Check the amount and try again.",
        res.status,
      );
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
 * `apy` arrives ALREADY IN PERCENT, not as a 0..1 fraction. Every apy field in
 * the spec says so: "Current Last 7d APY (%)" with example 19.41, "24-hour
 * Annual Percentage Yield (%)" with example 20.57381881828393, and so on.
 * Multiplying by 100 here rendered a real 19.41% vault as "1941.00%".
 *
 * The window differs per endpoint (7d on the vault summary, 24h/7d/30d on
 * account performance), so the caller states which one it read. Showing a bare
 * percentage would be a financial representation we cannot substantiate, so the
 * window and the variability are always stated with it.
 */
export function describeApy(
  apy: number | undefined,
  windowDays: number,
): { figure: string | null; sentence: string } {
  // TWO values, because the callers need two and were splitting one with a regex.
  //
  // It returned a finished sentence and every caller treated it as a figure:
  // `y.apy.match(/[\d.]+%/)?.[0] ?? y.apy` on the rate row, and two tips that
  // interpolated the whole thing into another sentence, producing "The vault
  // reports 19.41% over the last 7 days, variable and not guaranteed; it is
  // variable and not guaranteed." The window, which is the DEFINITION of the
  // number, was the part the regex threw away.
  //
  // `figure` is null, not a sentinel string, when there is nothing to report.
  // "Yield not reported" was being drawn as a rate in the positive colour at
  // weight 600 and interpolated as "The vault reports Yield not reported".
  if (apy === undefined || apy === null || !Number.isFinite(apy)) {
    return { figure: null, sentence: "Yield not reported" };
  }
  return {
    figure: `${apy.toFixed(2)}%`,
    sentence: `${apy.toFixed(2)}% over the last ${windowDays} days, variable and not guaranteed`,
  };
}
