import { describe, it, expect, vi, afterEach } from "vitest";
import { balanceHistory, balanceAt, type BalancePoint } from "./balance-history";

const ACCOUNT = "GBFSWI3KZLBHMQXBXKKJ2XCTPFXHQPZY4LGMMWZ5UI5SPXQ3W5GWUJXX";
const HORIZON = "https://horizon-testnet.stellar.org";
const XLM = 10_000_000n;

const iso = (ms: number) => new Date(ms).toISOString();

/** Answer Horizon with the given effects and transactions, and nothing else. */
function stubHorizon(effects: unknown[], transactions: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const records = url.includes("/effects") ? effects : transactions;
      return {
        ok: true,
        json: async () => ({ _embedded: { records } }),
      } as unknown as Response;
    }),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe("balanceAt", () => {
  const points: BalancePoint[] = [
    { at: 1000, stroops: 0n },
    { at: 2000, stroops: 500n },
    { at: 3000, stroops: 300n },
  ];

  it("is zero before the account existed, which is a real zero", () => {
    // Not "unknown" and not the first known value carried backwards. A wallet
    // that did not exist two months ago was worth nothing two months ago.
    expect(balanceAt(points, 0)).toBe(0n);
    expect(balanceAt(points, 999)).toBe(0n);
  });

  it("holds each value until the next change", () => {
    expect(balanceAt(points, 1000)).toBe(0n);
    expect(balanceAt(points, 1999)).toBe(0n);
    expect(balanceAt(points, 2000)).toBe(500n);
    expect(balanceAt(points, 2999)).toBe(500n);
    expect(balanceAt(points, 3000)).toBe(300n);
    expect(balanceAt(points, 99999)).toBe(300n);
  });

  it("has nothing to say about an empty history", () => {
    expect(balanceAt([], 5000)).toBe(0n);
  });

  it("agrees with a linear scan at every boundary", () => {
    // The lookup is a binary search, which is exactly the kind of code that is
    // correct on the values someone thought to type and off by one at a
    // boundary. Checked against the obvious implementation.
    const scan = (t: number) => {
      let v = 0n;
      for (const p of points) if (p.at <= t) v = p.stroops;
      return v;
    };
    for (let t = 900; t <= 3100; t += 1) {
      expect(balanceAt(points, t), `disagreed at t=${t}`).toBe(scan(t));
    }
  });
});

describe("balanceHistory", () => {
  const now = Date.now();

  it("walks backward from the current balance", async () => {
    // Received 100 XLM an hour ago. Before that the account held 40.
    stubHorizon([
      {
        type: "account_credited",
        account: ACCOUNT,
        created_at: iso(now - 3_600_000),
        amount: "100.0000000",
        asset_type: "native",
      },
    ]);

    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 140n * XLM,
      since: now - 86_400_000,
    });

    expect(points).not.toBeNull();
    expect(points!.map((p) => p.stroops)).toEqual([40n * XLM, 140n * XLM]);
    // Oldest first, which is what the chart consumes.
    expect(points![0]!.at).toBeLessThan(points![1]!.at);
  });

  it("subtracts fees, which no effect reports", async () => {
    // Horizon emits no fee effect: verified live, 200 network-wide effects
    // contained no fee-ish type. Without this the curve drifts by every fee the
    // account ever paid and still looks plausible.
    stubHorizon(
      [],
      [{ created_at: iso(now - 60_000), fee_charged: "100", source_account: ACCOUNT }],
    );

    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 900n,
      since: now - 86_400_000,
    });

    // Balance is 900 now and a 100-stroop fee was paid, so it was 1000 before.
    expect(points!.map((p) => p.stroops)).toEqual([1000n, 900n]);
  });

  it("ignores a fee this account did not pay", async () => {
    stubHorizon(
      [],
      [{ created_at: iso(now - 60_000), fee_charged: "100", source_account: "GSOMEONEELSE" }],
    );
    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 900n,
      since: now - 86_400_000,
    });
    expect(points!.map((p) => p.stroops)).toEqual([900n]);
  });

  it("ignores an effect belonging to the counterparty", async () => {
    // Crediting these to this account would invent money it never had.
    stubHorizon([
      {
        type: "account_credited",
        account: "GSOMEONEELSE",
        created_at: iso(now - 60_000),
        amount: "500.0000000",
        asset_type: "native",
      },
    ]);
    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 10n * XLM,
      since: now - 86_400_000,
    });
    expect(points!.map((p) => p.stroops)).toEqual([10n * XLM]);
  });

  it("ignores a different asset's movement", async () => {
    stubHorizon([
      {
        type: "account_credited",
        account: ACCOUNT,
        created_at: iso(now - 60_000),
        amount: "500.0000000",
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUER",
      },
    ]);
    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 10n * XLM,
      since: now - 86_400_000,
    });
    expect(points!.map((p) => p.stroops)).toEqual([10n * XLM]);
  });

  it("counts both legs of a trade independently", async () => {
    stubHorizon([
      {
        type: "trade",
        account: ACCOUNT,
        created_at: iso(now - 60_000),
        bought_amount: "30.0000000",
        bought_asset_type: "native",
        sold_amount: "5.0000000",
        sold_asset_type: "credit_alphanum4",
        sold_asset_code: "USDC",
        sold_asset_issuer: "GISSUER",
      },
    ]);
    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 30n * XLM,
      since: now - 86_400_000,
    });
    // Bought 30 XLM, so before the trade it held nothing.
    expect(points!.map((p) => p.stroops)).toEqual([0n, 30n * XLM]);
  });

  it("refuses rather than drawing a curve that goes negative", async () => {
    // A walk that produces a negative balance missed a change, which means every
    // earlier point is wrong too. Fail closed, like the opening store does.
    stubHorizon([
      {
        type: "account_credited",
        account: ACCOUNT,
        created_at: iso(now - 60_000),
        amount: "500.0000000",
        asset_type: "native",
      },
    ]);
    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 10n * XLM,
      since: now - 86_400_000,
    });
    expect(points).toBeNull();
  });

  it("refuses when Horizon fails rather than reporting an empty history", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 }) as unknown as Response),
    );
    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 10n * XLM,
      since: now - 86_400_000,
    });
    // Null, not []. An empty history would be charted as "you had nothing",
    // which is a claim about the user rather than about the request.
    expect(points).toBeNull();
  });

  it("does not read a change from before the window", async () => {
    stubHorizon([
      {
        type: "account_credited",
        account: ACCOUNT,
        created_at: iso(now - 10 * 86_400_000),
        amount: "500.0000000",
        asset_type: "native",
      },
    ]);
    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: ACCOUNT,
      assetId: "native",
      currentStroops: 10n * XLM,
      since: now - 86_400_000,
    });
    expect(points!.map((p) => p.stroops)).toEqual([10n * XLM]);
  });
});
