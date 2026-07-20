// Paying an address that does not exist yet has to CREATE it.
//
// `doBuildPayment` always built a classic PaymentOp, and the wallet emitted
// `createAccount` nowhere at all: a grep over src finds it only in history
// decoding and the dApp describe table. A PaymentOp to an unfunded address can
// never succeed. Measured on testnet, tx
// 45d35eb8bfea22f7107f4b1dd5165305ce5ad4065c334331d94cacdeb3f118f0: submitted
// PENDING, final status FAILED, tx result `txFailed`, operation result
// `paymentNoDestination`, fee charged 100 stroops.
//
// So sending to a friend's brand-new Stellar address failed every time, took a
// fee, consumed the sequence number, and said only "failed on chain
// (txFailed)". Nothing anywhere told the user the address has to be created
// first, or that creating it needs a minimum balance.
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

/** Accounts the ledger has. Anything else reads as not found. */
let funded = new Set<string>();
/** Set when the destination read should FAIL rather than answer either way. */
let readThrows = false;

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const { AccountNotFoundError } = real as { AccountNotFoundError: new (m: string) => Error };
  return {
    ...real,
    readNative: async (_s: unknown, who: string) => {
      if (readThrows && !funded.has(who)) throw new Error("fetch failed");
      if (!funded.has(who)) throw new AccountNotFoundError("no such account");
      return {
        raw: 1_000_000_000n,
        subEntryCount: 0,
        numSponsoring: 0,
        numSponsored: 0,
        sellingLiabilities: 0n,
      };
    },
    // The SENDER holds the credit asset, so `assertCanSpend` passes and the
    // destination check below is the one that decides. Without this the spend
    // guard refuses first and the test proves nothing about the destination.
    readTrustline: async (
      _s: unknown,
      who: string,
      asset: { getCode(): string; getIssuer(): string },
    ) =>
      funded.has(who)
        ? {
            id: `${asset.getCode()}:${asset.getIssuer()}`,
            code: asset.getCode(),
            issuer: asset.getIssuer(),
            limit: 10n ** 18n,
            raw: 1_000_0000000n,
            sellingLiabilities: 0n,
            authorized: true,
          }
        : null,
  };
});

const { WalletController } = await import("./controller");
const { Account, TransactionBuilder, Networks } = await import("@stellar/stellar-sdk/base");

const NEW_ACCOUNT = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

beforeEach(() => {
  store.clear();
  funded = new Set();
  readThrows = false;
});

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  funded.add(address);
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1000 }),
    prepareTransaction: async (tx: unknown) => tx,
    getLedgerEntries: async () => ({ entries: [] }),
  });
  return { c, address };
}

/** The operation the built envelope actually carries. */
function opName(xdrOrHandle: string, c: unknown): string {
  const entry = (c as { pending: Map<string, { xdr: string }> }).pending.get(xdrOrHandle);
  const tx = TransactionBuilder.fromXDR(entry!.xdr, Networks.TESTNET) as unknown as {
    operations: { type: string }[];
  };
  return tx.operations[0]!.type;
}

describe("sending to an address that does not exist yet", () => {
  it("builds createAccount, not payment", async () => {
    const { c } = await worker();
    const { xdr } = await c.buildPayment({ to: NEW_ACCOUNT, amount: "5", assetId: "native" });
    expect(opName(xdr, c), "a payment to an unfunded address can never succeed").toBe(
      "createAccount",
    );
  });

  it("says on the review that it is creating the account", async () => {
    // The signed operation is a different act from the one the screen used to
    // describe, and most of the amount becomes locked reserve.
    const { c } = await worker();
    const { summary } = await c.buildPayment({
      to: NEW_ACCOUNT,
      amount: "5",
      assetId: "native",
    });
    const said = summary.effects.join(" ");
    expect(said).toMatch(/CREATE this account/);
    expect(said).toMatch(/minimum balance/);
  });

  it("refuses below the minimum a new account needs, before any fee is paid", async () => {
    // Stellar refuses a createAccount under two base reserves. Refused here
    // costs nothing; refused on chain costs the fee and the sequence number.
    const { c } = await worker();
    await expect(
      c.buildPayment({ to: NEW_ACCOUNT, amount: "0.5", assetId: "native" }),
    ).rejects.toThrow(/needs at least 1\.0000000 XLM/);
  });

  it("refuses a credit asset to an account that does not exist", async () => {
    // There is no operation that opens an account and delivers a credit asset
    // in one step, so this names the two steps instead of failing on chain.
    const { c } = await worker();
    const { NETWORKS } = await import("./config");
    const known = NETWORKS.testnet.knownAssets?.[0];
    if (!known) return;
    await expect(
      c.buildPayment({
        to: NEW_ACCOUNT,
        amount: "5",
        assetId: `${known.code}:${known.issuer}`,
      }),
    ).rejects.toThrow(/Send it XLM first to create it/);
  });
});

describe("sending to an address that does exist", () => {
  it("still builds an ordinary payment", async () => {
    // The control. Every assertion above is satisfied by a wallet that has
    // stopped paying anyone.
    const { c } = await worker();
    funded.add(NEW_ACCOUNT);
    const { xdr } = await c.buildPayment({ to: NEW_ACCOUNT, amount: "5", assetId: "native" });
    expect(opName(xdr, c)).toBe("payment");
  });

  it("says nothing about creating anything", async () => {
    const { c } = await worker();
    funded.add(NEW_ACCOUNT);
    const { summary } = await c.buildPayment({
      to: NEW_ACCOUNT,
      amount: "5",
      assetId: "native",
    });
    expect(summary.effects.join(" ")).not.toMatch(/CREATE this account/);
  });
});

describe("when the ledger cannot be asked whether the destination exists", () => {
  it("refuses rather than guessing it is absent", async () => {
    // Concluding "absent" from a failed read turns an ordinary payment into a
    // createAccount, which fails on chain against an account that DOES exist
    // and charges for it. Two wrong answers instead of one.
    const { c } = await worker();
    readThrows = true;
    await expect(
      c.buildPayment({ to: NEW_ACCOUNT, amount: "5", assetId: "native" }),
    ).rejects.toThrow(/fetch failed/);
  });
});
