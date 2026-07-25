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

describe("movements the history used to lose", () => {
  /** A path payment where this account is both ends: a classic-DEX swap. */
  function selfSwap() {
    return {
      id: "9",
      paging_token: "9",
      type: "path_payment_strict_send",
      transaction_hash: "b".repeat(64),
      created_at: "2026-08-09T00:00:00Z",
      from: ME,
      to: ME,
      amount: "50.0000000",
      asset_type: "credit_alphanum4",
      asset_code: "USDC",
      asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      source_amount: "10.0000000",
      source_asset_type: "native",
      transaction: { fee_charged: "100", source_account: ME },
    };
  }

  it("shows both legs of a swap the account made with itself", async () => {
    // `toMe` was tested first and returned immediately, so the row said only
    // what arrived and the asset that LEFT was invisible: a swap rendered as a
    // gift.
    const page = await historyOf([selfSwap()]);
    expect(page.entries).toHaveLength(2);
    expect(page.entries.map((e) => e.direction).sort()).toEqual(["in", "out"]);
    expect(page.entries.find((e) => e.direction === "out")?.code).toBe("XLM");
    expect(page.entries.find((e) => e.direction === "in")?.code).toBe("USDC");
  });

  it("stops before a swap that will not fit, rather than keeping half of it", async () => {
    // The case that actually distinguishes the two behaviours: the page is
    // already part full when the swap arrives. Without the fix the limit is
    // checked BETWEEN the swap's two halves, so the page ends
    // [payment, swap-in] and the swap-out is dropped; the next page resumes
    // from the swap record's paging token, which is now behind the cursor, so
    // that half is never fetched again.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        _embedded: { records: [record({ from: THEM, to: ME, payer: THEM }), selfSwap()] },
      }),
    })) as unknown as typeof fetch;
    try {
      const { publicHistory } = await import("./history");
      const page = await publicHistory({
        horizonUrl: "https://horizon.invalid",
        account: ME,
        excludeCounterparties: [],
        before: null,
        limit: 2,
      });
      const swapLegs = page.entries.filter((e) => e.kind === "swap");
      expect(
        swapLegs.length === 0 || swapLegs.length === 2,
        `half a swap was served: ${swapLegs.length} leg(s)`,
      ).toBe(true);
      expect(page.more).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("never splits one record across a page boundary", async () => {
    // The limit was checked BETWEEN a swap's two halves, so a boundary landing
    // there kept one and dropped the other. The next page resumes from the
    // record's paging token, which is now behind the cursor, so the dropped
    // half is never fetched again: one of the two rows disappeared for good and
    // the balance stopped agreeing with the list explaining it.
    const original = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      status: 200,
      json: async () => ({ _embedded: { records: [selfSwap()] } }),
    })) as unknown as typeof fetch;
    try {
      const { publicHistory } = await import("./history");
      const page = await publicHistory({
        horizonUrl: "https://horizon.invalid",
        account: ME,
        excludeCounterparties: [],
        before: null,
        limit: 1,
      });
      // Served whole and over the limit, rather than half a swap.
      expect(page.entries).toHaveLength(2);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("records an account merge paid INTO this account", async () => {
    // The largest single credit an account can receive. It fell off the end of
    // mapPayment, so the balance jumped and Activity said nothing happened.
    const page = await historyOf([
      {
        id: "7",
        paging_token: "7",
        type: "account_merge",
        transaction_hash: "c".repeat(64),
        created_at: "2026-08-09T00:00:00Z",
        account: THEM,
        into: ME,
        transaction: { fee_charged: "100", source_account: THEM },
      },
    ]);
    expect(page.entries).toHaveLength(1);
    expect(page.entries[0]).toMatchObject({ direction: "in", code: "XLM", counterparty: THEM });
  });

  it("records an account merge paid OUT of this account", async () => {
    const page = await historyOf([
      {
        id: "8",
        paging_token: "8",
        type: "account_merge",
        transaction_hash: "d".repeat(64),
        created_at: "2026-08-09T00:00:00Z",
        account: ME,
        into: THEM,
        transaction: { fee_charged: "100", source_account: ME },
      },
    ]);
    expect(page.entries[0]).toMatchObject({ direction: "out", counterparty: THEM });
  });

  it("ignores a merge between two other accounts", async () => {
    const page = await historyOf([
      {
        id: "6",
        paging_token: "6",
        type: "account_merge",
        transaction_hash: "e".repeat(64),
        created_at: "2026-08-09T00:00:00Z",
        account: THEM,
        into: THEM,
        transaction: { fee_charged: "100", source_account: THEM },
      },
    ]);
    expect(page.entries).toEqual([]);
  });
});
