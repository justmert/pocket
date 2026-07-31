// A failed transaction is a thing that happened.
//
// Horizon's `/payments` defaults `include_failed` to false, and the only
// history URL the wallet had did not ask for it. So a payment that was included
// and reverted -- fee charged, sequence number consumed, nothing moved --
// appeared nowhere in Activity at all.
//
// Measured on a live account: the exact URL the wallet built returned 50
// records with 0 failed; the same URL with the flag returned 50 records, all 50
// of them failed. The wallet's whole answer to "did that go through" is this
// list, and an absence read as "it never happened" is the reading that invites
// the resend.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { publicHistory } from "./history";

const ME = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";
const THEM = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

/** Every URL the reader asked for, so the query itself can be asserted. */
let asked: string[] = [];
/** The records Horizon answers with. */
let records: Record<string, unknown>[] = [];

beforeEach(() => {
  asked = [];
  records = [];
  vi.stubGlobal("fetch", (async (url: string) => {
    asked.push(String(url));
    return {
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { records } }),
    };
  }) as unknown as typeof fetch);
});

function payment(successful: boolean) {
  return {
    id: "op-1",
    paging_token: "tok-1",
    transaction_hash: "h".repeat(64),
    created_at: "2026-08-08T10:00:00Z",
    type: "payment",
    from: ME,
    to: THEM,
    amount: "5.0000000",
    asset_type: "native",
    transaction_successful: successful,
    transaction: { fee_charged: "100", source_account: ME },
  };
}

const read = () =>
  publicHistory({
    horizonUrl: "https://horizon.invalid",
    account: ME,
    before: null,
    limit: 30,
  });

describe("the account's public history", () => {
  it("asks Horizon for failed transactions too", async () => {
    records = [payment(true)];
    await read();
    expect(asked[0], "Horizon defaults include_failed to false").toContain("include_failed=true");
  });

  it("shows a failed payment rather than omitting it", async () => {
    records = [payment(false)];
    const { entries } = await read();
    expect(entries, "a failed payment is missing from history entirely").toHaveLength(1);
  });

  it("marks it as failed, so it does not read as a payment that went through", async () => {
    records = [payment(false)];
    const { entries } = await read();
    expect(entries[0]!.failed).toBe(true);
    expect(entries[0]!.failureReason).toMatch(/failed on the network/i);
  });

  it("says nothing moved, because nothing did", async () => {
    records = [payment(false)];
    const { entries } = await read();
    expect(entries[0]!.failureReason).toMatch(/nothing moved/i);
  });

  it("leaves a successful payment unmarked", async () => {
    records = [payment(true)];
    const { entries } = await read();
    expect(entries[0]!.failed).toBeUndefined();
  });

  it("still charges the fee to the account that paid it", async () => {
    // A failed transaction's fee is real, and it is the whole cost of the
    // failure. Dropping it would understate what the row cost.
    records = [payment(false)];
    const { entries } = await read();
    expect(entries[0]!.fee).toBe("0.0000100");
  });
});
