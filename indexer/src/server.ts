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
    // on chain, so a wildcard costs no confidentiality. What it does leave
    // open is an unauthenticated per-account query oracle: see ARCHIVE.md,
    // this is a single-operator deployment concern, not a wallet one.
    "access-control-allow-origin": ALLOWED_ORIGIN,
  });
  res.end(payload);
};

/** A caller error, distinguished from ours so it answers 400 rather than 500. */
export class BadRequestError extends Error {
  override readonly name = "BadRequestError";
}

/** Configurable so an operator can lock it down; wildcard by default. */
const ALLOWED_ORIGIN = process.env.ARCHIVE_ALLOWED_ORIGIN ?? "*";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const p = url.pathname.split("/").filter(Boolean);

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
