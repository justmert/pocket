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
    // A wallet may be served from an extension origin.
    "access-control-allow-origin": "*",
  });
  res.end(payload);
};

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
        const at = url.searchParams.get("at_ledger");
        return json(res, 200, latestCheckpoint(db, contract, account, at ? Number(at) : undefined));
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
    // Never leak an internal message: this service sees only public event data,
    // but the habit matters and a stack trace helps nobody outside.
    json(res, 500, { error: "internal error" });
    process.stderr.write(`${String(e)}\n`);
  }
});

function numParam(url: URL, name: string): number | undefined {
  const v = url.searchParams.get(name);
  return v === null ? undefined : Number(v);
}

server.listen(PORT, () => {
  process.stdout.write(`pocket archive listening on :${PORT} (db: ${DB_PATH})\n`);
});
