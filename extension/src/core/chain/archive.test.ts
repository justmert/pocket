import { describe, it, expect } from "vitest";
import {
  computeSeam,
  archiveCoversSeam,
  ArchiveClient,
  ArchiveUnavailableError,
  SEAM_MARGIN_LEDGERS,
} from "./archive";

describe("the hybrid seam", () => {
  it("sits strictly above the RPC floor", () => {
    // The floor advances as ledgers close. A seam placed exactly at it can be
    // BELOW it by the time a second request lands, leaving a range neither
    // source covers.
    const floor = 3_776_032;
    expect(computeSeam(floor)).toBeGreaterThan(floor);
    expect(computeSeam(floor) - floor).toBe(SEAM_MARGIN_LEDGERS);
  });

  it("keeps a margin wide enough for a slow request", () => {
    // 1000 ledgers is about 83 minutes at 5s each: far longer than any request.
    expect(SEAM_MARGIN_LEDGERS).toBeGreaterThanOrEqual(1000);
  });

  it("refuses to trust an archive that has not reached the seam", () => {
    const seam = 3_777_032;
    expect(
      archiveCoversSeam(
        { contract_id: "C", latest_ledger: 1, ingested_through: seam - 1, lag_seconds: 0 },
        seam,
      ),
    ).toBe(false);
    expect(
      archiveCoversSeam(
        { contract_id: "C", latest_ledger: 1, ingested_through: seam, lag_seconds: 0 },
        seam,
      ),
    ).toBe(true);
  });

  it("treats a never-ingested archive as not covering anything", () => {
    expect(
      archiveCoversSeam(
        { contract_id: "C", latest_ledger: null, ingested_through: null, lag_seconds: null },
        1,
      ),
    ).toBe(false);
  });
});

describe("failing closed", () => {
  it("raises rather than silently degrading to RPC-only", async () => {
    // The dangerous shape: fall back to RPC, persist a cursor from that leg,
    // and the skipped range's openings become UNRECOVERABLE once those ledgers
    // age out of RPC. Nothing else holds them.
    const client = new ArchiveClient("http://127.0.0.1:1");
    await expect(client.health("C")).rejects.toBeInstanceOf(ArchiveUnavailableError);
  });

  it("says explicitly that it will not fall back", async () => {
    const client = new ArchiveClient("http://127.0.0.1:1");
    await expect(client.health("C")).rejects.toThrow(/will not fall back/i);
  });
});
