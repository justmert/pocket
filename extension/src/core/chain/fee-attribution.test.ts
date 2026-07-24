// A fee in your history has to be a fee you paid.
//
// `feeOf` read `transaction.fee_charged` from the `?join=transactions` join and
// `mapPayment` attached it to every entry through `base`, in both directions. So
// a payment RECEIVED from someone else showed THAT PERSON's network fee, in a
// row labelled "Onchain fee", against money coming in. Nothing on the screen
// says whose it is, and there is no reading of "Onchain fee" on an incoming
// payment that makes a stranger's fee the right number.
import { describe, it, expect } from "vitest";
import "../../lib/polyfill";
import { publicHistory } from "./history";

const ME = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";
const THEM = "GAKQO2Y5RPBKAVG2PBMLCSG2TFGTED6ERGPOVTOIV54WWC5TRLCZEY6T";

/** One Horizon payment record, with the transaction join attached. */
function record(opts: { from: string; to: string; payer: string }) {
  return {
    id: "1",
    paging_token: "1",
    type: "payment",
    transaction_hash: "a".repeat(64),
    created_at: "2026-08-09T00:00:00Z",
    from: opts.from,
    to: opts.to,
    amount: "10.0000000",
    asset_type: "native",
    transaction: { fee_charged: "100", source_account: opts.payer },
  };
}

async function historyOf(records: unknown[]) {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ _embedded: { records } }),
  })) as unknown as typeof fetch;
  try {
    return await publicHistory({
      horizonUrl: "https://horizon.invalid",
      account: ME,
      excludeCounterparties: [],
      before: null,
      limit: 30,
    });
  } finally {
    globalThis.fetch = original;
  }
}

describe("the fee shown beside a movement", () => {
  it("is shown when this account paid it", async () => {
    // The control. A rule that strips every fee tells the user less than before.
    const page = await historyOf([record({ from: ME, to: THEM, payer: ME })]);
    expect(page.entries[0]?.fee).toBe("0.0000100");
  });

  it("is NOT shown on a payment somebody else sent us", async () => {
    // Their fee, on our incoming row, labelled as an onchain fee.
    const page = await historyOf([record({ from: THEM, to: ME, payer: THEM })]);
    expect(page.entries[0]?.direction).toBe("in");
    expect(page.entries[0]?.fee, "a stranger's fee was shown as ours").toBeUndefined();
  });

  it("is shown on a self-payment, which we did pay for", async () => {
    const page = await historyOf([record({ from: ME, to: ME, payer: ME })]);
    expect(page.entries[0]?.fee).toBe("0.0000100");
  });

  it("is absent when the join did not carry the source account", async () => {
    // Unknown payer is not "us". Guessing would put the number back.
    const r = record({ from: ME, to: THEM, payer: ME });
    const page = await historyOf([{ ...r, transaction: { fee_charged: "100" } }]);
    expect(page.entries[0]?.fee).toBeUndefined();
  });
});
