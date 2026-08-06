// Public-pocket history: mapping Horizon payment records into the wallet's own
// entries, the shared merge cursor, and the walk that pages and filters them.
import { describe, it, expect, vi, afterEach } from "vitest";
import { Address, nativeToScVal } from "@stellar/stellar-sdk/base";
import {
  publicHistory,
  encodeCursor,
  decodeCursor,
  beforeCursor,
  byRecency,
  invokedContract,
} from "./history";
import type { HistoryEntry } from "../messages";

const ISSUER_G = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const HORIZON = "https://horizon.example";
const ME = "GAME000000000000000000000000000000000000000000000000ME";
const THEM = "GATHEM00000000000000000000000000000000000000000000THEM";
// Real contract strkeys: `parameters[0]` is DECODED, so a fixture whose
// contract id is not encodable proves nothing about the live shape.
const TOKEN = "CBRW63TGNFSGK3TUNFQWYLLUN5VWK3RNMZUXQ5DVOJSQAAAAAAAABKFC";

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
  // invoke_host_function: the call's arguments, and the balance movements it
  // caused. Shape taken verbatim from a live testnet record, including the fact
  // that `address` is the EMPTY STRING on every contract call.
  address?: string;
  function?: string;
  parameters?: { value?: string; type?: string }[];
  // joined via ?join=transactions, and present on every real record.
  transaction?: { fee_charged?: string; source_account?: string };
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

/**
 * The `function`/`parameters`/`address` triple Horizon serves for a contract
 * call, built the way Horizon builds it.
 *
 * `address` is "" and NOT the contract: surveyed over 583 consecutive
 * `invoke_host_function` operations on 2026-08-08, it was empty on 569 and the
 * exceptions were CreateContract records carrying a deployer's G-address. The
 * contract is `parameters[0]`, an XDR-encoded ScVal address, with the function
 * symbol at `parameters[1]`. Read verbatim off operation 17257049746350081.
 *
 * The fixtures used to put the contract in `address`, which is a shape the
 * network never produces, and that is why the counterparty fallback below could
 * be dead and green at the same time.
 */
function invoke(contract: string, fn = "swap"): Pick<Rec, "address" | "function" | "parameters"> {
  return {
    address: "",
    function: "HostFunctionTypeHostFunctionTypeInvokeContract",
    parameters: [
      { value: new Address(contract).toScVal().toXDR("base64"), type: "Address" },
      { value: nativeToScVal(fn, { type: "symbol" }).toXDR("base64"), type: "Sym" },
    ],
  };
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

  it("reads funding somebody ELSE's account as XLM leaving this one", async () => {
    // Horizon serves the same record on the funder's own /payments feed, and it
    // was dropped there as "the other account's business". Confirmed live on
    // 2026-08-08: the newest record of
    // GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN is a
    // create_account it funded with 1.2 XLM. That XLM is gone and there was no
    // row for it.
    stubHorizon([
      {
        id: "1b",
        type: "create_account",
        created_at: AUG1,
        transaction_hash: "tx1b",
        account: THEM,
        funder: ME,
        starting_balance: "1.2000000",
      },
    ]);
    const { entries } = await history();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "create",
      direction: "out",
      code: "XLM",
      amount: "1.2000000",
      counterparty: THEM,
    });
  });

  it("still drops a creation this account had no part in", async () => {
    stubHorizon([
      {
        id: "1c",
        type: "create_account",
        created_at: AUG1,
        transaction_hash: "tx1c",
        account: THEM,
        funder: "GSTRANGER000000000000000000000000000000000000STRANGER",
        starting_balance: "5.0000000",
      },
    ]);
    expect((await history()).entries).toEqual([]);
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
  const ROUTER = "CBZG65LUMVZC2ZTJPB2HK4TFAAAAAAAAAAAAAAAAAAAAAAAAAAAABYO7";
  const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

  it("reads what the account paid into a contract as a send", async () => {
    stubHorizon([
      {
        id: "10",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx10",
        ...invoke(ROUTER),
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
        ...invoke(ROUTER),
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
        ...invoke(ROUTER),
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
        ...invoke(ROUTER),
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
        ...invoke(ROUTER),
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
        ...invoke(TOKEN),
        asset_balance_changes: [
          { asset_type: "native", type: "transfer", from: ME, to: TOKEN, amount: "5.0000000" },
        ],
      },
    ]);
    expect((await history()).entries).toEqual([]);
  });

  it("shows an unshield SOMEBODY ELSE made into this account's public address", async () => {
    // Both halves used to drop it. The public side suppressed it as the private
    // pocket's story; the private side (`private-history.ts`, `case "withdraw":
    // if (t[0] !== me) return null`) discarded it as a stranger's event. The
    // XLM landed in the public balance with no row anywhere.
    //
    // Shape from the live chain, transaction
    // a71432fbfc98d6c50290435f1362374b637ea3812bc4347e841e247e04939566
    // (fetched 2026-08-08): one balance change out of the wrapper into this
    // account, and a `source_account` that is the OTHER party.
    stubHorizon([
      {
        id: "18",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx18",
        ...invoke(TOKEN, "withdraw"),
        transaction: { source_account: THEM },
        asset_balance_changes: [
          { asset_type: "native", type: "transfer", from: TOKEN, to: ME, amount: "10.0000000" },
        ],
      },
    ]);
    const { entries } = await history();
    expect(entries, "10 XLM arrived and neither pocket had a row for it").toHaveLength(1);
    expect(entries[0]).toMatchObject({
      kind: "receive",
      direction: "in",
      code: "XLM",
      amount: "10.0000000",
      counterparty: TOKEN,
    });
  });

  it("still hides THIS account's own unshield, which the private side tells", async () => {
    // Byte-identical to the case above apart from who submitted it. That is the
    // whole discriminator, and it is the reason the exclusion cannot simply be
    // dropped: without it an unshield would appear once in each pocket.
    stubHorizon([
      {
        id: "19",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx19",
        ...invoke(TOKEN, "withdraw"),
        transaction: { source_account: ME },
        asset_balance_changes: [
          { asset_type: "native", type: "transfer", from: TOKEN, to: ME, amount: "10.0000000" },
        ],
      },
    ]);
    expect((await history()).entries).toEqual([]);
  });

  it("hides a shield whoever Horizon says submitted it, because only we can debit us", async () => {
    // The outgoing leg is never ambiguous: nobody else can move money out of
    // this account, so it is this account's own shield regardless of the source
    // field, and it must not start showing twice if that field ever goes away.
    stubHorizon([
      {
        id: "20",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx20",
        ...invoke(TOKEN, "deposit"),
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
        ...invoke(ROUTER),
      },
      {
        id: "15",
        type: "invoke_host_function",
        created_at: AUG1,
        transaction_hash: "tx15",
        ...invoke(ROUTER),
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

/**
 * The counterparty fallback was dead for as long as it existed.
 *
 * `chain/history.ts` fell back to the record's `address` field, whose own name
 * says "the contract", and Horizon puts "" there on every contract call. So the
 * comment that said the fallback "keeps a CCTP claim from rendering as
 * 'Received from ' with nothing after it" described exactly what shipped.
 */
describe("which contract a call actually named", () => {
  const MESSENGER = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP";

  it("reads it off the first argument, verbatim from operation 17257049746350081", () => {
    // The two values below are Horizon's own, copied from
    // https://horizon-testnet.stellar.org/operations/17257049746350081
    // (fetched 2026-08-09), not re-encoded here.
    expect(
      invokedContract({
        function: "HostFunctionTypeHostFunctionTypeInvokeContract",
        parameters: [
          {
            value: "AAAAEgAAAAHab57geGyBI0TYKBfvGbZItK8SD4vRC/ZY5rmerP8kuA==",
            type: "Address",
          },
          { value: "AAAADwAAABBkZXBvc2l0X2Zvcl9idXJu", type: "Sym" },
        ],
      }),
    ).toBe(MESSENGER);
  });

  it("refuses a CreateContract, whose `address` is a DEPLOYER and whose args are not a call", () => {
    expect(
      invokedContract({
        function: "HostFunctionTypeHostFunctionTypeCreateContract",
        parameters: [{ value: "AAAAAQ==", type: "Bytes" }],
      }),
    ).toBeUndefined();
  });

  it("answers undefined rather than throwing on anything it cannot read", () => {
    const fn = "HostFunctionTypeHostFunctionTypeInvokeContract";
    expect(invokedContract({})).toBeUndefined();
    expect(invokedContract({ function: fn })).toBeUndefined();
    expect(invokedContract({ function: fn, parameters: [] })).toBeUndefined();
    expect(invokedContract({ function: fn, parameters: [{ type: "Address" }] })).toBeUndefined();
    expect(
      invokedContract({ function: fn, parameters: [{ value: "not-xdr", type: "Address" }] }),
      "a history read must not fail over a counterparty it cannot name",
    ).toBeUndefined();
    // A G-address in the first argument is a real ScVal address and NOT the
    // contract that was called, so it is not a counterparty for this row.
    expect(
      invokedContract({
        function: fn,
        parameters: [
          { value: new Address(ISSUER_G).toScVal().toXDR("base64"), type: "Address" },
          { value: nativeToScVal("swap", { type: "symbol" }).toXDR("base64"), type: "Sym" },
        ],
      }),
    ).toBeUndefined();
  });
});
