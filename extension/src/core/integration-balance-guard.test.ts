// Every build path checks the balance it is about to spend.
//
// Only the native payment did. `buildSwap` validated positivity, slippage and
// the OUT trustline; `buildYieldMove` validated positivity and the vault
// target; `buildCctpSend` validated positivity, the six-decimal floor and the
// EVM address. None of the three read the IN balance, so all three ended the
// same way: routed or quoted, reviewed, signed, submitted, refused on chain,
// fee paid.
//
// The CCTP one is the worst of them, because `confirmCctpSend` submits TWO
// transactions and leg one is a SAC `approve`, which needs no balance at all.
// It succeeded and was charged, then the burn failed and reported a connection
// problem.
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

/** 10 XLM, no offers, plain account. */
let nativeStroops = 100_000_000n;
/** The USDC trustline, or null for "no trustline". */
let usdcLine: { raw: bigint; sellingLiabilities: bigint; authorized: boolean } | null = null;

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readNative: async () => ({
      raw: nativeStroops,
      subEntryCount: 1,
      numSponsoring: 0,
      numSponsored: 0,
      sellingLiabilities: 0n,
    }),
    readTrustline: async (
      _s: unknown,
      _a: string,
      asset: { getCode(): string; getIssuer(): string },
    ) =>
      usdcLine === null
        ? null
        : {
            id: `${asset.getCode()}:${asset.getIssuer()}`,
            code: asset.getCode(),
            issuer: asset.getIssuer(),
            limit: 10n ** 18n,
            ...usdcLine,
          },
  };
});

// Reached only if the guard lets the build through, which is the point: these
// throw, so a test that expects a balance refusal and gets one of these has
// caught a guard that did not fire.
const TOO_FAR = "the build got past the balance guard";
vi.mock("./integrations/aquarius", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    AquariusClient: class {
      async route() {
        throw new Error(TOO_FAR);
      }
    },
  };
});
vi.mock("./integrations/defindex", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    DefindexClient: class {
      async vault() {
        return { address: "CV", assets: [{ address: "CX", symbol: "XLM" }] };
      }
      async buildDeposit() {
        throw new Error(TOO_FAR);
      }
      async buildWithdraw() {
        throw new Error(TOO_FAR);
      }
    },
  };
});

// The DeFindex vault and key are build-time env, absent in a unit run, and the
// controller correctly refuses the whole feature without them. Filled in here
// so the guard under test is reachable at all.
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
          vault: "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6",
        },
      },
    },
  };
});

/** What simulation adds, in stroops. ~0.035 XLM, the order a real swap costs. */
const SIM_FEE = "350412";

/**
 * The envelope simulation would hand back: same bytes, resource fee added.
 *
 * Patched at the XDR level and re-parsed, because a built `Transaction` is
 * immutable and re-adding decoded operations to a builder does not round-trip
 * an `invokeHostFunction`. This is the one field `assembleTransaction` changes
 * that this test cares about.
 */
function withFee(tx: unknown, fee: string): unknown {
  const t = tx as { toXDR(): string; networkPassphrase: string };
  const env = xdr.TransactionEnvelope.fromXDR(t.toXDR(), "base64");
  env.v1().tx().fee(Number(fee));
  return TransactionBuilder.fromXDR(env.toXDR("base64"), t.networkPassphrase);
}

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { Account, Asset, TransactionBuilder, xdr } = await import("@stellar/stellar-sdk/base");

const USDC_ISSUER = NETWORKS.testnet.knownAssets?.[0]?.issuer ?? "";
const USDC = `USDC:${USDC_ISSUER}`;
const EVM = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";

beforeEach(() => {
  store.clear();
  nativeStroops = 100_000_000n;
  usdcLine = { raw: 50_000_000n, sellingLiabilities: 0n, authorized: true };
});

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1000 }),
    // Simulation is what adds the resource fee, and the whole point of the
    // post-build check is that the figure only exists after this. Returning the
    // envelope unchanged left `tx.fee` at BASE_FEE and the check vacuous.
    prepareTransaction: async (tx: unknown) => withFee(tx, SIM_FEE),
  });
  return c;
}

describe("a swap for more than the account holds", () => {
  it("is refused before a route is even requested", async () => {
    const c = await worker();
    await expect(c.buildSwap("native", USDC, "9999")).rejects.toThrow(/more than you can send/);
  });

  it("names the IN asset when that is the one short", async () => {
    const c = await worker();
    usdcLine = { raw: 1_000_000n, sellingLiabilities: 0n, authorized: true };
    await expect(c.buildSwap(USDC, "native", "50")).rejects.toThrow(/USDC balance/);
  });
});

describe("a yield deposit for more than the account holds", () => {
  it("is refused before the vault is asked to build anything", async () => {
    const c = await worker();
    await expect(c.buildYieldMove("deposit", "9999")).rejects.toThrow(/more than you can send/);
  });

  it("does not guard a withdrawal, which spends vault shares and not a balance", async () => {
    // Guarding this against the XLM balance would refuse a legitimate
    // withdrawal from a wallet holding no XLM to speak of.
    const c = await worker();
    await expect(c.buildYieldMove("withdraw", "9999")).rejects.toThrow(TOO_FAR);
  });
});

describe("a CCTP bridge for more USDC than the account holds", () => {
  it("is refused before the approve leg is built", async () => {
    // The approve requires no balance, so it would have succeeded and been
    // charged for, and only the burn would have failed.
    const c = await worker();
    await expect(c.buildCctpSend(0, EVM, "9999")).rejects.toThrow(/more than you can send/);
  });

  it("says the account holds no USDC at all when that is the reason", async () => {
    usdcLine = null;
    const c = await worker();
    await expect(c.buildCctpSend(0, EVM, "1")).rejects.toThrow(/does not hold USDC/);
  });

  it("allows a bridge the balance covers", async () => {
    const c = await worker();
    await expect(c.buildCctpSend(0, EVM, "1")).resolves.toBeTruthy();
  });
});

describe("the fee a Soroban operation actually costs", () => {
  // `assertCanSpend` runs before anything is built, so the only fee it can
  // assume is BASE_FEE: 100 stroops. A Soroban invocation costs three to four
  // orders of magnitude more, and simulation is the first moment the number
  // exists. Without a second check against the real figure, an amount that
  // fits the balance and leaves nothing for the fee sailed through.
  it("refuses a native amount that fits the balance but not the balance plus its fee", async () => {
    // Driven at the check itself. Reaching it through a full swap build needs a
    // routing fixture, and what is under test is the arithmetic: an amount the
    // pre-build guard passes, because that guard can only assume 100 stroops,
    // and the real fee then does not fit.
    const c = await worker();
    nativeStroops = 100_000_000n; // 10 XLM, 1.5 reserved => 8.5 unreserved
    const inner = c as unknown as {
      assertCanSpend: (a: unknown, n: bigint, f?: bigint) => Promise<void>;
      assertCanAffordFee: (tx: unknown, a: unknown, n: bigint) => Promise<void>;
    };
    const native = Asset.native();
    const amount = 84_999_000n; // 8.4999 XLM: inside 8.5 minus the base fee

    // Passes the guard that runs before anything is built...
    await expect(inner.assertCanSpend(native, amount)).resolves.toBeUndefined();
    // ...and fails once the fee is real.
    await expect(inner.assertCanAffordFee({ fee: SIM_FEE }, native, amount)).rejects.toThrow(
      /more than you can send/,
    );
  });

  it("lets a bridge through when the XLM fee is genuinely covered", async () => {
    // The other direction, through a full build and a simulated Soroban fee,
    // so the check is not merely refusing everything.
    const c = await worker();
    nativeStroops = 100_000_000n;
    await expect(c.buildCctpSend(0, EVM, "1")).resolves.toBeTruthy();
  });

  it("refuses a USDC bridge when there is no XLM to pay the fee with", async () => {
    // The fee is XLM whatever is moving. A wallet holding plenty of USDC and
    // almost no XLM passed every check and failed on chain.
    const c = await worker();
    nativeStroops = 10_100_000n; // just over the reserve, nothing spare
    usdcLine = { raw: 50_000_000n, sellingLiabilities: 0n, authorized: true };
    await expect(c.buildCctpSend(0, EVM, "1")).rejects.toThrow(/network fee/i);
  });
});
