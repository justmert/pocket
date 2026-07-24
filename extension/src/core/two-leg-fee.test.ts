// An action that signs two transactions must price and guard both.
//
// Three user actions are multi-leg and nothing in the codebase held the count.
// `messages.ts` gives every summary one scalar `fee` field, so each surface
// re-derived a figure from the one envelope it happened to be holding, and the
// same absent value surfaced as a different defect on each screen:
//
//   shield  deposit + merge. Measured on the shipped XLM wrapper: deposit
//           110,771 stroops, merge 93,726. The confirm quoted 110,771, which is
//           54% of what the account was charged. The affordability guard sized
//           the deposit alone, so a max shield landed the deposit and then
//           failed the merge for want of a fee, leaving the funds in the
//           receiving balance and the wallet directing the user to a button
//           that failed again for the identical reason.
//
//   bridge  approve + burn. Horizon `fee_charged` for deposit_for_burn on
//           testnet: 32,559 / 32,557 / 51,228 (fa4fc0cb, f249c20d, a5f34762)
//           against an approve the sheet quoted alone.
//
// The burn genuinely cannot be simulated before the approve lands, so it gets a
// measured reserve rather than a quote and the sheet says so. The merge can be:
// `merge(account)` reads the accumulators the contract already holds, so it
// prices correctly before the deposit exists.
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

let nativeStroops = 1_000_000_000n;

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
      asset: { getCode(): string; getIssuer(): string; isNative(): boolean },
    ) =>
      asset.isNative()
        ? null
        : {
            id: "USDC",
            code: asset.getCode(),
            issuer: asset.getIssuer(),
            limit: 10n ** 18n,
            raw: 1_000_0000000n,
            sellingLiabilities: 0n,
            authorized: true,
          },
  };
});

/** Fees the fake simulation adds, per contract function, in stroops. */
const FEES: Record<string, string> = { deposit: "110771", merge: "93726" };
let lastFn = "";

vi.mock("./confidential-ops", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    buildShield: async (...a: unknown[]) => {
      lastFn = "deposit";
      return (real.buildShield as (...x: unknown[]) => Promise<unknown>)(...a);
    },
    buildMerge: async (...a: unknown[]) => {
      lastFn = "merge";
      return (real.buildMerge as (...x: unknown[]) => Promise<unknown>)(...a);
    },
  };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { Account, TransactionBuilder, xdr } = await import("@stellar/stellar-sdk/base");

const XLM_WRAPPER = NETWORKS.testnet.confidential.find((c) => c.symbol === "XLM");

/** Re-emit the envelope carrying the fee simulation would have added. */
function withFee(tx: unknown, fee: string): unknown {
  const t = tx as { toXDR(): string; networkPassphrase: string };
  const env = xdr.TransactionEnvelope.fromXDR(t.toXDR(), "base64");
  env.v1().tx().fee(Number(fee));
  return TransactionBuilder.fromXDR(env.toXDR("base64"), t.networkPassphrase);
}

beforeEach(() => {
  store.clear();
  nativeStroops = 1_000_000_000n;
  lastFn = "";
});

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1000 }),
    // The fee depends on WHICH invocation is being simulated, which is the
    // whole point: a test where both legs cost the same cannot tell a total
    // from either half.
    prepareTransaction: async (tx: unknown) => withFee(tx, FEES[lastFn] ?? "100"),
    getLedgerEntries: async () => ({ entries: [] }),
  });
  // The verification-key read happens before the shield branch and is cached
  // per session; stubbed so this test is about fees.
  (c as unknown as { assertVk: () => Promise<void> }).assertVk = async () => undefined;
  return { c, address };
}

async function seedPrivate(address: string, token: string) {
  const { openingKey } = await import("../lib/storage");
  const { sealPayload } = await import("./vault/vault");
  const { requireSession } = await import("./session");
  const zero = { value: "0", randomness: "0" };
  store.set(
    openingKey(token, address),
    await sealPayload(requireSession().dek, {
      spendable: zero,
      receiving: zero,
      syncedThrough: 0,
    }),
  );
}

describe("the shield confirm", () => {
  it("states the fee for BOTH transactions, not just the deposit", async () => {
    if (!XLM_WRAPPER) return;
    const { c, address } = await worker();
    await seedPrivate(address, XLM_WRAPPER.token);

    const { summary } = await c.buildPrivateOp({ kind: "shield", amount: "1" }, XLM_WRAPPER.token);
    // 110771 + 93726 = 204497 stroops.
    expect(summary.fee).toBe("0.0204497");
    expect(summary.fee, "the deposit's fee alone was quoted").not.toBe("0.0110771");
  });

  it("says the same number in the effects the user actually reads", async () => {
    // The headline and the effect line are two renderings of one fact, and they
    // disagreed: both were the deposit, and only one of them was even labelled.
    if (!XLM_WRAPPER) return;
    const { c, address } = await worker();
    await seedPrivate(address, XLM_WRAPPER.token);

    const { summary } = await c.buildPrivateOp({ kind: "shield", amount: "1" }, XLM_WRAPPER.token);
    const said = summary.effects.join(" ");
    expect(said).toContain("0.0204497");
    expect(said).toMatch(/BOTH transactions/);
  });

  it("refuses a shield that can pay for the deposit but not the merge", async () => {
    // The stranding. Sized on the deposit alone, this amount passes, the
    // deposit lands, and the merge then fails for want of a fee: the funds sit
    // in the receiving balance and "Make spendable" fails for the same reason.
    if (!XLM_WRAPPER) return;
    const { c, address } = await worker();
    await seedPrivate(address, XLM_WRAPPER.token);
    // Minimum balance for 1 subentry is 1.5 XLM = 15,000,000 stroops. Leave
    // exactly enough above it for the amount plus the DEPOSIT's fee only.
    const amount = 10_000_000n;
    nativeStroops = 15_000_000n + amount + 110_771n;

    await expect(
      c.buildPrivateOp({ kind: "shield", amount: "1" }, XLM_WRAPPER.token),
    ).rejects.toThrow(/more than you can send/i);
  });

  it("allows it once there is enough for both", async () => {
    // The control. A guard that refuses every shield is not a guard.
    if (!XLM_WRAPPER) return;
    const { c, address } = await worker();
    await seedPrivate(address, XLM_WRAPPER.token);
    const amount = 10_000_000n;
    nativeStroops = 15_000_000n + amount + 110_771n + 93_726n;

    await expect(
      c.buildPrivateOp({ kind: "shield", amount: "1" }, XLM_WRAPPER.token),
    ).resolves.toMatchObject({ handle: expect.any(String) });
  });
});

describe("the bridge confirm", () => {
  it("holds back a measured reserve for the burn it cannot yet price", async () => {
    const { CCTP_BURN_FEE_RESERVE_STROOPS } = await import("./chain/balances");
    // Sized from the ledger, not guessed: deposit_for_burn measured at 32,559,
    // 32,557 and 51,228 stroops. The reserve must clear the largest of those.
    expect(CCTP_BURN_FEE_RESERVE_STROOPS).toBeGreaterThan(51_228n);
    // And stay far below the 0.5 XLM screen reserve, which guards a different
    // and much vaguer thing.
    const { SOROBAN_FEE_RESERVE_STROOPS } = await import("./chain/balances");
    expect(CCTP_BURN_FEE_RESERVE_STROOPS).toBeLessThan(SOROBAN_FEE_RESERVE_STROOPS);
  });

  it("quotes both legs and says the second is an estimate", async () => {
    const { c } = await worker();
    const RECIPIENT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
    const { CCTP_BURN_FEE_RESERVE_STROOPS } = await import("./chain/balances");
    const { summary } = await c.buildCctpSend(0, RECIPIENT, "1");

    const { parseAmount } = await import("./chain/balances");
    void parseAmount;
    // The approve's own fee here is the fallback 100, since no CCTP function is
    // in FEES. What matters is that the burn's reserve is included at all.
    expect(Number(summary.fee)).toBeGreaterThan(Number(CCTP_BURN_FEE_RESERVE_STROOPS) / 1e7);
    const said = summary.effects.join(" ");
    expect(said).toMatch(/covers both/i);
    expect(said).toMatch(/estimate/i);
  });
});

describe("the yield deposit guard", () => {
  it("recognises the symbol the shipped vault actually reports", async () => {
    // `yieldUnderlying` maps the vault's reported symbol to an Asset, and both
    // yield guards are written `if (asset) await ...`. The live DeFindex vault
    // reports `symbol: "native"`, which this returned null for, so the deposit's
    // balance check and its post-simulation fee check were skipped entirely on
    // the only vault this build has. A guard that silently does not run is
    // worse than no guard: the call site reads as though it does.
    const { c } = await worker();
    const forSymbol = (s: string) =>
      (
        c as unknown as { assetForSymbol(x: string): { isNative(): boolean } | null }
      ).assetForSymbol(s);
    expect(forSymbol("native"), "the shipped vault's own symbol resolved to nothing").toBeTruthy();
    expect(forSymbol("native")?.isNative()).toBe(true);
    // And the name the rest of the wallet uses still works.
    expect(forSymbol("XLM")?.isNative()).toBe(true);
    // A symbol this build genuinely does not know still yields null, so the
    // guard is skipped honestly rather than against the wrong asset.
    expect(forSymbol("NOPE")).toBeNull();
  });
});
