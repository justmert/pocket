// StellarExpert asset directory, for the "add an asset" search.
//
// A keyless, read-only search over the network's classic assets, so the manage-
// assets screen can offer a real "powered by stellar.expert" search rather than a
// hardcoded list. It returns only the fields the UI needs to show and to build a
// trustline: the code, the issuer, the home domain, and the directory's rating.
//
// It deliberately drops pure Soroban/contract assets (a bare `C...` with no
// classic issuer): a changeTrust trustline only exists for a classic asset, so a
// contract-only token is not addable here and would mislead if shown.
import { deadlineSignal, SERVICE_HTTP_TIMEOUT_MS } from "../chain/http";

/** StellarExpert uses "public" for mainnet; the rest of Pocket says "mainnet". */
export type ExpertNetwork = "testnet" | "public";

export interface StellarExpertConfig {
  /** e.g. https://api.stellar.expert */
  baseUrl: string;
  network: ExpertNetwork;
  timeoutMs?: number;
}

/** One classic asset the user could open a trustline for. */
export interface AssetSearchResult {
  code: string;
  issuer: string;
  /** The issuer's home domain, when the directory knows it. */
  domain?: string;
  /** StellarExpert's rating average, 0..5, a quality/verification signal. */
  rating?: number;
  /** How many accounts already trust it, a popularity signal. */
  trustlines?: number;
}

export class StellarExpertError extends Error {
  override readonly name = "StellarExpertError";
}

/** A valid classic issuer: a G-address. */
const ISSUER_RE = /^G[A-Z2-7]{55}$/;

export class StellarExpertClient {
  constructor(private readonly cfg: StellarExpertConfig) {}

  async searchAssets(query: string, limit = 15): Promise<AssetSearchResult[]> {
    const q = query.trim();
    if (!q) return [];
    const url =
      `${this.cfg.baseUrl}/explorer/${this.cfg.network}/asset` +
      `?search=${encodeURIComponent(q)}&limit=${limit}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "GET",
        signal: deadlineSignal(this.cfg.timeoutMs ?? SERVICE_HTTP_TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
    } catch (e) {
      const why =
        e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")
          ? "the search timed out"
          : "the search could not be reached";
      throw new StellarExpertError(`Could not search the asset directory (${why}).`);
    }
    if (!res.ok) {
      throw new StellarExpertError(`The asset directory returned ${res.status}.`);
    }
    let body: { _embedded?: { records?: unknown } };
    try {
      body = (await res.json()) as { _embedded?: { records?: unknown } };
    } catch {
      throw new StellarExpertError("The asset directory sent a response Pocket could not read.");
    }
    const records = body._embedded?.records;
    if (!Array.isArray(records)) return [];
    const out: AssetSearchResult[] = [];
    for (const r of records as Record<string, unknown>[]) {
      // `asset` is "CODE-ISSUER-TYPE" for a classic asset; a contract-only token
      // is a bare "C..." with no classic issuer, and cannot be trusted here.
      const a = typeof r.asset === "string" ? r.asset : "";
      const parts = a.split("-");
      if (parts.length < 2) continue;
      const [code, issuer] = parts;
      if (!code || !issuer || !ISSUER_RE.test(issuer)) continue;
      const rating =
        typeof r.rating === "object" && r.rating !== null
          ? (r.rating as { average?: unknown }).average
          : undefined;
      out.push({
        code,
        issuer,
        domain: typeof r.domain === "string" ? r.domain : undefined,
        rating: typeof rating === "number" ? rating : undefined,
        trustlines: typeof r.trustlines === "number" ? r.trustlines : undefined,
      });
    }
    return out;
  }
}
