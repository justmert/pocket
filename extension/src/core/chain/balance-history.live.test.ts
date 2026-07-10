// Balance history, against a real account on real testnet.
//
// Funds a fresh account with friendbot and then asks what its balance has been.
// A fresh account has exactly one interesting moment in its life, so the answer
// is fully known in advance: nothing, then 10,000 XLM. That makes this a real
// check rather than a smoke test, because a wrong sign, a missed fee or an
// off-by-one in the backward walk all produce a number that is not 10,000.
import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk/base";
import { balanceHistory, balanceAt } from "./balance-history";
import { priceSeries } from "./prices";
import { valueSeries, changePct } from "./portfolio";
import { STROOPS_PER_UNIT } from "./balances";

const HORIZON = "https://horizon-testnet.stellar.org";
const FRIENDBOT = "https://friendbot.stellar.org";

async function fundedAccount(): Promise<{ address: string; stroops: bigint }> {
  const kp = Keypair.random();
  const res = await fetch(`${FRIENDBOT}?addr=${kp.publicKey()}`);
  if (!res.ok) throw new Error(`friendbot answered ${res.status}`);
  // Horizon is eventually consistent with the ledger it just closed.
  for (let i = 0; i < 20; i++) {
    const a = await fetch(`${HORIZON}/accounts/${kp.publicKey()}`);
    if (a.ok) {
      const body = (await a.json()) as { balances: { asset_type: string; balance: string }[] };
      const native = body.balances.find((b) => b.asset_type === "native")!;
      const [whole, frac = ""] = native.balance.split(".");
      return {
        address: kp.publicKey(),
        stroops: BigInt(whole!) * STROOPS_PER_UNIT + BigInt(frac.padEnd(7, "0")),
      };
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("friendbot funded nothing within 20s");
}

describe("balance history on real testnet", () => {
  it("walks a fresh account back to the nothing it started from", async () => {
    const { address, stroops } = await fundedAccount();

    const points = await balanceHistory({
      horizonUrl: HORIZON,
      account: address,
      assetId: "native",
      currentStroops: stroops,
      since: Date.now() - 86_400_000,
    });

    expect(points, "history could not be reconstructed").not.toBeNull();
    // Oldest first, and the last point is what the ledger says right now.
    expect(points![points!.length - 1]!.stroops).toBe(stroops);
    // Before friendbot paid it, the account held nothing. This is the assertion
    // that the whole chart rests on: it is what makes a range predating the
    // wallet draw a real zero rather than today's balance smeared backwards.
    expect(points![0]!.stroops).toBe(0n);
    expect(balanceAt(points!, Date.now() - 3_600_000)).toBe(0n);
    expect(balanceAt(points!, Date.now())).toBe(stroops);
  }, 120_000);

  it("produces a value curve that starts at zero and steps up", async () => {
    const { address, stroops } = await fundedAccount();
    const prices = await priceSeries("XLM", "1D");
    expect(prices.length).toBeGreaterThan(2);

    const history = await balanceHistory({
      horizonUrl: HORIZON,
      account: address,
      assetId: "native",
      currentStroops: stroops,
      since: Date.now() - 86_400_000,
    });
    const series = valueSeries(history!, prices);

    // one more than the price series: the curve is carried to now so its right
    // edge equals the headline figure rather than the last closed candle.
    expect(series.length).toBe(prices.length + 1);
    // The account was funded moments ago, so almost the whole day is genuinely
    // worth nothing and the last point is worth real money.
    expect(series[0]!.value).toBe(0);
    expect(series[series.length - 1]!.value).toBeGreaterThan(0);

    // A step, not a scaled price curve. This is the difference the whole design
    // turns on: holdings_now * price(t) could never produce a zero here.
    const steps = series.filter((p, i) => i > 0 && p.value > 0 && series[i - 1]!.value === 0);
    expect(steps.length, "expected exactly one funding step").toBe(1);

    // No percentage from nothing: every gain from zero is infinite.
    expect(changePct(series)).toBeNull();
  }, 120_000);
});
