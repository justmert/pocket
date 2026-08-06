// "Your assets" on a wallet that has never been funded.
//
// The Settings row is ungated, `trustlines()` maps Horizon's 404 to an empty
// list, and the screen drew "You have no assets added. Get started by adding an
// asset." over that emptiness: an invitation to do something the account cannot
// do. Pressing it reached `server().getAccount`, which throws a bare
// `Error("Account not found: G...")`. "Error" is on no allowlist, so the answer
// was "Something went wrong. Try again." for a
// connection that is working and a retry that can never succeed.
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

/** Does the account exist on the ledger this test? */
let funded = false;

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  const AccountNotFoundError = real.AccountNotFoundError as new (a: string) => Error;
  return {
    ...real,
    readNative: async (_s: unknown, who: string) => {
      // What the real reader does for an account Horizon answers 404 for.
      if (!funded) throw new AccountNotFoundError(who);
      return {
        raw: 100_000_000n,
        subEntryCount: 0,
        numSponsoring: 0,
        numSponsored: 0,
        sellingLiabilities: 0n,
      };
    },
    readTrustline: async () => null,
  };
});

const { WalletController } = await import("./controller");
const { describeError } = await import("./dispatch");
const { Account } = await import("@stellar/stellar-sdk/base");

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

beforeEach(() => {
  store.clear();
  funded = false;
});

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    // What the SDK really does for an unknown account, so a guard that fails to
    // fire is caught by the sentence this produces rather than by a stub's.
    getAccount: async () => {
      if (!funded) throw new Error(`Account not found: ${address}`);
      return new Account(address, "100");
    },
  });
  return c;
}

describe("adding an asset to an account that is not on the ledger", () => {
  it("says the account does not exist, not that something went wrong", async () => {
    const c = await worker();
    const err = await c.buildAddTrustline("USDC", USDC_ISSUER).catch((e: unknown) => e);

    const said = describeError(err);
    expect(said, "a missing account fell through to the generic refusal").not.toMatch(
      /Something went wrong/i,
    );
    expect(said).toBe("Receive XLM to activate this account.");
  });

  it("says what to do about it", async () => {
    const c = await worker();
    const err = await c.buildAddTrustline("USDC", USDC_ISSUER).catch((e: unknown) => e);
    expect(describeError(err)).toMatch(/receive XLM to activate/i);
  });

  it("never leaks the address the RPC decoded back into the sentence", async () => {
    // `Account not found: G...` interpolates a value from the RPC's own reply,
    // which is the reason `describeError` is an allowlist at all.
    const c = await worker();
    const err = await c.buildAddTrustline("USDC", USDC_ISSUER).catch((e: unknown) => e);
    expect(describeError(err)).not.toMatch(/Account not found/);
  });

  it("still builds normally once the account exists", async () => {
    // The guard must not become the reason a legitimate add fails.
    funded = true;
    const c = await worker();
    await expect(c.buildAddTrustline("USDC", USDC_ISSUER)).resolves.toMatchObject({
      summary: { assetCode: "USDC" },
    });
  });
});
