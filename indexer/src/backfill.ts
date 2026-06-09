// Backfill runner.
//
// Pulls the full retained RPC window into the archive, then keeps up. Run it
// on a schedule; it is idempotent, so a repeated range costs nothing but time.
//
// The freshness obligation: ingested_through must stay at or above the seam a
// hybrid client sets from the RPC retention floor. If it falls below, a gap
// opens that NEITHER source covers, and once those ledgers age out of RPC it is
// permanent. That is the failure mode this service exists to prevent.
import { rpc } from "@stellar/stellar-sdk";
import { open } from "./schema.ts";
import { ingestRange } from "./ingest.ts";

const RPC_URL = process.env.RPC_URL ?? "https://soroban-testnet.stellar.org";
const CONTRACT = process.env.CONTRACT_ID;
const DB_PATH = process.env.DB_PATH ?? "pocket-archive.db";
/** RPC caps a getEvents query's ledger span; stay well inside it. */
const CHUNK = 10_000;

if (!CONTRACT) {
  process.stderr.write("CONTRACT_ID is required\n");
  process.exit(1);
}

const db = open(DB_PATH);
const server = new rpc.Server(RPC_URL);

const health = await server.getHealth();
const oldest = health.oldestLedger;
const latest = health.latestLedger;
process.stdout.write(
  `RPC retains ${oldest}..${latest} (${latest - oldest} ledgers)\n`,
);

let total = 0;
for (let from = oldest; from <= latest; from += CHUNK) {
  const to = Math.min(from + CHUNK - 1, latest);
  const r = await ingestRange(db, server, CONTRACT, from, to);
  total += r.ingested;
  process.stdout.write(`  ${from}..${to}: ${r.ingested} events\n`);
}
process.stdout.write(`ingested ${total} events for ${CONTRACT}\n`);
