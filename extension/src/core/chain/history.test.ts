// Public-pocket history: mapping Horizon payment records into the wallet's own
// entries, the shared merge cursor, and the walk that pages and filters them.
import { describe, it, expect, vi, afterEach } from "vitest";
import { publicHistory, encodeCursor, decodeCursor, beforeCursor, byRecency } from "./history";
import type { HistoryEntry } from "../messages";

const HORIZON = "https://horizon.example";
const ME = "GAME000000000000000000000000000000000000000000000000ME";
const THEM = "GATHEM00000000000000000000000000000000000000000000THEM";
const TOKEN = "CTOKEN0000000000000000000000000000000000000000000TOKEN";

interface Rec {
  id: string;
  paging_token?: string;
  type: string;
  created_at: string;
  transaction_hash: string;
  from?: string;
  to?: string;
  amount?: string;
  asset_type?: string;
  asset_code?: string;
  source_amount?: string;
  asset_issuer?: string;
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  account?: string;
  funder?: string;
  starting_balance?: string;
  // invoke_host_function: the contract invoked, and the balance movements it
  // caused. Shape taken verbatim from a live testnet record.
  address?: string;
  asset_balance_changes?: {
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
    type?: string;
    from?: string;
    to?: string;
    amount?: string;
  }[];
}

/** Serve fixed pages of records in order, ignoring the URL. */
function stubHorizon(...pages: Rec[][]) {
  let call = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({ _embedded: { records: pages[call++] ?? [] } }),
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

async function history(before: { at: number; id: string } | null = null, limit = 30) {
  return publicHistory({
    horizonUrl: HORIZON,
    account: ME,
    excludeCounterparties: [TOKEN],
    before,
    limit,
  });
}

const AUG1 = "2026-08-01T00:00:00Z";
const ms = (iso: string) => Date.parse(iso);

describe("mapping Horizon records", () => {
  it("reads a received payment as receive in, with the sender and amount", async () => {
    stubHorizon([
      {
        id: "9",
        paging_token: "9",
        type: "payment",
        created_at: AUG1,
        transaction_hash: "tx9",
        from: THEM,
        to: ME,
        amount: "12.5000000",
        asset_type: "native",
      },
    ]);
    const { entries } = await history();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual<HistoryEntry>({
      id: "tx9:9",
      pocket: "public",
      kind: "receive",
      direction: "in",
      code: "XLM",
      amount: "12.5000000",
      counterparty: THEM,
      at: ms(AUG1),
      hash: "tx9",
    });
  });

  it("keeps the issuer, so two assets sharing a code are not one row", async () => {
    // A code alone does not identify an asset: anyone can issue one called
    // USDC. Horizon supplies the issuer on every record and it was decoded and
    // dropped, so two different tokens rendered identically and the logo lookup
    // (keyed CODE:ISSUER) missed every credit asset.
    stubHorizon([
      {
        id: "20",
        type: "payment",
        created_at: AUG1,
        transaction_hash: "tx20",
        from: THEM,
        to: ME,
        amount: "5.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      },
    ]);
    const { entries } = await history();
    expect(entries[0]).toMatchObject({
      code: "USDC",
      issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
    });
  });

  it("leaves native without an issuer, because it has none", async () => {
    stubHorizon([
      {
        id: "21",
        type: "payment",
        created_at: AUG1,
        transaction_hash: "tx21",
        from: THEM,
        to: ME,
        amount: "1.0000000",
        asset_type: "native",
      },
    ]);
    expect((await history()).entries[0]!.issuer).toBeUndefined();
  });

  it("reads a sent payment as send out, to the recipient", async () => {
    stubHorizon([
      {
        id: "8",
        type: "payment",
        created_at: AUG1,
        transaction_hash: "tx8",
        from: ME,
        to: THEM,
        amount: "3.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
      },
    ]);
    const { entries } = await history();
    expect(entries[0]).toMatchObject({
      kind: "send",
      direction: "out",
      code: "USDC",
      amount: "3.0000000",
      counterparty: THEM,
    });
  });

  it("reads the account's own creation as its first funding", async () => {
    stubHorizon([
      {
        id: "1",
        type: "create_account",
        created_at: AUG1,
        transaction_hash: "tx1",
        account: ME,
        funder: THEM,
        starting_balance: "100.0000000",
      },
    ]);
    const { entries } = await history();
    expect(entries[0]).toMatchObject({
      kind: "create",
      direction: "in",
      code: "XLM",
      amount: "100.0000000",
      counterparty: THEM,
    });
  });

  it("uses the source asset and amount for a path payment the account sent", async () => {
    stubHorizon([
      {
        id: "7",
        type: "path_payment_strict_send",
        created_at: AUG1,
        transaction_hash: "tx7",
        from: ME,
        to: THEM,
        amount: "9.9999999",
        asset_type: "native",
        source_amount: "1.0000000",
        source_asset_type: "credit_alphanum4",
        source_asset_code: "USDC",
      },
    ]);
    const { entries } = await history();
    expect(entries[0]).toMatchObject({ kind: "send", code: "USDC", amount: "1.0000000" });
  });

  it("skips a payment the account is not party to", async () => {
    stubHorizon([
      {
        id: "6",
        type: "payment",
        created_at: AUG1,
        transaction_hash: "tx6",
        from: THEM,
        to: TOKEN,
        amount: "1",
        asset_type: "native",
      },
    ]);
    expect((await history()).entries).toEqual([]);
  });

  it("excludes the confidential deposit/withdraw leg, shown from the private side", async () => {
    stubHorizon([
      {
        id: "5",
        type: "payment",
        created_at: AUG1,
        transaction_hash: "tx5",
        from: ME,
        to: TOKEN,
        amount: "5",
        asset_type: "native",
      },
    ]);
    expect((await history()).entries).toEqual([]);
  });
});

/**
 * Soroban calls. Every in-app swap, yield move and CCTP leg is one of these, and
 * none of them appeared in history at all: `invoke_host_function` carries no
 * top-level from/to/amount, so it fell past every branch and returned null. The
 * record shape below is taken verbatim from a live testnet response, including
 * the fact that a SAC transfer names a contract on the far side.
 */
describe("value moved by a contract call", () => {
  const ROUTER = "CROUTER000000000000000000000000000000000000000000ROUTER";
  const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  it("reads what the account paid into a contract as a send", async () => {
    stubHorizon([
      {
        id: "10",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx10",
        address: ROUTER,
        asset_balance_changes: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: USDC_ISSUER,
            type: "transfer",
            from: ME,
            to: ROUTER,
            amount: "1.2345670",
          },
          // The contract's own follow-on movement. Not this account's money.
          { asset_type: "credit_alphanum4", asset_code: "USDC", type: "burn", from: ROUTER },
        ],
      },
    ]);
    const { entries } = await history();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "send",
      direction: "out",
      code: "USDC",
      amount: "1.2345670",
      counterparty: ROUTER,
      hash: "tx10",
    });
  });

  it("gives a swap both of its legs, because both are the account's money", async () => {
    stubHorizon([
      {
        id: "11",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx11",
        address: ROUTER,
        asset_balance_changes: [
          { asset_type: "native", type: "transfer", from: ME, to: ROUTER, amount: "100.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            type: "transfer",
            from: ROUTER,
            to: ME,
            amount: "24.5000000",
          },
        ],
      },
    ]);
    const { entries } = await history();
    expect(entries).toHaveLength(2);
    // Both legs are labelled `swap`, because they are one event. Each still
    // states its own asset, amount and direction, which is what makes the pair
    // readable as an exchange rather than as two unrelated movements.
    expect(entries.map((e) => [e.kind, e.direction, e.code, e.amount])).toEqual([
      ["swap", "out", "XLM", "100.0000000"],
      ["swap", "in", "USDC", "24.5000000"],
    ]);
    // Two entries from one operation must not collide, or pagination and the
    // in-flight reconciliation both key on a duplicate.
    expect(new Set(entries.map((e) => e.id)).size).toBe(2);
  });

  it("does not call a same-asset round trip a swap", async () => {
    // Value left and value arrived, but nothing was exchanged. Calling this a
    // swap would put a word on screen the movements do not support, so it stays
    // the most the wallet can honestly say: it sent, and it received.
    stubHorizon([
      {
        id: "16",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx16",
        address: ROUTER,
        asset_balance_changes: [
          { asset_type: "native", type: "transfer", from: ME, to: ROUTER, amount: "10.0000000" },
          { asset_type: "native", type: "transfer", from: ROUTER, to: ME, amount: "9.0000000" },
        ],
      },
    ]);
    const { entries } = await history();
    expect(entries.map((e) => e.kind)).toEqual(["send", "receive"]);
  });

  it("does not call a one-legged call a swap", async () => {
    // A yield deposit and a CCTP burn are both one-way. There is no second
    // asset, so there is nothing to have exchanged it for.
    stubHorizon([
      {
        id: "17",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx17",
        address: ROUTER,
        asset_balance_changes: [
          { asset_type: "native", type: "transfer", from: ME, to: ROUTER, amount: "10.0000000" },
        ],
      },
    ]);
    expect((await history()).entries.map((e) => e.kind)).toEqual(["send"]);
  });

  it("names the invoked contract when a mint has no counterparty of its own", async () => {
    // A CCTP claim arrives as a mint: there is no `from`, so without a fallback
    // the row renders "Received from " with nothing after it.
    stubHorizon([
      {
        id: "12",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx12",
        address: ROUTER,
        asset_balance_changes: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            type: "mint",
            to: ME,
            amount: "9.0000000",
          },
        ],
      },
    ]);
    const { entries } = await history();
    expect(entries[0]).toMatchObject({ kind: "receive", direction: "in", counterparty: ROUTER });
  });

  it("still excludes a confidential wrapper's leg, now that one can reach here", async () => {
    // A shield is an invocation whose balance change names the wrapper. The
    // exclusion could never fire on a classic payment, because those name
    // G-addresses and the excluded ids are contracts. Without it a shield would
    // appear once in each pocket.
    stubHorizon([
      {
        id: "13",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx13",
        address: TOKEN,
        asset_balance_changes: [
          { asset_type: "native", type: "transfer", from: ME, to: TOKEN, amount: "5.0000000" },
        ],
      },
    ]);
    expect((await history()).entries).toEqual([]);
  });

  it("ignores a call that moved nobody's balance, and one that moved somebody else's", async () => {
    stubHorizon([
      {
        id: "14",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx14",
        address: ROUTER,
      },
      {
        id: "15",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx15",
        address: ROUTER,
        asset_balance_changes: [
          { asset_type: "native", type: "transfer", from: THEM, to: ROUTER, amount: "1.0000000" },
        ],
      },
    ]);
    expect((await history()).entries).toEqual([]);
  });
});

describe("the merge cursor and the walk", () => {
  it("returns only entries strictly older than the cursor", async () => {
    const newer = "2026-08-03T00:00:00Z";
    const older = "2026-08-01T00:00:00Z";
    stubHorizon([
      {
        id: "20",
        type: "payment",
        created_at: newer,
        transaction_hash: "txN",
        from: THEM,
        to: ME,
        amount: "1",
        asset_type: "native",
      },
      {
        id: "10",
        type: "payment",
        created_at: older,
        transaction_hash: "txO",
        from: THEM,
        to: ME,
        amount: "2",
        asset_type: "native",
      },
    ]);
    const { entries } = await history({ at: ms(newer), id: "txN:20" });
    expect(entries.map((e) => e.id)).toEqual(["txO:10"]);
  });

  it("reports more when a page fills the limit", async () => {
    const recs: Rec[] = Array.from({ length: 50 }, (_, i) => ({
      id: String(1000 - i),
      paging_token: String(1000 - i),
      type: "payment",
      created_at: AUG1,
      transaction_hash: `tx${1000 - i}`,
      from: THEM,
      to: ME,
      amount: "1",
      asset_type: "native",
    }));
    stubHorizon(recs, []);
    const { entries, more } = await history(null, 5);
    expect(entries).toHaveLength(5);
    expect(more).toBe(true);
  });

  it("reports no more when Horizon is exhausted within the limit", async () => {
    stubHorizon([
      {
        id: "2",
        type: "payment",
        created_at: AUG1,
        transaction_hash: "tx2",
        from: THEM,
        to: ME,
        amount: "1",
        asset_type: "native",
      },
    ]);
    const { more } = await history(null, 5);
    expect(more).toBe(false);
  });
});

describe("cursor helpers", () => {
  it("round-trips a cursor", () => {
    const c = { at: 1_700_000_000_000, id: "tx:42" };
    expect(decodeCursor(encodeCursor(c))).toEqual(c);
  });

  it("reads a missing or malformed cursor as the top of the list", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("not base64 json")).toBeNull();
    expect(decodeCursor(Buffer.from('{"at":"nope"}').toString("base64"))).toBeNull();
  });

  it("orders newest first with a stable id tiebreak", () => {
    const a = { at: 2, id: "b" } as HistoryEntry;
    const b = { at: 2, id: "a" } as HistoryEntry;
    const c = { at: 1, id: "z" } as HistoryEntry;
    expect([c, b, a].sort(byRecency).map((e) => `${e.at}${e.id}`)).toEqual(["2b", "2a", "1z"]);
  });

  it("compares strictly-before in the same order the sort uses", () => {
    expect(beforeCursor(1, "z", { at: 2, id: "a" })).toBe(true);
    expect(beforeCursor(2, "a", { at: 2, id: "b" })).toBe(true);
    expect(beforeCursor(2, "b", { at: 2, id: "b" })).toBe(false);
    expect(beforeCursor(3, "a", { at: 2, id: "z" })).toBe(false);
    expect(beforeCursor(1, "a", null)).toBe(true);
  });
});
