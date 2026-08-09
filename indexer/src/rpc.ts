// Resilient Soroban RPC with automatic failover.
//
// The archive exists to outlive RPC's retention window, so the one failure it
// cannot tolerate is a permanent gap: a range that ages out of every source
// before it was ingested. A single RPC provider having a bad minute (a 429, a
// 502, a stalled socket) during a backfill is exactly how such a gap opens.
//
// So the ingester talks to an ORDERED list of independent, keyless, and
// verified-equivalent endpoints (SDF's public RPC and Ankr's public testnet
// Soroban RPC, confirmed this session to serve byte-identical getEvents). A
// transient failure on one is retried on the next within the same call, so a
// provider hiccup degrades to a slightly slower request rather than a hole.
//
// It fails over ONLY on transient faults. A logic error - most importantly the
// RPC's own "startLedger must be within the ledger range" as the retention floor
// slides mid-run - is propagated unchanged, because backfill.ts already handles
// that by re-reading the floor and re-clamping. Failing over on it would hit the
// same error on the next endpoint and mask the handling that exists for it.
import { rpc } from "@stellar/stellar-sdk";

// Verified working and keyless this session (identical getEvents output, no 429
// on a burst, ~0.6s). Order is preference: SDF first, Ankr as the standby.
const DEFAULT_RPC_URLS = [
  "https://soroban-testnet.stellar.org",
  "https://rpc.ankr.com/stellar_testnet_soroban",
];

// A getEvents scan of a 10,000-ledger chunk takes a few seconds; 20s leaves room
// without letting a stalled endpoint hold the whole backfill hostage. When it
// trips, the call is treated as transient and the next endpoint is tried.
export const DEFAULT_RPC_TIMEOUT_MS = 20_000;

/**
 * The RPC surface the archive actually uses. Kept deliberately tiny: the
 * ingester reads events and the retention window, nothing else. Narrowing to
 * this is what lets the resilient wrapper stand in for a full `rpc.Server`
 * wherever the ingester expects one.
 */
export type RpcLike = Pick<rpc.Server, "getHealth" | "getEvents">;

type GetEventsReq = Parameters<rpc.Server["getEvents"]>[0];
type GetEventsRes = Awaited<ReturnType<rpc.Server["getEvents"]>>;
type GetHealthRes = Awaited<ReturnType<rpc.Server["getHealth"]>>;

/** Endpoints to try, in order. `RPC_URLS` (comma-separated) enables failover;
 *  a lone `RPC_URL` is honoured as a single explicit choice; absent both, the
 *  two verified public endpoints are used so the default is already resilient. */
export function resolveRpcUrls(): string[] {
  const many = process.env.RPC_URLS?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (many && many.length > 0) return many;
  if (process.env.RPC_URL) return [process.env.RPC_URL];
  return [...DEFAULT_RPC_URLS];
}

/** A per-call deadline that surfaces as a transient error, so a stalled endpoint
 *  fails over instead of blocking forever. The underlying request is abandoned,
 *  not cancelled: harmless here, because every RPC call the archive makes is a
 *  read and its result is simply discarded. */
export class RpcTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RpcTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new RpcTimeoutError(`${label} timed out after ${ms}ms`)),
      ms,
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
]);

/**
 * Is this the kind of failure another endpoint might not have?
 *
 * Transient: a rate limit (429), a server-side fault (5xx), a dropped or stalled
 * connection, our own timeout. These are worth retrying elsewhere.
 *
 * NOT transient, and therefore propagated so the caller's own logic runs: a
 * malformed request, and above all the JSON-RPC "within the ledger range" error
 * the RPC raises when the retention floor has moved past the requested start.
 * backfill.ts catches exactly that message and re-clamps; failing over would
 * short-circuit that and reach the same wall on the next endpoint.
 */
export function isTransient(e: unknown): boolean {
  if (e instanceof RpcTimeoutError) return true;
  const err = e as {
    response?: { status?: number };
    status?: number;
    code?: string;
    name?: string;
    message?: string;
  };
  const status = err?.response?.status ?? err?.status;
  if (typeof status === "number" && (status === 429 || status >= 500)) return true;
  if (typeof err?.code === "string" && NETWORK_CODES.has(err.code)) return true;
  if (err?.name === "AbortError" || err?.name === "TimeoutError") return true;
  const msg = (err?.message ?? "").toLowerCase();
  // Standard HTTP fault phrasings and socket errors, for SDK versions that fold
  // the status into the message rather than exposing `.response.status`.
  return /\b429\b|too many requests|bad gateway|gateway timeout|service unavailable|internal server error|timeout|timed out|network error|fetch failed|socket hang up|econn|enotfound|getaddrinfo/.test(
    msg,
  );
}

function message(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (e && typeof e === "object") {
    const o = e as { response?: { status?: number }; status?: number; code?: string; message?: string };
    const parts = [
      (o.response?.status ?? o.status) !== undefined ? `status ${o.response?.status ?? o.status}` : null,
      o.code ? `code ${o.code}` : null,
      o.message ?? null,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(" ");
  }
  return String(e);
}

/**
 * An `rpc.Server`-shaped client backed by several endpoints. Each call starts at
 * the last endpoint that worked (so a downed primary is not retried on every
 * call) and advances to the next only on a transient failure.
 */
export class ResilientRpc implements RpcLike {
  // Plain fields assigned in the constructor body rather than TypeScript
  // parameter properties: this file is executed directly by `node` in
  // strip-only mode (see package.json `node src/*.ts`), which rejects parameter
  // properties with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
  private current = 0;
  private readonly servers: RpcLike[];
  private readonly urls: string[];
  private readonly timeoutMs: number;

  constructor(servers: RpcLike[], urls: string[], timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS) {
    if (servers.length === 0) {
      throw new Error("ResilientRpc needs at least one endpoint");
    }
    this.servers = servers;
    this.urls = urls;
    this.timeoutMs = timeoutMs;
  }

  static fromUrls(urls: string[], timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS): ResilientRpc {
    if (urls.length === 0) throw new Error("no RPC URLs configured");
    return new ResilientRpc(
      urls.map((u) => new rpc.Server(u)),
      urls,
      timeoutMs,
    );
  }

  /** The endpoints in preference order, for a startup log. */
  endpoints(): readonly string[] {
    return this.urls;
  }

  getHealth(): Promise<GetHealthRes> {
    return this.withFailover((s) => s.getHealth(), "getHealth");
  }

  getEvents(request: GetEventsReq): Promise<GetEventsRes> {
    return this.withFailover((s) => s.getEvents(request), "getEvents");
  }

  private async withFailover<T>(op: (s: RpcLike) => Promise<T>, label: string): Promise<T> {
    const n = this.servers.length;
    let lastErr: unknown;
    for (let k = 0; k < n; k++) {
      const idx = (this.current + k) % n;
      try {
        const out = await withTimeout(op(this.servers[idx]!), this.timeoutMs, label);
        this.current = idx; // stick to whichever endpoint just answered
        return out;
      } catch (e) {
        lastErr = e;
        // A logic error would fail the same way everywhere; let the caller handle
        // it rather than burning the other endpoints on it.
        if (!isTransient(e)) throw e;
        const more = k + 1 < n;
        process.stderr.write(
          `[rpc] ${label} failed on ${this.urls[idx] ?? `#${idx}`}: ${message(e)}; ${
            more ? "failing over" : "no more endpoints"
          }\n`,
        );
      }
    }
    throw lastErr;
  }
}
