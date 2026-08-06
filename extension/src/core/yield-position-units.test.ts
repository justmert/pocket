// The vault reports subunits. The screen renders decimals.
//
// `DefindexClient.position` returns the API body verbatim, and that body counts
// in i128 subunits: a live round trip deposited 33333333 stroops (3.3333333
// XLM) and the API then answered {"dfTokens":"19987","underlyingBalance":
// ["33331683"]}. Withdrawing exactly 33331683 returned the whole position
// (tx 92ac3f26de1eac446aab4a49a8cce8a91a8d924ed7d0891615015b4a388d0003) and
// moved Horizon's XLM balance by +3.3299953 net of a 0.0042139 fee, which is
// what proves the figure is stroops rather than a decimal amount.
//
// Handed to the screen unconverted it was read as a decimal by all three
// consumers: the position card, the withdraw notice, and `AmountComposer`'s
// `spendable`, which sizes MAX. A user with 3.33 XLM in the vault was told they
// had 33,331,683 and offered a MAX of 33331682.5.
//
// `decimals` on the deployed vault is 7, confirmed on chain against
// CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6, so the share count
// is subunits on the same scale and converts the same way. That matters because
// the two fields are adjacent and a fix that only converted one would still be
// wrong on the card.
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

/** Exactly what the live endpoint answered for a 3.3333333 XLM position. */
let body = { dfTokens: "19987", underlying: "33331683" as string | undefined };
/** The symbol the vault reports for its underlying. The live XLM vault answers
 *  "native"; the wallet's own code for native is "XLM". */
let vaultSymbol = "XLM";

vi.mock("./integrations/defindex", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    DefindexClient: class {
      async vault() {
        return { address: "CV", apy: 0.1306, assets: [{ address: "CX", symbol: vaultSymbol }] };
      }
      // The shape `position()` returns after its own validation: the raw
      // strings, unconverted. Converting here would test the mock.
      async position() {
        return { shares: body.dfTokens, underlying: body.underlying };
      }
    },
  };
});

// Build-time env, absent in a unit run, and the controller correctly refuses
// the whole feature without it.
vi.mock("./config", async (orig) => {
  const real = (await orig()) as { NETWORKS: Record<string, Record<string, unknown>> };
  return {
    ...real,
    NETWORKS: {
      ...real.NETWORKS,
      testnet: {
        ...real.NETWORKS.testnet,
        defindex: {
          baseUrl: "https://api.defindex.io",
          apiKey: "k",
          vault: "CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6",
        },
      },
    },
  };
});

const { WalletController } = await import("./controller");

beforeEach(() => {
  store.clear();
  body = { dfTokens: "19987", underlying: "33331683" };
  vaultSymbol = "XLM";
});

async function worker() {
  const c = new WalletController();
  await c.init();
  await c.create("pw");
  return c;
}

describe("the yield position the screen is handed", () => {
  it("states the underlying in the units the screen prints", async () => {
    const c = await worker();
    const p = await c.yieldPosition();
    // 3.3331683, not 33331683. The screen appends the asset code to this
    // string, so the raw figure is a claim about XLM by the time it is drawn.
    expect(p.underlyingBalance).toBe("3.3331683");
    expect(p.underlyingBalance).not.toBe("33331683");
  });

  it("states the share count in the same units", async () => {
    // The vault's own `decimals` is 7, read on chain. Shares are subunits too,
    // and the card prints this beside the underlying.
    const c = await worker();
    const p = await c.yieldPosition();
    expect(p.balance).toBe("0.0019987");
  });

  it("does not offer a MAX larger than the position", async () => {
    // The property rather than the constant: whatever the screen is handed as
    // the withdrawable amount must not exceed what the vault holds. This is the
    // assertion that fails loudest, because MAX fills the form from it.
    const c = await worker();
    const p = await c.yieldPosition();
    const shown = Number(p.underlyingBalance);
    const actual = Number(body.underlying) / 1e7;
    expect(shown).toBeLessThanOrEqual(actual);
    expect(shown).toBeCloseTo(actual, 7);
  });

  it("passes through a value that already carries a decimal point", async () => {
    // The client's shape check permits `\d+(\.\d+)?`, so a decimal can arrive.
    // Converting one of those a second time would divide a real balance by ten
    // million, which is the same defect pointing the other way.
    body = { dfTokens: "1.5", underlying: "3.3331683" };
    const c = await worker();
    const p = await c.yieldPosition();
    expect(p.underlyingBalance).toBe("3.3331683");
    expect(p.balance).toBe("1.5");
  });

  it("normalises the vault's 'native' underlying to the wallet's XLM code", async () => {
    // The live DeFindex XLM vault reports its underlying symbol as "native", but
    // the rest of the wallet calls native XLM "XLM" and keys the home price map on
    // that. Left "native" the position matched no price, `publicTotalUsd` returned
    // null, the hero fell back to a bare XLM figure, and the value chart that shares
    // that early return never rendered. Verified live on 2026-08-09.
    vaultSymbol = "native";
    const c = await worker();
    const p = await c.yieldPosition();
    expect(p.underlying).toBe("XLM");
  });

  it("passes a real (non-native) underlying symbol through unchanged", async () => {
    // A USDC vault already reports "USDC", which the price map has; only "native"
    // needs translating, so everything else is left exactly as the vault named it.
    vaultSymbol = "USDC";
    const c = await worker();
    const p = await c.yieldPosition();
    expect(p.underlying).toBe("USDC");
  });

  it("reports no underlying rather than a zero when the vault omits it", async () => {
    // "I could not read it" and "you have nothing" are different facts, and a
    // fabricated zero here reads as an empty position on the card.
    body = { dfTokens: "19987", underlying: undefined };
    const c = await worker();
    const p = await c.yieldPosition();
    expect(p.underlyingBalance).toBeUndefined();
    expect(p.balance).toBe("0.0019987");
  });
});
