// The archive client, and the hybrid read path. INDEXER.md section 1 and 7.
//
// RPC owns the recent tail: low latency, and it sees a just-submitted
// transaction immediately. The archive serves everything older than the RPC
// retention floor, which is 120,960 ledgers and NOT a duration.
//
// Two failure modes the seam must handle, and both are silent if ignored:
//
//   1. If a configured archive fails, the client MUST NOT fall back to
//      RPC-only, and MUST NOT persist a sync position from the RPC leg.
//      Persisting it makes the skipped range's openings UNRECOVERABLE, because
//      those ledgers will age out of RPC and nothing else holds them.
//   2. The retention floor ADVANCES while a request is in flight. The seam must
//      sit strictly above it by a margin, with disjoint ranges and dedup at the
//      boundary.
import type { StoredEvent } from "./archive-types";
import { deadlineSignal, SERVICE_HTTP_TIMEOUT_MS } from "./http";

/** Margin above the RPC floor, so the floor advancing mid-request cannot open a gap. */
export const SEAM_MARGIN_LEDGERS = 1_000;

export interface ArchivePage {
  events: StoredEvent[];
  from_ledger: number;
  to_ledger: number;
  cursor: string | null;
  complete: boolean;
}

export interface ArchiveHealth {
  contract_id: string;
  latest_ledger: number | null;
  ingested_through: number | null;
  lag_seconds: number | null;
}

export class ArchiveUnavailableError extends Error {
  constructor(cause: string) {
    super(
      `The event archive is unavailable (${cause}). Pocket will not fall back to the ` +
        `recent-history-only view: doing so would skip older events permanently.`,
    );
    this.name = "ArchiveUnavailableError";
  }
}

export class IncompleteHistoryError extends Error {
  constructor(from: number, to: number) {
    super(
      `The archive cannot vouch for ledgers ${from} to ${to}. Balances rebuilt from an ` +
        `incomplete history could be wrong, so Pocket will not spend from them.`,
    );
    this.name = "IncompleteHistoryError";
  }
}

export class ArchiveClient {
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    opts: { timeoutMs?: number } = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? SERVICE_HTTP_TIMEOUT_MS;
  }

  async health(contractId: string): Promise<ArchiveHealth> {
    return parseHealth(await this.get(`/v1/health?contract_id=${encodeURIComponent(contractId)}`));
  }

  /**
   * One page of an account's history, or a refusal.
   *
   * Refusing is the point. The archive answers about the window that was
   * REQUESTED and lets `complete` go false rather than quietly narrowing the
   * window and calling that complete, so a client which reads the events and
   * ignores the flag inherits a gap it cannot see. There is no flag to bypass
   * this check: a caller who could opt out is a caller who will, and the cost
   * is openings that can never be rebuilt.
   */
  async events(
    contractId: string,
    account: string,
    opts: { fromLedger?: number; toLedger?: number; cursor?: string; limit?: number } = {},
  ): Promise<ArchivePage> {
    const q = new URLSearchParams();
    if (opts.fromLedger !== undefined) q.set("from_ledger", String(opts.fromLedger));
    if (opts.toLedger !== undefined) q.set("to_ledger", String(opts.toLedger));
    if (opts.cursor) q.set("cursor", opts.cursor);
    if (opts.limit) q.set("limit", String(opts.limit));
    const page = parsePage(
      await this.get(
        `/v1/tokens/${encodeURIComponent(contractId)}/accounts/${encodeURIComponent(account)}/events?${q}`,
      ),
    );

    if (!page.complete) throw new IncompleteHistoryError(page.from_ledger, page.to_ledger);
    // Belt and braces against an archive that reports a window narrower than
    // the one asked about while still claiming completeness. `complete: true`
    // about ledgers 900000-900010 is a true statement about a question nobody
    // asked, and reading the flag alone would accept it.
    if (opts.fromLedger !== undefined && page.from_ledger > opts.fromLedger) {
      throw new IncompleteHistoryError(opts.fromLedger, page.from_ledger);
    }
    if (opts.toLedger !== undefined && page.to_ledger < opts.toLedger) {
      throw new IncompleteHistoryError(page.to_ledger, opts.toLedger);
    }
    return page;
  }

  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { signal: deadlineSignal(this.timeoutMs) });
    } catch (e) {
      // An abort here is the deadline, not the user: nothing else cancels it.
      const why =
        e instanceof Error
          ? e.name === "TimeoutError" || e.name === "AbortError"
            ? `no answer within ${this.timeoutMs / 1000}s`
            : e.message
          : "network error";
      throw new ArchiveUnavailableError(why);
    }
    if (!res.ok) throw new ArchiveUnavailableError(`HTTP ${res.status}`);
    try {
      return await res.json();
    } catch {
      // A captive portal, a proxy error page or a truncated body all land here
      // with a 200. Left unwrapped this escaped as a bare SyntaxError, missed
      // the error allowlist, and the user was told to check their connection
      // instead of being told the archive could not be trusted.
      throw new ArchiveUnavailableError("the response was not valid JSON");
    }
  }
}

/** A number the archive is allowed to omit only by saying so with null. */
function optionalLedger(v: unknown, field: string): number | null {
  if (v === null) return null;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  throw new ArchiveUnavailableError(`${field} was missing or not a number`);
}

/**
 * Read a health report, refusing to invent the fields it omits.
 *
 * An absent `ingested_through` must not read as zero or as "fine": it decides
 * whether the archive can be trusted below the seam.
 */
export function parseHealth(raw: unknown): ArchiveHealth {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object")
    throw new ArchiveUnavailableError("the response was not an object");
  if (typeof o.contract_id !== "string") {
    throw new ArchiveUnavailableError("contract_id was missing");
  }
  return {
    contract_id: o.contract_id,
    latest_ledger: optionalLedger(o.latest_ledger, "latest_ledger"),
    ingested_through: optionalLedger(o.ingested_through, "ingested_through"),
    lag_seconds: optionalLedger(o.lag_seconds, "lag_seconds"),
  };
}

/**
 * Read a page, refusing to default anything.
 *
 * `complete` in particular: absent means the server did not answer the question
 * completeness asks, and treating that as true is the single mistake that makes
 * a gap unrecoverable.
 */
export function parsePage(raw: unknown): ArchivePage {
  const o = raw as Record<string, unknown> | null;
  if (!o || typeof o !== "object")
    throw new ArchiveUnavailableError("the response was not an object");
  if (!Array.isArray(o.events))
    throw new ArchiveUnavailableError("events was missing or not a list");
  if (typeof o.complete !== "boolean") {
    throw new ArchiveUnavailableError("the completeness flag was missing");
  }
  if (o.cursor !== null && typeof o.cursor !== "string") {
    throw new ArchiveUnavailableError("cursor was neither a string nor null");
  }
  const from = optionalLedger(o.from_ledger, "from_ledger");
  const to = optionalLedger(o.to_ledger, "to_ledger");
  if (from === null || to === null) {
    throw new ArchiveUnavailableError("the covered window was not reported");
  }
  return {
    events: o.events as StoredEvent[],
    from_ledger: from,
    to_ledger: to,
    cursor: o.cursor,
    complete: o.complete,
  };
}

/**
 * Where the archive's responsibility ends and RPC's begins.
 *
 * Set strictly above the RPC floor by a margin: the floor advances as ledgers
 * close, so a seam placed exactly at it can be underneath the floor by the time
 * the second request lands, leaving a range neither source covers.
 */
export function computeSeam(rpcOldestLedger: number): number {
  return rpcOldestLedger + SEAM_MARGIN_LEDGERS;
}

/**
 * Can the archive be trusted for everything below the seam?
 *
 * If it has not ingested through the seam, the crossing range belongs to
 * neither source and the client MUST treat it as incomplete rather than
 * stitching over the hole.
 */
export function archiveCoversSeam(health: ArchiveHealth, seam: number): boolean {
  return health.ingested_through !== null && health.ingested_through >= seam;
}
