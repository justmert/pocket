// Backfill runner.
//
// Pulls the full retained RPC window into the archive, then keeps up. Run it
// on a schedule; it is idempotent, so a repeated range costs nothing but time.
//
// The freshness obligation: ingested_through must stay at or above the seam a
// hybrid client sets from the RPC retention floor. If it falls below, a gap
// opens that NEITHER source covers, and once those ledgers age out of RPC it is
// permanent. That is the failure mode this service exists to prevent.
import { open } from "./schema.ts";
import { ingestRange } from "./ingest.ts";
import { ResilientRpc, resolveRpcUrls } from "./rpc.ts";

// Horizon, for the invocation payloads that transfer events do not carry.
// Full history, unlike Soroban RPC, which is the entire reason the archive
// can answer about a transfer that RPC has long since dropped.
const HORIZON_URL = process.env.HORIZON_URL ?? "https://horizon-testnet.stellar.org";
const CONTRACT = process.env.CONTRACT_ID;
const DB_PATH = process.env.DB_PATH ?? "pocket-archive.db";
/** RPC caps a getEvents query's ledger span; stay well inside it. */
const CHUNK = 10_000;

if (!CONTRACT) {
  process.stderr.write("CONTRACT_ID is required\n");
  process.exit(1);
}

const db = open(DB_PATH);
// Ordered endpoints with automatic failover on a transient fault, so one
// provider's bad minute cannot open a permanent gap. See rpc.ts.
const server = ResilientRpc.fromUrls(resolveRpcUrls());
process.stdout.write(`RPC endpoints: ${server.endpoints().join(", ")}\n`);

const health = await server.getHealth();
const oldest = health.oldestLedger;
const latest = health.latestLedger;
process.stdout.write(
  `RPC retains ${oldest}..${latest} (${latest - oldest} ledgers)\n`,
);

// The floor MOVES while this runs, and the run is not short: fetching an
// invocation payload per transfer turns a scan of the retained window into
// minutes. A floor read once at the start is stale by the time the first chunk
// is requested, and the RPC answers a below-floor startLedger with
// `-32600 startLedger must be within the ledger range`, which aborts the whole
// backfill after it has already ingested most of it.
//
// So it is re-read per chunk and the start is clamped. Re-reading costs one
// small call against a scan of ten thousand ledgers.
let total = 0;
let from = oldest;
while (from <= latest) {
  const floor = (await server.getHealth()).oldestLedger;
  if (from < floor) {
    // The window slid past this chunk while earlier chunks were ingesting. The
    // events in the skipped span are gone from RPC and no request can bring
    // them back, so it is reported rather than passed over quietly: `recordRange`
    // never claims it, and the archive keeps calling that span incomplete.
    process.stdout.write(`  ${from}..${floor - 1}: aged out of RPC retention during this run\n`);
    from = floor;
  }
  const to = Math.min(from + CHUNK - 1, latest);
  if (from > to) break;

  // Clamping cannot win this on its own. Testnet closes a ledger every few
  // seconds, so the floor moves BETWEEN the health check and the request it was
  // computed for, and the RPC answers -32600 rather than the nearest valid
  // window. The authority on where the window starts is the RPC, and this is it
  // telling us: re-read, re-clamp, try again.
  let r: Awaited<ReturnType<typeof ingestRange>> | null = null;
  let start = from;
  for (let attempt = 0; attempt < 5 && r === null; attempt++) {
    try {
      r = await ingestRange(db, server, CONTRACT, start, to, HORIZON_URL);
    } catch (e) {
      const moved =
        typeof e === "object" &&
        e !== null &&
        String((e as { message?: unknown }).message ?? e).includes("within the ledger range");
      if (!moved) throw e;
      const now = (await server.getHealth()).oldestLedger;
      process.stdout.write(`  ${start}..${to}: window moved to ${now}, retrying\n`);
      if (now > to) break;
      start = Math.max(start, now);
    }
  }

  // The next chunk begins where THIS one ENDED, never at a fixed stride from
  // where it began. A retry moves the start forward, and striding from a moved
  // start skips exactly as many ledgers as it moved: one retry on the first
  // chunk left ledger 3809400 uningested, a hole of a single ledger at the
  // seam. That is not a rounding error here. `ingested_through` is the
  // contiguous run from the earliest range, so one missing ledger reported the
  // archive as 110,960 ledgers behind, and a wallet reads that as an archive
  // too stale to recover from.
  from = to + 1;
  if (r === null) continue;
  total += r.ingested;
  process.stdout.write(`  ${start}..${to}: ${r.ingested} events\n`);
}
process.stdout.write(`ingested ${total} events for ${CONTRACT}\n`);
