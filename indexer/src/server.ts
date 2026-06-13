// The archive's HTTP surface. INDEXER.md section 6.
//
// Node's built-in http, no framework: the surface is four routes and adding a
// dependency to a service that must run for years unattended is a poor trade.
import { createServer } from "node:http";
import { open } from "./schema.ts";
import { accountEvents, latestCheckpoint, health } from "./api.ts";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? "pocket-archive.db";
const db = open(DB_PATH);

const json = (res: import("node:http").ServerResponse, code: number, body: unknown) => {
  const payload = JSON.stringify(body, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  res.writeHead(code, {
    "content-type": "application/json",
    // A wallet is served from a chrome-extension:// origin, which cannot be
    // named in an allowlist ahead of time. Every event here is already public
    // on chain, so a wildcard costs no confidentiality.
    //
    // What it does leave open is an unauthenticated per-account query oracle.
    // The events are public, but WHO ASKS ABOUT WHICH ACCOUNT is not, and this
    // service is the one place in the system where that is observable. An
    // operator sees the querying IP alongside the account in the path. That is
    // a deployment concern rather than a wallet one, and the only real
    // mitigations are operator-side: run more than one endpoint so no single
    // operator sees every query, and do not keep access logs.
    "access-control-allow-origin": ALLOWED_ORIGIN,
    // No intermediary should retain a per-account event page. Beyond the
    // privacy of the query itself, a cached page carries a `complete` flag
    // that was true when it was served and may not be now, and a stale
    // completeness claim is the one thing this archive must never emit.
    "cache-control": "no-store",
  });
  res.end(payload);
};

/** A caller error, distinguished from ours so it answers 400 rather than 500. */
export class BadRequestError extends Error {
  override readonly name = "BadRequestError";
}

/** Configurable so an operator can lock it down; wildcard by default. */
const ALLOWED_ORIGIN = process.env.ARCHIVE_ALLOWED_ORIGIN ?? "*";

/** Everything here is a read. Nothing else is answered. */
const READ_METHODS = new Set(["GET", "HEAD"]);

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const p = url.pathname.split("/").filter(Boolean);

  // A preflight, answered before any routing: it asks what is permitted, not
  // for data, so it must not reach a handler.
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": ALLOWED_ORIGIN,
      "access-control-allow-methods": "GET, HEAD, OPTIONS",
      "cache-control": "no-store",
    });
    return res.end();
  }

  // This archive has no write path at all, so a POST reaching a handler could
  // not change anything. It answered one anyway, which advertises a surface
  // that does not exist and invites a caller to build on it. Say no once, here.
  if (!READ_METHODS.has(req.method ?? "")) {
    res.setHeader("allow", "GET, HEAD, OPTIONS");
    return json(res, 405, { error: "method not allowed" });
  }

  try {
    // GET /v1/health?contract_id=C...
    if (p[0] === "v1" && p[1] === "health") {
      const contract = url.searchParams.get("contract_id");
      if (!contract) return json(res, 400, { error: "contract_id is required" });
      return json(res, 200, health(db, contract));
    }

    // GET /v1/tokens/{contract}/accounts/{account}/events
    // GET /v1/tokens/{contract}/accounts/{account}/checkpoint
    if (p[0] === "v1" && p[1] === "tokens" && p[3] === "accounts") {
      const contract = p[2]!;
      const account = p[4]!;

      if (p[5] === "checkpoint") {
        return json(
          res,
          200,
          latestCheckpoint(db, contract, account, numParam(url, "at_ledger")),
        );
      }

      if (p[5] === "events") {
        const types = url.searchParams.get("types")?.split(",").filter(Boolean);
        return json(
          res,
          200,
          accountEvents(db, contract, account, {
            fromLedger: numParam(url, "from_ledger"),
            toLedger: numParam(url, "to_ledger"),
            types,
            cursor: url.searchParams.get("cursor") ?? undefined,
            limit: numParam(url, "limit"),
          }),
        );
      }
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    // A malformed parameter is the caller's error, and saying which one is
    // wrong is useful and leaks nothing: the message is authored here and
    // quotes only what the caller already sent.
    if (e instanceof BadRequestError) return json(res, 400, { error: e.message });
    // Never leak an internal message: this service sees only public event data,
    // but the habit matters and a stack trace helps nobody outside.
    json(res, 500, { error: "internal error" });
    process.stderr.write(`${String(e)}\n`);
  }
});

function numParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  // A malformed value used to become NaN, propagate into from/to, and
  // serialise as null in the response. It failed closed, but it reported a
  // nonsense range while doing so. Refuse it instead of answering about a
  // window that cannot exist.
  if (!Number.isInteger(n) || n < 0) {
    throw new BadRequestError(`${name} must be a non-negative integer, got "${v}"`);
  }
  return n;
}



server.listen(PORT, () => {
  process.stdout.write(`pocket archive listening on :${PORT} (db: ${DB_PATH})\n`);
});
