// An archived instance entry is archived, not absent.
//
// The two states read completely differently to a user and to an operator:
// "absent" is a misconfiguration, a contract id pointing at nothing, and
// "archived" is a live deployment whose entry needs restoring. The verifier's
// own status is read this way, and `check-infrastructure.sh` exists because of
// it.
//
// `!entry?.liveUntilLedgerSeq` collapsed them: an archived entry comes back
// with `liveUntilLedgerSeq: 0`, zero is falsy, so the one state the function
// exists to detect was reported as "there is no such contract". Measured
// against the live chain at latestLedger 4036999: `getLedgerEntries` returns
// the archived entry rather than omitting it, 3 of 3 keys asked for.
import { describe, it, expect } from "vitest";
import { readInstanceTtl } from "./ttl";
import type { rpc } from "@stellar/stellar-sdk";

const CONTRACT = "CBIS5TEMTNNOTBE3WXPQUAGUEDYZZVIWAKTXEQCOUJ34OJJ3FJ5NLF2P";
const LATEST = 4_036_999;

/** An RPC answering with exactly the entries given. */
function rpcWith(entries: { liveUntilLedgerSeq?: number }[]): rpc.Server {
  const answer = async () => ({ entries, latestLedger: LATEST });
  return { getLedgerEntries: answer, _getLedgerEntries: answer } as unknown as rpc.Server;
}

describe("reading a contract's instance TTL", () => {
  it("says archived for an entry the chain returns with liveUntil 0", async () => {
    // The exact shape measured on chain.
    const status = await readInstanceTtl(rpcWith([{ liveUntilLedgerSeq: 0 }]), CONTRACT, "testnet");
    expect(status.kind, "an archived deployment reported as a missing one").toBe("archived");
  });

  it("says archived for an entry whose liveUntil has merely passed", async () => {
    const status = await readInstanceTtl(
      rpcWith([{ liveUntilLedgerSeq: LATEST - 1 }]),
      CONTRACT,
      "testnet",
    );
    expect(status.kind).toBe("archived");
  });

  it("still says absent when there is genuinely no entry", async () => {
    const status = await readInstanceTtl(rpcWith([]), CONTRACT, "testnet");
    expect(status.kind).toBe("absent");
  });

  it("reports a live entry with the time it has left", async () => {
    // The control. 100,000 ledgers at the measured 5.01s each is about 5.8 days.
    const status = await readInstanceTtl(
      rpcWith([{ liveUntilLedgerSeq: LATEST + 100_000 }]),
      CONTRACT,
      "testnet",
    );
    expect(status.kind).toBe("expiring");
    if (status.kind === "expiring") expect(status.daysRemaining).toBeCloseTo(5.8, 1);
  });
});
