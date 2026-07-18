// An asset you added has to exist everywhere, or it exists nowhere useful.
//
// "Add an asset" searches the whole stellar.expert directory and
// `buildAddTrustline` opens a trustline for anything valid. But `balances()`
// iterated `NETWORKS[network].knownAssets`, a hardcoded list holding exactly one
// entry on each network, and `balances()` is what Home, the send picker, the
// swap picker and every total read.
//
// So an asset a user added, paid a 0.5 XLM reserve for, and then received funds
// in was invisible to the entire wallet. It could not be sent. It could not be
// swapped. It could not even be removed, because the remove path refuses a
// non-zero balance and nothing offered a way to spend it down. The one screen
// that showed it, Settings > Your assets, read a different function.
//
// That second reader had its own half of the same defect: it published
// Horizon's raw `balance` while `balances()` published `availableToSend`, so
// with one open offer Home said 60 USDC and Settings said 100, both unlabelled
// and both presented as the amount held.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";

const store = new Map<string, unknown>();
vi.stubGlobal("chrome", {
  storage: {
    local: {
      get: async (k: string | null) =>
        k === null ? Object.fromEntries(store) : store.has(k) ? { [k]: store.get(k) } : {},
      set: async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) store.set(k, v);
      },
      remove: async (k: string | string[]) => {
        for (const key of Array.isArray(k) ? k : [k]) store.delete(key);
      },
    },
  },
});

/** Trustline rows as Horizon reports them for this account. */
let horizonLines: {
  asset_code: string;
  asset_issuer: string;
  balance: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
}[] = [];
/** Set when the Horizon read should fail rather than answer. */
let horizonDown = false;

vi.stubGlobal("fetch", async () => {
  if (horizonDown) throw new Error("connect ECONNREFUSED");
  return {
    ok: true,
    status: 200,
    json: async () => ({
      balances: [
        { asset_type: "native", balance: "100.0000000" },
        ...horizonLines.map((l) => ({ ...l, asset_type: "credit_alphanum4", limit: "10000" })),
      ],
    }),
  };
});

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readNative: async () => ({
      raw: 1_000_000_000n,
      subEntryCount: 2,
      numSponsoring: 0,
      numSponsored: 0,
      sellingLiabilities: 0n,
    }),
    // The authoritative per-asset numbers, keyed off whatever the set read
    // asked about. Anything Horizon listed is answered; anything else is not
    // held.
    readTrustline: async (
      _s: unknown,
      _a: string,
      asset: { getCode(): string; getIssuer(): string },
    ) => {
      const line = horizonLines.find(
        (l) => l.asset_code === asset.getCode() && l.asset_issuer === asset.getIssuer(),
      );
      if (!line) return null;
      const [whole, frac = "0"] = line.balance.split(".");
      const raw = BigInt(whole ?? "0") * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
      const [sw, sf = "0"] = (line.selling_liabilities ?? "0").split(".");
      const sell = BigInt(sw ?? "0") * 10_000_000n + BigInt(sf.padEnd(7, "0").slice(0, 7));
      return {
        id: `${asset.getCode()}:${asset.getIssuer()}`,
        code: asset.getCode(),
        issuer: asset.getIssuer(),
        limit: 10n ** 18n,
        raw,
        sellingLiabilities: sell,
        authorized: line.is_authorized !== false,
      };
    },
  };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");

const KNOWN = NETWORKS.testnet.knownAssets?.[0];
/** An asset that is deliberately NOT in `knownAssets`. */
const STRANGER = {
  asset_code: "EURC",
  asset_issuer: "GCY7W6TM623NI5TNN3YA6BQ2L6DMRCFJUDXZT447OLSKUJE67J7GTIU4",
  balance: "25.0000000",
};

beforeEach(() => {
  store.clear();
  horizonLines = [];
  horizonDown = false;
});

async function worker() {
  const c = new WalletController();
  await c.init();
  await c.create("pw");
  return c;
}

describe("an asset the account holds but the build never heard of", () => {
  it("appears in balances(), which is what every screen reads", async () => {
    const c = await worker();
    horizonLines = [STRANGER];

    const bal = await c.balances();
    const eurc = bal.find((b) => b.code === "EURC");
    expect(eurc, "an added asset was invisible to Home, Send and Swap").toBeTruthy();
    expect(eurc?.amount).toBe("25.0000000");
  });

  it("is not confined to the hardcoded knownAssets list", async () => {
    // Guards the premise: if knownAssets ever grows to include everything, this
    // file passes vacuously and the regression returns unnoticed.
    const known = (NETWORKS.testnet.knownAssets ?? []).map((a) => a.code);
    expect(known).not.toContain("EURC");
  });

  it("still lists a known asset the account holds", async () => {
    // The control. Reading the set from the account must not lose the asset the
    // old hardcoded list did cover.
    if (!KNOWN) return;
    const c = await worker();
    horizonLines = [{ asset_code: KNOWN.code, asset_issuer: KNOWN.issuer, balance: "40.0000000" }];

    const bal = await c.balances();
    expect(bal.find((b) => b.code === KNOWN.code)?.amount).toBe("40.0000000");
  });

  it("omits an asset the account does not hold, rather than showing it as zero", async () => {
    // "You do not trust this asset" and "you hold zero of it" are different
    // facts, and only one of them is about the user.
    const c = await worker();
    horizonLines = [];

    const bal = await c.balances();
    expect(bal.map((b) => b.code)).toEqual(["XLM"]);
  });

  it("does not fabricate a balance when the asset list cannot be read", async () => {
    // The house rule, stated in balances() itself: only an account that does
    // not exist yet may render as zero, and every other failure propagates. A
    // silently short list here reads as "you sold it".
    const c = await worker();
    horizonDown = true;
    await expect(c.balances()).rejects.toThrow();
  });
});

describe("the two readers of the same trustline", () => {
  it("agree on the amount, with an offer locking part of it", async () => {
    // Home reads balances(), Settings > Your assets reads trustlines(). One
    // subtracted selling liabilities and the other did not, so an offer made in
    // any wallet on this address made the two disagree by exactly the offer.
    if (!KNOWN) return;
    const c = await worker();
    horizonLines = [
      {
        asset_code: KNOWN.code,
        asset_issuer: KNOWN.issuer,
        balance: "100.0000000",
        selling_liabilities: "40.0000000",
      },
    ];

    const fromBalances = (await c.balances()).find((b) => b.code === KNOWN.code)?.amount;
    const fromTrustlines = (await c.trustlines()).find((t) => t.code === KNOWN.code)?.balance;
    expect(fromBalances).toBe("60.0000000");
    expect(fromTrustlines, "Settings and Home disagreed about the same asset").toBe(fromBalances);
  });

  it("never reports a negative amount when liabilities exceed the balance", async () => {
    // Horizon can report both, and a negative here would render as a minus sign
    // in front of a balance.
    if (!KNOWN) return;
    const c = await worker();
    horizonLines = [
      {
        asset_code: KNOWN.code,
        asset_issuer: KNOWN.issuer,
        balance: "5.0000000",
        selling_liabilities: "9.0000000",
      },
    ];

    expect((await c.trustlines()).find((t) => t.code === KNOWN.code)?.balance).toBe("0.0000000");
  });
});
