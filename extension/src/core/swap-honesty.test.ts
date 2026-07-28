// What a swap tells you, measured against what it does.
//
// Four separate things the flow got wrong, all of the same kind: the wallet had
// the fact and did not say it, or said one it had not measured.
//
//   1. Price impact. An estimate and a slippage floor say nothing about whether
//      the rate is any good: slippage bounds movement AFTER the quote, and a
//      thin pool's cost is already inside the quote. Measured live on this
//      deployment, a routable swap came back 62% and later 81% below the
//      near-spot rate, quoted, built, signed and landed with no figure anywhere.
//   2. The pre-simulation balance refusal quoted BASE_FEE, 100 stroops, as "the
//      network fee" for a Soroban invocation whose real fee measured 59,475 to
//      165,852 stroops, and named a spendable figure the same build then refused.
//   3. A price move past the slippage between review and confirm produced
//      "Something went wrong. Try again, and check your connection."
//   4. The receipt named no amount at all, though the delivered figure rides on
//      the very reply the confirmation poll already reads.
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

/** 100,000 XLM, so nothing here is refused for want of balance. */
let nativeStroops = 1_000_000_000_000n;

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
    ) => ({
      id: `${asset.getCode()}:${asset.getIssuer()}`,
      code: asset.getCode(),
      issuer: asset.getIssuer(),
      limit: 10n ** 18n,
      raw: 10n ** 15n,
      sellingLiabilities: 0n,
      authorized: true,
    }),
  };
});

/**
 * The pool, as a function rather than a table: out = in * RATE / (in + DEPTH).
 *
 * A constant-product curve, so the marginal rate really does fall with size,
 * which is the whole property under test. DEPTH sets how thin it is.
 */
let depth = 10_000_000_000n; // 1,000 units
const RATE = 10_000_000_000n;
/** A parseable ScVal for the route argument. `readRouteEndpoints` is mocked, so
 *  its contents are irrelevant; `buildSwap` still decodes it to pass it on. */
const ROUTE_XDR = "AAAAEAAAAAEAAAAA"; // scvVec, empty
/** Every input amount the route was asked about, so the probe is visible. */
let asked: bigint[] = [];
/** When set, find-path throws for this exact input, to kill only the probe. */
let failFor: bigint | null = null;
/** What the route decodes to. Reset per test; overridden to forge a bad route. */
let route: { firstPair: string[]; terminal: string; hops: number };

vi.mock("./integrations/aquarius", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    AquariusClient: class {
      async findPath(_in: string, _out: string, amount: bigint) {
        asked.push(amount);
        if (failFor !== null && amount === failFor) throw new Error("no route");
        return {
          swapChainXdr: ROUTE_XDR,
          amount: (amount * RATE) / (amount + depth),
          pools: ["P"],
          tokens: ["XLM", "USDC"],
        };
      }
    },
    // The endpoints a route COMMITS to, which is a third party's answer and
    // the only thing tying the delivered asset to the one the screen names.
    // Settable so a test can hand back a route that ends somewhere else.
    readRouteEndpoints: () => route,
  };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { describeError } = await import("./dispatch");
const base = await import("@stellar/stellar-sdk/base");
const { Account, Asset, TransactionBuilder, xdr } = base;

const PASS = NETWORKS.testnet.passphrase;
const USDC_ISSUER = NETWORKS.testnet.knownAssets?.[0]?.issuer ?? "";
const USDC = `USDC:${USDC_ISSUER}`;
const IN_SAC = Asset.native().contractId(PASS);
const OUT_SAC = new Asset("USDC", USDC_ISSUER).contractId(PASS);

/** ~0.0166 XLM, the order a real swap's resource fee came back at. */
const SIM_FEE = "165852";

function withFee(tx: unknown, fee: string): unknown {
  const t = tx as { toXDR(): string; networkPassphrase: string };
  const env = xdr.TransactionEnvelope.fromXDR(t.toXDR(), "base64");
  env.v1().tx().fee(Number(fee));
  return TransactionBuilder.fromXDR(env.toXDR("base64"), t.networkPassphrase);
}

/** What `prepareTransaction` does, set per test. */
let prepare: (tx: unknown) => unknown = (tx) => withFee(tx, SIM_FEE);
/** What `getTransaction` answers once something is submitted. */
let reply: Record<string, unknown> = { status: "SUCCESS", ledger: 9, applicationOrder: 1 };

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1000 }),
    prepareTransaction: async (tx: unknown) => prepare(tx),
    sendTransaction: async () => ({ status: "PENDING" }),
    getTransaction: async () => reply,
  });
  return c;
}

beforeEach(() => {
  store.clear();
  nativeStroops = 1_000_000_000_000n;
  depth = 10_000_000_000n;
  asked = [];
  failFor = null;
  route = { firstPair: [IN_SAC, OUT_SAC], terminal: OUT_SAC, hops: 1 };
  prepare = (tx) => withFee(tx, SIM_FEE);
  reply = { status: "SUCCESS", ledger: 9, applicationOrder: 1 };
});

describe("price impact", () => {
  it("is measured against the pool's own near-spot rate", async () => {
    const c = await worker();
    // 1,000 units into a pool with 1,000 units of depth: the curve's cost here
    // is large and obvious, which is the case that used to be silent.
    const q = await c.swapQuote("native", USDC, "1000");

    expect(q.impactBps, "no impact was measured at all").not.toBeNull();
    expect(q.impactBps!).toBeGreaterThan(4_000);
    // And the reference really is a second, smaller lookup.
    expect(asked, "the near-spot rate was never asked for").toContain(10_000_000n);
  });

  it("is small for a trade the pool barely notices", async () => {
    const c = await worker();
    depth = 10n ** 16n; // very deep
    const q = await c.swapQuote("native", USDC, "1000");
    expect(q.impactBps).toBeLessThan(100);
  });

  it("says it could not be measured rather than reporting zero", async () => {
    // An unmeasured impact must never be indistinguishable from a measured
    // small one: null is the value the screen renders as "could not be
    // measured", and 0 is a claim.
    const c = await worker();
    failFor = 10_000_000n;
    const q = await c.swapQuote("native", USDC, "1000");
    expect(q.impactBps).toBeNull();
  });

  it("does not fail the quote when the probe fails", async () => {
    const c = await worker();
    failFor = 10_000_000n;
    await expect(c.swapQuote("native", USDC, "1000")).resolves.toMatchObject({ estOut: /./ });
  });

  it("warns on the confirm screen when the rate is far off", async () => {
    const c = await worker();
    const { summary } = await c.buildSwap("native", USDC, "1000");

    expect(summary.impactBps).not.toBeNull();
    expect(summary.warning, "a 40%+ impact reached the signature with no warning").toBeTruthy();
    expect(summary.warning!).toMatch(/worse than the price/i);
  });

  it("leaves the confirm screen unmarked when the rate is fine", async () => {
    const c = await worker();
    depth = 10n ** 16n;
    const { summary } = await c.buildSwap("native", USDC, "1000");
    expect(summary.warning).toBeUndefined();
  });
});

describe("the balance refusal before anything is simulated", () => {
  it("does not quote the base fee as the fee a swap pays", async () => {
    // 100 stroops is right for a classic payment and wrong by three orders of
    // magnitude for an invocation. Stating it made the refusal name a spendable
    // figure the same build then refused a moment later.
    const c = await worker();
    nativeStroops = 100_000_000n; // 10 XLM
    const err = await c.buildSwap("native", USDC, "9999").catch((e: unknown) => e);

    const said = (err as Error).message;
    expect(said).toMatch(/more than you can send/i);
    expect(said, "quoted BASE_FEE as a swap's network fee").not.toContain("0.0000100 XLM");
    expect(said).toMatch(/held back for the network fee/i);
  });

  it("still states the exact fee once one has been measured", async () => {
    // The classic payment path knows its fee before it builds, and must keep
    // saying so: "up to" would be a hedge about a number that is not in doubt.
    const c = await worker();
    nativeStroops = 100_000_000n;
    const err = await c
      .buildPayment({
        to: "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF",
        assetId: "native",
        amount: "9999",
      })
      .catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/0\.0000100 XLM pays the network fee/);
  });
});

describe("the price moving between review and confirm", () => {
  it("is not reported as a connection problem", async () => {
    const c = await worker();
    const { handle } = await c.buildSwap("native", USDC, "10");

    // What the deployed router answers when out_min cannot be met. The SDK
    // implements a failed prepareTransaction as `throw new Error(sim.error)`,
    // so `name` is the bare "Error" that neither allowlist carries.
    prepare = () => {
      throw new Error("HostError: Error(Contract, #2006) ... transaction simulation failed");
    };
    const err = await c.confirmSwap(handle).catch((e: unknown) => e);

    const said = describeError(err);
    expect(said, "a price move read as a network problem").not.toMatch(/check your connection/i);
    expect(said).toMatch(/fresh quote/i);
    // And the RPC's own text never crosses: it can carry a URL or a stack.
    expect(said).not.toMatch(/HostError|simulation failed/);
  });

  it("does not leave the user pressing Confirm on a dead handle in silence", async () => {
    const c = await worker();
    const { handle } = await c.buildSwap("native", USDC, "10");
    prepare = () => {
      throw new Error("HostError: Error(Contract, #2006)");
    };
    await c.confirmSwap(handle).catch(() => undefined);

    // The handle is spent, and the second press has to say something true.
    const again = await c.confirmSwap(handle).catch((e: unknown) => e);
    expect(describeError(again)).toMatch(/fresh quote/i);
  });
});

describe("the receipt", () => {
  it("says what the swap actually delivered", async () => {
    const c = await worker();
    const { handle } = await c.buildSwap("native", USDC, "10");
    // `swap_chained` returns the out amount as a u128. 4,410,137,248 stroops is
    // one of the two figures measured on landed swaps.
    reply = {
      status: "SUCCESS",
      ledger: 9,
      applicationOrder: 1,
      returnValue: xdr.ScVal.scvU128(
        new xdr.UInt128Parts({
          hi: xdr.Uint64.fromString("0"),
          lo: xdr.Uint64.fromString("4410137248"),
        }),
      ),
    };

    const r = await c.confirmSwap(handle);
    expect(r.delivered, "the wallet had the delivered amount and dropped it").toBe("441.0137248");
  });

  it("says nothing rather than something wrong when the reply carries no value", async () => {
    const c = await worker();
    const { handle } = await c.buildSwap("native", USDC, "10");
    reply = { status: "SUCCESS", ledger: 9, applicationOrder: 1 };
    const r = await c.confirmSwap(handle);
    expect(r.delivered).toBeUndefined();
  });

  it("ignores a return value of a shape the contract cannot produce", async () => {
    // A successful swap must not turn into a failed one because the RPC
    // answered with something unexpected.
    const c = await worker();
    const { handle } = await c.buildSwap("native", USDC, "10");
    reply = {
      status: "SUCCESS",
      ledger: 9,
      applicationOrder: 1,
      returnValue: xdr.ScVal.scvSymbol("nonsense"),
    };
    await expect(c.confirmSwap(handle)).resolves.toMatchObject({ delivered: undefined });
  });
});

/**
 * Two properties round one found UNPINNED: with `if (route.terminal !== outA.sac)`
 * turned into `if (false)` AND `outMin` forced to `0n`, both at once, every
 * test file in the tree that constructs a WalletController stayed green.
 *
 * They are the two things that decide what the user actually receives. `out_min`
 * is the floor the contract enforces; at zero the swap cannot revert however bad
 * the price gets, and the "you receive at least" line on the confirm screen
 * becomes a sentence with nothing behind it. The route check is the only thing
 * tying the delivered asset to the one the screen names: `swap_chained` has no
 * token_out argument, and `out_min` is a bare scalar in whatever token the last
 * hop happens to deliver, so it bounds quantity and cannot bind identity.
 */
describe("what the envelope actually commits to", () => {
  /** The five `swap_chained` arguments, decoded out of the staged envelope. */
  function swapArgs(c: unknown, handle: string) {
    const entry = (c as { pending: Map<string, { xdr: string }> }).pending.get(handle)!;
    const tx = TransactionBuilder.fromXDR(entry.xdr, PASS) as unknown as {
      operations: { func: { invokeContract(): (typeof xdr.ScVal.prototype)[] } }[];
    };
    return tx.operations[0]!.func.invokeContract().args();
  }

  it("signs an out_min that is the estimate less the slippage, not zero", async () => {
    const c = await worker();
    // 100 units in, 1% slippage (the default).
    const { handle, summary } = await c.buildSwap("native", USDC, "100");

    const args = swapArgs(c, handle);
    expect(args).toHaveLength(5);
    const outMin = base.scValToBigInt(args[4]!);
    expect(outMin, "the swap's floor is zero, so it can never revert").toBeGreaterThan(0n);
    // Exactly the number the confirm screen promised, in stroops.
    expect(outMin).toBe(BigInt(summary.minOut.replace(".", "")));
    // ...and exactly estimate * 99%.
    const est = BigInt(summary.estOut.replace(".", ""));
    expect(outMin).toBe((est * 9_900n) / 10_000n);
  });

  it("tightens the floor as the slippage setting tightens", async () => {
    const c = await worker();
    const loose = await c.buildSwap("native", USDC, "100", 500);
    const tight = await c.buildSwap("native", USDC, "100", 10);
    expect(base.scValToBigInt(swapArgs(c, tight.handle)[4]!)).toBeGreaterThan(
      base.scValToBigInt(swapArgs(c, loose.handle)[4]!),
    );
  });

  it("refuses a route that ends in a different asset from the one on screen", async () => {
    const c = await worker();
    // A route answering with AQUA where the screen says USDC. Nothing else in
    // the envelope can catch this: out_min is denominated in whatever arrives.
    const other = new Asset("AQUA", USDC_ISSUER).contractId(PASS);
    route = { firstPair: [IN_SAC, other], terminal: other, hops: 1 };

    await expect(c.buildSwap("native", USDC, "100")).rejects.toThrow(/does not end in USDC/);
  });

  it("refuses a route that starts from a different asset", async () => {
    const c = await worker();
    const other = new Asset("AQUA", USDC_ISSUER).contractId(PASS);
    route = { firstPair: [other, OUT_SAC], terminal: OUT_SAC, hops: 1 };

    await expect(c.buildSwap("native", USDC, "100")).rejects.toThrow(/does not start from XLM/);
  });

  it("stages nothing when the route is refused", async () => {
    // A refusal that still leaves a signable envelope behind is not a refusal.
    const c = await worker();
    const other = new Asset("AQUA", USDC_ISSUER).contractId(PASS);
    route = { firstPair: [IN_SAC, other], terminal: other, hops: 1 };
    await c.buildSwap("native", USDC, "100").catch(() => undefined);

    expect((c as unknown as { pending: Map<string, unknown> }).pending.size).toBe(0);
  });
});
