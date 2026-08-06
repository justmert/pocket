// The exact-spendable payment that could never have worked.
//
// The compose screen shows a spendable figure that is the balance minus the
// protocol reserve. The FEE comes out of that same balance, and the worker's
// guard did not count it, so typing the shown figure by hand passed every check
// the wallet makes and then failed on chain as `txINSUFFICIENT_BALANCE` for
// want of 100 stroops: a fee charged, a sequence number consumed, and an opaque
// error. That guard's own comment says it exists so this cannot happen.
//
// "Use max" was the only path that got it right, because `sendableAfterFee`
// subtracts the fee there. So the correct behaviour already existed on one
// route and not on the one a careful user takes.
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

const { WalletController } = await import("./controller");
const { Account, BASE_FEE } = await import("@stellar/stellar-sdk/base");
const { formatAmount, parseAmount, minimumBalance, sendableAfterFee } = await import(
  "./chain/balances"
);

const TO = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const BASE_RESERVE = 5_000_000n;

/** A plain funded account: two base entries, nothing sponsored. */
const ACCOUNT_SHAPE = { subEntryCount: 0, numSponsoring: 0, numSponsored: 0 };
const RESERVE = minimumBalance(ACCOUNT_SHAPE, BASE_RESERVE);

let balanceStroops: bigint;
/** The USDC trustline the ledger reports, or null for "no trustline". */
let line: { raw: bigint; sellingLiabilities: bigint; authorized: boolean } | null = null;
/** Stroops committed to open offers made in some other wallet. */
let locked: bigint;

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readNative: async () => ({ ...ACCOUNT_SHAPE, raw: balanceStroops, sellingLiabilities: locked }),
    readTrustline: async (
      _s: unknown,
      _a: string,
      asset: { getCode(): string; getIssuer(): string },
    ) =>
      line === null
        ? null
        : {
            id: `${asset.getCode()}:${asset.getIssuer()}`,
            code: asset.getCode(),
            issuer: asset.getIssuer(),
            limit: 10n ** 18n,
            ...line,
          },
  };
});

beforeEach(() => {
  store.clear();
  balanceStroops = 100_000_000n; // 10 XLM
  locked = 0n;
});

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    prepareTransaction: async (tx: unknown) => tx,
  });
  return { c, address };
}

const send = (c: InstanceType<typeof WalletController>, amount: string) =>
  c.buildPayment({ to: TO, amount, assetId: "native" });

describe("what the native guard counts as sendable", () => {
  const unreserved = () => balanceStroops - RESERVE - locked;
  const fee = BigInt(BASE_FEE);

  it("refuses the unreserved figure exactly, because the fee comes out of it too", async () => {
    const { c } = await worker();
    // The number the compose screen shows, typed by hand. It builds, signs,
    // submits and fails on chain if this guard lets it through.
    await expect(send(c, formatAmount(unreserved()))).rejects.toThrow(/more than you can send/i);
  });

  it("says where the money went, naming the reserve AND the fee", async () => {
    const { c } = await worker();
    // A refusal that lists only the reserve cannot explain why a number the
    // wallet itself displayed is too large.
    await expect(send(c, formatAmount(unreserved()))).rejects.toThrow(/after the reserve and fee/i);
  });

  it("allows the unreserved figure minus the fee, which is what max produces", async () => {
    const { c } = await worker();
    // Not merely "some smaller number": exactly what "use max" puts in the
    // field. The guard and that button now agree, which is the invariant.
    const max = sendableAfterFee(formatAmount(unreserved()), fee);
    expect(parseAmount(max)).toBe(unreserved() - fee);
    await expect(send(c, max)).resolves.toBeTruthy();
  });

  it("still refuses one stroop above the fee-adjusted figure", async () => {
    const { c } = await worker();
    await expect(send(c, formatAmount(unreserved() - fee + 1n))).rejects.toThrow(
      /more than you can send/i,
    );
  });

  it("does not go negative on an account that cannot even cover the reserve", async () => {
    balanceStroops = RESERVE - 1n;
    const { c } = await worker();
    await expect(send(c, "0.0000001")).rejects.toThrow(/more than you can send/i);
  });
});

describe("stroops the protocol has already committed elsewhere", () => {
  it("does not offer to send XLM that is sitting in an open offer", async () => {
    // Pocket makes no offers, which is exactly why this was easy to miss: the
    // same G-address can hold offers made in any other wallet, and the protocol
    // refuses a payment that dips into them. The v1 account extension carrying
    // them was already being read, for sponsorship, and its `liabilities()`
    // were stepped straight over.
    locked = 30_000_000n; // 3 XLM committed to a sell offer
    const { c } = await worker();
    const fee = BigInt(BASE_FEE);

    // What the account would have been told it could send before: everything
    // above the reserve, offer and all.
    const asIfUncommitted = balanceStroops - RESERVE - fee;
    await expect(send(c, formatAmount(asIfUncommitted))).rejects.toThrow(/more than you can send/i);

    // And what it can actually send.
    const real = balanceStroops - RESERVE - locked - fee;
    await expect(send(c, formatAmount(real))).resolves.toBeTruthy();
  });
});

describe("sending an asset that is not XLM", () => {
  // The over-balance refusal lived inside `if (asset.isNative())`, from a time
  // when XLM was the only sendable thing. The picker offers USDC now, so a
  // credit-asset payment for more than the trustline holds went to the network
  // unchecked and came back opaque, with a fee paid.
  const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const USDC = `USDC:${ISSUER}`;

  beforeEach(() => {
    line = { raw: 50_000_000n, sellingLiabilities: 0n, authorized: true };
  });

  const withLine = () => worker();

  it("refuses more than the trustline holds", async () => {
    const { c } = await withLine();
    await expect(c.buildPayment({ to: TO, amount: "6", assetId: USDC })).rejects.toThrow(
      /more than you can send/i,
    );
  });

  it("says the account does not hold it, rather than 'insufficient balance'", async () => {
    // Three different reasons, three different sentences. "No trustline" and
    // "not enough" are not the same problem and do not have the same fix.
    line = null;
    const { c } = await withLine();
    await expect(c.buildPayment({ to: TO, amount: "1", assetId: USDC })).rejects.toThrow(
      /does not hold USDC/,
    );
  });

  it("says the issuer has frozen it, when that is the reason", async () => {
    line = { raw: 50_000_000n, sellingLiabilities: 0n, authorized: false };
    const { c } = await withLine();
    await expect(c.buildPayment({ to: TO, amount: "1", assetId: USDC })).rejects.toThrow(
      /not authorised/i,
    );
  });

  it("allows what the trustline really holds", async () => {
    const { c } = await withLine();
    await expect(c.buildPayment({ to: TO, amount: "5", assetId: USDC })).resolves.toBeTruthy();
  });

  it("subtracts the asset's own selling liabilities but NOT the XLM fee", async () => {
    // The fee is paid in XLM. Deducting it from a USDC balance would refuse a
    // payment the network would have accepted.
    line = { raw: 50_000_000n, sellingLiabilities: 10_000_000n, authorized: true };
    const { c } = await withLine();
    await expect(c.buildPayment({ to: TO, amount: "4.1", assetId: USDC })).rejects.toThrow(
      /more than you can send/i,
    );
    await expect(c.buildPayment({ to: TO, amount: "4", assetId: USDC })).resolves.toBeTruthy();
  });
});
