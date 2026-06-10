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
  constructor(private readonly baseUrl: string) {}

  async health(contractId: string): Promise<ArchiveHealth> {
    return this.get(`/v1/health?contract_id=${encodeURIComponent(contractId)}`);
  }

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
    return this.get(
      `/v1/tokens/${encodeURIComponent(contractId)}/accounts/${encodeURIComponent(account)}/events?${q}`,
    );
  }

  private async get<T>(path: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`);
    } catch (e) {
      throw new ArchiveUnavailableError(e instanceof Error ? e.message : "network error");
    }
    if (!res.ok) throw new ArchiveUnavailableError(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }
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
