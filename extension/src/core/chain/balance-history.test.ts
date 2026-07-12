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
    // Asserted as the STEP FUNCTION the chart samples, not as a list of values.
    // A list of values passes whether or not each is stamped at the right
    // moment, which is how this shipped reading one balance event behind: the
    // values were right and every one of them sat at the wrong time.
    expect(balanceAt(points!, now - 2 * 3_600_000)).toBe(40n * XLM); // before the credit
    expect(balanceAt(points!, now - 3_600_000)).toBe(140n * XLM); // at it
    expect(balanceAt(points!, now - 60_000)).toBe(140n * XLM); // after it
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
    expect(balanceAt(points!, now - 120_000)).toBe(1000n);
    expect(balanceAt(points!, now - 30_000)).toBe(900n);
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
    // Nothing happened in the window, so the balance held all the way across it.
    // This is the commonest shape a wallet has and it used to draw a flat ZERO
    // with a step up at the right-hand edge, because a single point at `now`
    // leaves `balanceAt` answering 0 for every earlier moment.
    expect(balanceAt(points!, now - 86_000_000)).toBe(900n);
    expect(balanceAt(points!, now - 1_000)).toBe(900n);
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
    expect(balanceAt(points!, now - 86_000_000)).toBe(10n * XLM);
    expect(balanceAt(points!, now)).toBe(10n * XLM);
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
    expect(balanceAt(points!, now - 86_000_000)).toBe(10n * XLM);
    expect(balanceAt(points!, now)).toBe(10n * XLM);
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
    expect(balanceAt(points!, now - 120_000)).toBe(0n);
    expect(balanceAt(points!, now - 60_000)).toBe(30n * XLM);
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
    // Nothing inside the window changed the balance, so it held 10 across the
    // whole of it. Had the out-of-window credit been applied the walk would
    // have gone 500 below zero and returned null, so a flat, non-null curve is
    // the evidence it was excluded.
    expect(points).not.toBeNull();
    expect(balanceAt(points!, now - 86_000_000)).toBe(10n * XLM);
    expect(balanceAt(points!, now)).toBe(10n * XLM);
  });

  it("puts the left edge at the window, not at the account's whole history", () => {
    // The anchor point added for the case above must sit at `since`. Stamped
    // anywhere earlier it would widen the chart's domain past the range the
    // caller asked for; stamped later it would leave a gap that reads as zero.
    return (async () => {
      stubHorizon([]);
      const since = now - 86_400_000;
      const points = await balanceHistory({
        horizonUrl: HORIZON,
        account: ACCOUNT,
        assetId: "native",
        currentStroops: 7n * XLM,
        since,
      });
      expect(points![0]!.at).toBe(since);
      expect(balanceAt(points!, since)).toBe(7n * XLM);
      expect(balanceAt(points!, since - 1)).toBe(0n);
    })();
  });
});
