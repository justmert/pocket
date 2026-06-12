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

describe("live events from our deployment", () => {
  it("finds our Register, Deposit, Merge and Transfer events", async () => {
    const latest = await server.getLatestLedger();
    // Our deployment is minutes old, so a short window covers all of it.
    const res = await server.getEvents({
      startLedger: Math.max(latest.sequence - 2000, 1),
      filters: [{ type: "contract", contractIds: [dep.token] }],
      limit: 200,
    });

    const names = res.events
      .map((e) => {
        try {
          return scValToNative(e.topic[0] as xdr.ScVal) as string;
        } catch {
          return "?";
        }
      })
      .filter(Boolean);

    // At minimum the flows we actually ran must be present.
    for (const expected of ["register", "deposit", "merge", "transfer"]) {
      expect(names, `expected a ${expected} event`).toContain(expected);
    }
  }, 60_000);

  it("carries the fields a checkpoint replay needs", async () => {
    const latest = await server.getLatestLedger();
    const res = await server.getEvents({
      startLedger: Math.max(latest.sequence - 2000, 1),
      filters: [{ type: "contract", contractIds: [dep.token] }],
      limit: 200,
    });

    const transfer = res.events.find((e) => {
      try {
        return scValToNative(e.topic[0] as xdr.ScVal) === "transfer";
      } catch {
        return false;
      }
    });
    expect(transfer, "a transfer event must exist").toBeDefined();

    const body = scValToNative(transfer!.value) as Record<string, unknown>;
    // These are exactly what openCheckpoint and decryptIncomingTransfer read.
    for (const field of ["r_e_point", "v_tilde", "sigma", "b_tilde"]) {
      expect(body, `transfer event must carry ${field}`).toHaveProperty(field);
    }
    // And every amount is an opaque field element, never a number.
    expect(typeof body.v_tilde).not.toBe("number");
  }, 60_000);

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
