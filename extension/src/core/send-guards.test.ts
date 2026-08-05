// Two things the send path said, or did not say, about what the user typed.
//
//   ".5" was refused with "That is not an amount Pocket can read. Use digits
//   and at most one decimal point.", about a string that is digits and one
//   decimal point. A keypad that offers "." as its own key invites exactly it.
//
//   Paying your OWN address built, confirmed and succeeded in silence. It is
//   legal on Stellar and it moves nothing: the balance ends where it started,
//   less the fee. The private pocket refuses the same shape outright, so the
//   two pockets disagreed and neither said so.
import { describe, it, expect, beforeEach, vi } from "vitest";
import "../lib/polyfill";
import { parseAmount, InvalidAmountError } from "./chain/balances";

describe("an amount typed with no whole part", () => {
  it("parses, because it is an amount", () => {
    expect(parseAmount(".5")).toBe(5_000_000n);
    expect(parseAmount(".0000001")).toBe(1n);
    expect(parseAmount("-.5")).toBe(-5_000_000n);
  });

  it("still parses every shape it always did", () => {
    expect(parseAmount("1")).toBe(10_000_000n);
    expect(parseAmount("1.")).toBe(10_000_000n);
    expect(parseAmount("1.5")).toBe(15_000_000n);
    expect(parseAmount("0.0000001")).toBe(1n);
    expect(parseAmount("-1.5")).toBe(-15_000_000n);
  });

  it("still refuses what is genuinely not an amount", () => {
    // Accepting a shorthand is not accepting nothing.
    for (const bad of [".", "-", "-.", "", "  ", "1.2.3", "abc", "1e5", "٥"]) {
      expect(() => parseAmount(bad), JSON.stringify(bad)).toThrow(InvalidAmountError);
    }
  });

  it("still refuses more precision than a stroop", () => {
    expect(() => parseAmount(".12345678")).toThrow(/7 decimal places/);
  });
});

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

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readNative: async () => ({
      raw: 1_000_000_000n,
      subEntryCount: 0,
      numSponsoring: 0,
      numSponsored: 0,
      sellingLiabilities: 0n,
    }),
  };
});

const { WalletController } = await import("./controller");
const { Account } = await import("@stellar/stellar-sdk/base");

const OTHER = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

beforeEach(() => store.clear());

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1000 }),
    prepareTransaction: async (tx: unknown) => tx,
  });
  return { c, address };
}

describe("paying your own address", () => {
  it("says the payment moves nothing", async () => {
    const { c, address } = await worker();
    const { summary } = await c.buildPayment({ to: address, amount: "1", assetId: "native" });
    expect(summary.warning ?? "", "a payment to yourself was silent").toMatch(/moves nothing/i);
  });

  it("says the fee is what it costs", async () => {
    const { c, address } = await worker();
    const { summary } = await c.buildPayment({ to: address, amount: "1", assetId: "native" });
    expect(summary.warning!).toMatch(/less the network fee/i);
  });

  it("still builds it, because it is a legal thing to do", async () => {
    // Not refused: a self-payment with a memo is a real thing people do, and
    // the wallet is not the place to forbid it.
    const { c, address } = await worker();
    await expect(
      c.buildPayment({ to: address, amount: "1", assetId: "native" }),
    ).resolves.toMatchObject({ summary: { to: address } });
  });

  it("says nothing of the sort about an ordinary payment", async () => {
    const { c } = await worker();
    const { summary } = await c.buildPayment({ to: OTHER, amount: "1", assetId: "native" });
    expect(summary.warning).toBeUndefined();
  });
});
