import { describe, it, expect } from "vitest";
import { IrisClient } from "./iris";
import { CCTP } from "./cctp";

// Hits live Iris (Circle attestation sandbox). An unknown burn tx answers 404,
// which the client must report as not-ready rather than throwing.
describe("live Iris attestation service", () => {
  it("reports not-ready for an unknown burn tx", async () => {
    const client = new IrisClient({ baseUrl: CCTP.testnet.iris });
    const att = await client.attestation(
      6,
      "0000000000000000000000000000000000000000000000000000000000000000",
    );
    expect(att.ready).toBe(false);
    expect(typeof att.status).toBe("string");
  });
});
