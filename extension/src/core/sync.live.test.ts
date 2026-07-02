import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { scValToNative, xdr } from "@stellar/stellar-sdk/base";
import "../lib/polyfill";
import { NETWORKS } from "./config";

/** Addresses come from the tracked config, never from an untracked file. */
function deployment() {
  const c = NETWORKS.testnet.confidential[0];
  if (!c) throw new Error("no confidential deployment configured for testnet");
  return c;
}

// Reads the REAL events our testnet transactions emitted and checks the sync
// engine's assumptions against them: are the fields we replay from actually
// present, and in the shape we expect?
const dep = deployment();
const server = new rpc.Server(NETWORKS.testnet.rpcUrl);


/**
 * Every event our token emitted that the RPC still holds.
 *
 * NOT `latest - 2000`. That window was written when the deployment was minutes
 * old, and it silently stopped covering the events it was looking for the day
 * after: both assertions below started failing on a wallet that had not
 * changed, because the transfers had aged out of an arbitrary constant rather
 * than out of the RPC.
 *
 * So it asks the RPC where its window starts, which is the same rule
 * `findInbound` follows, and pages to the end. Empty pages in the middle of the
 * stream are normal and are not the end: 38 consecutive empty ones were
 * measured against this deployment before the first of 195 events.
 */
async function allRetainedEvents(): Promise<rpc.Api.EventResponse[]> {
  const health = (await server.getHealth()) as { oldestLedger?: number };
  const latest = await server.getLatestLedger();
  const startLedger =
    typeof health.oldestLedger === "number"
      ? health.oldestLedger
      : Math.max(latest.sequence - 120_960, 1);

  const out: rpc.Api.EventResponse[] = [];
  let cursor: string | undefined;
  // Bounded so a server handing out a fresh cursor forever cannot hang the run.
  for (let page = 0; page < 200; page++) {
    const res = await server.getEvents(
      cursor
        ? { cursor, filters: [{ type: "contract", contractIds: [dep.token] }], limit: 200 }
        : { startLedger, filters: [{ type: "contract", contractIds: [dep.token] }], limit: 200 },
    );
    out.push(...res.events);
    const next = (res as { cursor?: string }).cursor;
    if (!next || next === cursor) break;
    cursor = next;
  }
  return out;
}

/** The event's name, or "?" when it cannot be read. */
function nameOf(e: rpc.Api.EventResponse): string {
  try {
    return scValToNative(e.topic[0] as xdr.ScVal) as string;
  } catch {
    return "?";
  }
}

describe("live events from our deployment", () => {
  it("finds our Register, Deposit, Merge and Transfer events", async () => {
    const names = (await allRetainedEvents()).map(nameOf).filter(Boolean);
    // At minimum the flows we actually ran must be present.
    for (const expected of ["register", "deposit", "merge", "transfer"]) {
      expect(names, `expected a ${expected} event`).toContain(expected);
    }
  }, 180_000);

  it("carries the fields a checkpoint replay needs", async () => {
    const transfer = (await allRetainedEvents()).find((e) => nameOf(e) === "transfer");
    expect(transfer, "a transfer event must exist").toBeDefined();

    const body = scValToNative(transfer!.value) as Record<string, unknown>;
    // These are exactly what openCheckpoint and decryptIncomingTransfer read.
    for (const field of ["r_e_point", "v_tilde", "sigma", "b_tilde"]) {
      expect(body, `transfer event must carry ${field}`).toHaveProperty(field);
    }
    // And every amount is an opaque field element, never a number.
    expect(typeof body.v_tilde).not.toBe("number");
  }, 180_000);

  it("gives every event a canonical position", async () => {
    // Replay is only correct in emission order, and the ordering key is
    // (ledger, tx application order, event index). If the RPC did not expose
    // these, our archive would have to derive them.
    const latest = await server.getLatestLedger();
    const res = await server.getEvents({
      startLedger: Math.max(latest.sequence - 2000, 1),
      filters: [{ type: "contract", contractIds: [dep.token] }],
      limit: 10,
    });
    expect(res.events.length).toBeGreaterThan(0);
    for (const e of res.events) {
      expect(typeof e.ledger).toBe("number");
      expect(e.id).toBeTruthy();
      expect(e.txHash).toBeTruthy();
    }
  }, 60_000);
});
