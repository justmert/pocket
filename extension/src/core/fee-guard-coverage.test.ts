// Every build path checks that the account can pay the fee.
//
// `assertCanAffordFee` asks whether an AMOUNT and its fee fit together, and
// five paths ask it. Seven others spend nothing but the fee -- add and remove a
// trustline, claim from a bridge, withdraw from the vault, and the private
// merge, register and unshield -- so they reached no fee guard at all. A wallet
// with no spare XLM built, simulated, reviewed and signed them, and the network
// refused with `txINSUFFICIENT_BALANCE` having taken the sequence number.
//
// The guard now sits in `prepareForReview`, the one choke point every build
// passes through, because the recurring shape in the last audit was a check
// added to one surface and missing from the rest.
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

/** The account's XLM, in stroops. One trustline of subentry, so reserve is 1.5. */
let nativeStroops = 100_000_000n;

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
      raw: 10n ** 12n,
      sellingLiabilities: 0n,
      authorized: true,
    }),
  };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { describeError } = await import("./dispatch");
const { Account, Asset, Operation, TransactionBuilder, xdr } = await import(
  "@stellar/stellar-sdk/base"
);

/** ~0.035 XLM: the order a real Soroban invocation's resource fee comes back at. */
const SIM_FEE = "350412";

function withFee(tx: unknown, fee: string): unknown {
  const t = tx as { toXDR(): string; networkPassphrase: string };
  const env = xdr.TransactionEnvelope.fromXDR(t.toXDR(), "base64");
  env.v1().tx().fee(Number(fee));
  return TransactionBuilder.fromXDR(env.toXDR("base64"), t.networkPassphrase);
}

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1000 }),
    prepareTransaction: async (tx: unknown) => withFee(tx, SIM_FEE),
  });
  return { c, address };
}

beforeEach(() => {
  store.clear();
  nativeStroops = 100_000_000n; // 10 XLM
});

/** A built, unsigned envelope with a Soroban-sized fee, as simulation returns. */
function envelope(address: string, fee: string) {
  return withFee(
    new TransactionBuilder(new Account(address, "100"), {
      fee: "100",
      networkPassphrase: NETWORKS.testnet.passphrase,
    })
      .addOperation(Operation.payment({ destination: address, asset: Asset.native(), amount: "1" }))
      .setTimeout(180)
      .build(),
    fee,
  );
}

/** The choke point every build passes through on its way to being staged. */
function review(c: unknown, tx: unknown) {
  return (c as { prepareForReview(t: unknown): Promise<unknown> }).prepareForReview(tx);
}

describe("a build whose only cost is the fee", () => {
  it("is refused when the account cannot cover it", async () => {
    // 1.5 XLM of reserve for one subentry, and 1.5000100 in the account: 100
    // stroops free, against a 350,412-stroop invocation fee.
    const { c, address } = await worker();
    nativeStroops = 15_000_100n;

    const err = await review(c, envelope(address, SIM_FEE)).catch((e: unknown) => e);
    const said = describeError(err);
    expect(said, `built anyway: ${said}`).toMatch(/network fee/i);
    expect(said).toMatch(/free after the network's reserve/i);
  });

  it("names the real fee, not the base fee", async () => {
    // 350,412 stroops is 0.0350412 XLM. `BASE_FEE` would have said 0.0000100.
    const { c, address } = await worker();
    nativeStroops = 15_000_100n;
    const err = await review(c, envelope(address, SIM_FEE)).catch((e: unknown) => e);
    expect(describeError(err)).toContain("0.0350412");
  });

  it("says what to do about it", async () => {
    const { c, address } = await worker();
    nativeStroops = 15_000_100n;
    const err = await review(c, envelope(address, SIM_FEE)).catch((e: unknown) => e);
    expect(describeError(err)).toMatch(/add a little XLM/i);
  });

  it("counts the reserve as unavailable, because the network does", async () => {
    // 1.6 XLM in the account with 1.5 locked leaves 0.1, which covers a
    // 0.035 fee. 1.52 leaves 0.02, which does not. The boundary is the reserve,
    // not the raw balance.
    const { c, address } = await worker();
    nativeStroops = 16_000_000n;
    await expect(review(c, envelope(address, SIM_FEE))).resolves.toBeDefined();
    nativeStroops = 15_200_000n;
    await expect(review(c, envelope(address, SIM_FEE))).rejects.toThrow(/network fee/i);
  });

  it("does not refuse an account that can afford it", async () => {
    // The guard must not become the reason a legitimate build fails.
    const { c, address } = await worker();
    await expect(review(c, envelope(address, SIM_FEE))).resolves.toBeDefined();
  });

  it("is on the path every build takes, not on one of them", async () => {
    // The property that makes this a fix rather than a seventh patch: a NEW
    // build path gets the guard by using the same choke point, and no reviewer
    // has to remember it.
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const src = readFileSync(fileURLToPath(new URL("./controller.ts", import.meta.url)), "utf8");
    const body = src.slice(src.indexOf("private async prepareForReview"));
    expect(body.slice(0, 400)).toMatch(/assertCanPayFee\(/);
  });
});
