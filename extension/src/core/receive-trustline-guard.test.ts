// Every path that DELIVERS a classic asset checks the destination can hold it.
//
// A classic credit asset arriving at a G address needs a trustline there. The
// SAC refuses without one, with `Error(Contract, #13)` ("trustline entry is
// missing for account"), measured against
// CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA on testnet. The SDK
// raises that as a bare `Error`, whose name is on neither allowlist in
// `dispatch.ts`, so it reached the user as "Something went wrong. Try again,
// and check your connection." about a deterministic refusal that no retry can
// affect and whose remedy is one button away.
//
// Three paths end in that same transfer and only ONE of them checked:
//
//   swap        checked, and was the only one
//   unshield    `withdraw` ends in token.transfer(contract, to, amount) on the
//               underlying SAC (storage.rs:629-630), AFTER a proof that can
//               take 165 seconds
//   CCTP claim  `mint_and_forward` mints to a forwarder then transfers to the
//               recipient G address (measured on tx 7793604b)
//
// That is the shape the last audit found five times: fixed on one surface, live
// on the others. One method now, so there is one rule.
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

/** The account's native balance, in stroops. */
let poorNative = 1_000_000_000n;

/** The USDC trustline, or null for "no trustline at all". */
let usdcLine: { raw: bigint; sellingLiabilities: bigint; authorized: boolean } | null = null;

vi.mock("./chain/balances", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    readNative: async () => ({
      raw: poorNative,
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
      asset.isNative() || usdcLine === null
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

// Reached only if the guard let the build through, which is the point: a test
// expecting a trustline refusal that gets one of these has caught a guard that
// did not fire.
const TOO_FAR = "the build got past the receive guard";

vi.mock("./integrations/iris", async (orig) => {
  const real = (await orig()) as Record<string, unknown>;
  return {
    ...real,
    IrisClient: class {
      async attestation() {
        throw new Error(TOO_FAR);
      }
    },
  };
});

const { WalletController } = await import("./controller");
const { NETWORKS } = await import("./config");
const { Account } = await import("@stellar/stellar-sdk/base");

const LIST = NETWORKS.testnet.confidential;
/** The USDC wrapper, whose underlying is a classic SAC. */
const USDC_WRAPPER = LIST.find((c) => c.symbol === "USDC");
const USDC_ISSUER = NETWORKS.testnet.knownAssets?.find((a) => a.code === "USDC")?.issuer ?? "";

beforeEach(() => {
  store.clear();
  usdcLine = null;
  poorNative = 1_000_000_000n;
});

async function worker() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create("pw");
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1000 }),
    prepareTransaction: async (tx: unknown) => tx,
    getLedgerEntries: async () => ({ entries: [] }),
  });
  return { c, address };
}

/** A private pocket holding `value` of the wrapper's asset. */
async function seedPrivate(address: string, token: string, value: bigint) {
  const { openingKey } = await import("../lib/storage");
  const { sealPayload } = await import("./vault/vault");
  const { requireSession } = await import("./session");
  store.set(
    openingKey(token, address),
    await sealPayload(requireSession().dek, {
      spendable: { value: value.toString(), randomness: "7" },
      receiving: { value: "0", randomness: "0" },
      syncedThrough: 0,
    }),
  );
}

describe("unshielding a classic asset with no trustline for it", () => {
  it("is refused BEFORE the proof, not after it", async () => {
    // The wait is the point. Checked after proving, the user spends up to 165
    // seconds to be told to check their connection.
    if (!USDC_WRAPPER) return;
    const { c, address } = await worker();
    await seedPrivate(address, USDC_WRAPPER.token, 5_000_000n);

    await expect(
      c.buildPrivateOp({ kind: "unshield", amount: "0.5" }, USDC_WRAPPER.token),
    ).rejects.toThrow(/trustline before you can receive it/i);
  });

  it("names the asset and the action, so the sentence is actionable", async () => {
    if (!USDC_WRAPPER) return;
    const { c, address } = await worker();
    await seedPrivate(address, USDC_WRAPPER.token, 5_000_000n);

    const err = await c
      .buildPrivateOp({ kind: "unshield", amount: "0.5" }, USDC_WRAPPER.token)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    // The NAME is what makes the sentence reach the user at all: dispatch.ts
    // keeps its allowlist by error name, and a bare Error becomes "check your
    // connection".
    expect((err as Error).name).toBe("TrustlineRequiredError");
    expect((err as Error).message).toMatch(/USDC/);
    expect((err as Error).message).toMatch(/unshield/);
    expect((err as Error).message).not.toMatch(/connection/i);
  });

  it("is refused when the trustline exists but the issuer has not authorised it", async () => {
    // A balance that cannot be received is not a balance. The SAC refuses this
    // case too, and it is invisible on the asset list.
    if (!USDC_WRAPPER) return;
    const { c, address } = await worker();
    usdcLine = { raw: 0n, sellingLiabilities: 0n, authorized: false };
    await seedPrivate(address, USDC_WRAPPER.token, 5_000_000n);

    await expect(
      c.buildPrivateOp({ kind: "unshield", amount: "0.5" }, USDC_WRAPPER.token),
    ).rejects.toThrow(/not authorised by its issuer/i);
  });

  it("lets a native unshield through, which needs no trustline at all", async () => {
    // The control. Every assertion above is satisfied by a guard that refuses
    // everything, and XLM has no trustline to check.
    const xlm = LIST.find((c) => c.symbol === "XLM");
    if (!xlm) return;
    const { c, address } = await worker();
    await seedPrivate(address, xlm.token, 5_000_000n);

    const err = await c
      .buildPrivateOp({ kind: "unshield", amount: "0.1" }, xlm.token)
      .catch((e: Error) => e);
    expect((err as Error)?.name).not.toBe("TrustlineRequiredError");
  });
});

describe("claiming a bridged transfer into an account that cannot hold USDC", () => {
  it("is refused before Circle is even asked", async () => {
    // The user has already bridged the money by this point, so the sentence
    // they get is the whole of their experience of the failure.
    const { c } = await worker();
    const err = await c.buildCctpClaim(0, "a".repeat(64)).catch((e: Error) => e);
    expect((err as Error).name).toBe("TrustlineRequiredError");
    expect((err as Error).message).toMatch(/claim/);
    expect((err as Error).message, "the attestation was fetched first").not.toBe(TOO_FAR);
  });

  it("gets past the guard once the trustline is there", async () => {
    // The control: with a trustline the claim proceeds to the attestation,
    // which this test stubs into a recognisable throw.
    const { c } = await worker();
    usdcLine = { raw: 0n, sellingLiabilities: 0n, authorized: true };
    const err = await c.buildCctpClaim(0, "a".repeat(64)).catch((e: Error) => e);
    expect((err as Error).message).toBe(TOO_FAR);
  });
});

describe("removing a trustline the private pocket still delivers through", () => {
  it("is refused while private funds are still inside", async () => {
    // The classic balance is zero, which is all the old check looked at. The
    // private pocket for the same asset comes back out THROUGH this line.
    if (!USDC_WRAPPER || !USDC_ISSUER) return;
    const { c, address } = await worker();
    usdcLine = { raw: 0n, sellingLiabilities: 0n, authorized: true };
    await seedPrivate(address, USDC_WRAPPER.token, 5_000_000n);

    await expect(c.buildRemoveTrustline("USDC", USDC_ISSUER)).rejects.toThrow(
      /private pocket still holds/i,
    );
  });

  it("says how much is in there and what to do about it", async () => {
    if (!USDC_WRAPPER || !USDC_ISSUER) return;
    const { c, address } = await worker();
    usdcLine = { raw: 0n, sellingLiabilities: 0n, authorized: true };
    await seedPrivate(address, USDC_WRAPPER.token, 5_000_000n);

    const err = await c.buildRemoveTrustline("USDC", USDC_ISSUER).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/0\.5000000 USDC/);
    expect((err as Error).message).toMatch(/[Uu]nshield it first/);
  });

  it("allows the removal once the private pocket is empty too", async () => {
    // The control. A guard that never permits a removal is not a guard.
    if (!USDC_WRAPPER || !USDC_ISSUER) return;
    const { c, address } = await worker();
    usdcLine = { raw: 0n, sellingLiabilities: 0n, authorized: true };
    await seedPrivate(address, USDC_WRAPPER.token, 0n);

    await expect(c.buildRemoveTrustline("USDC", USDC_ISSUER)).resolves.toMatchObject({
      handle: expect.any(String),
    });
  });
});

describe("adding a trustline the account cannot afford", () => {
  // A trustline is a SUBENTRY and every subentry raises the minimum balance by
  // one base reserve. This path read the native balance nowhere at all, so an
  // account that could not afford the new reserve was taken to a confirm screen
  // and refused on chain, having paid the fee for the privilege.
  const ISSUER = "GCY7W6TM623NI5TNN3YA6BQ2L6DMRCFJUDXZT447OLSKUJE67J7GTIU4";

  it("is refused before anything is built", async () => {
    const { c } = await worker();
    // 1.5 XLM covers the base 2 entries plus one existing subentry with nothing
    // spare, so a second subentry cannot be afforded.
    poorNative = 15_000_000n;
    await expect(c.buildAddTrustline("EURC", ISSUER)).rejects.toThrow(/Add about .* XLM first/);
  });

  it("says how much more the account needs", async () => {
    const { c } = await worker();
    poorNative = 15_000_000n;
    const err = await c.buildAddTrustline("EURC", ISSUER).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Add about 0\.5000100 XLM first\./);
  });

  it("allows it when the reserve is covered", async () => {
    // The control. A guard that refuses every trustline is not a guard.
    const { c } = await worker();
    poorNative = 1_000_000_000n;
    await expect(c.buildAddTrustline("EURC", ISSUER)).resolves.toMatchObject({
      handle: expect.any(String),
    });
  });
});

describe("adding an asset that is not what it looks like", () => {
  const ISSUER = "GCY7W6TM623NI5TNN3YA6BQ2L6DMRCFJUDXZT447OLSKUJE67J7GTIU4";

  it("refuses a classic asset whose code is XLM", async () => {
    // `new Asset("XLM", "G...")` is credit_alphanum4 and isNative() is FALSE, so
    // the native guard passed it. A trustline then opened for someone else's
    // "XLM", which sat in the asset list beside the real balance wearing the
    // same three letters, with only the issuer telling them apart.
    const { c } = await worker();
    await expect(c.buildAddTrustline("XLM", ISSUER)).rejects.toThrow(/not real XLM/i);
  });

  it("refuses the lowercase spelling too", async () => {
    const { c } = await worker();
    await expect(c.buildAddTrustline("xlm", ISSUER)).rejects.toThrow(/not real XLM/i);
  });

  it("refuses adding a trustline the account already holds", async () => {
    // changeTrust on an existing line SUCCEEDS and rewrites its limit, so
    // re-adding silently reset a custom limit to the maximum and charged a fee
    // to change nothing the user asked to change.
    const { c } = await worker();
    usdcLine = { raw: 5_0000000n, sellingLiabilities: 0n, authorized: true };
    await expect(c.buildAddTrustline("USDC", ISSUER)).rejects.toThrow(/already hold this asset/i);
  });

  it("still adds one the account does not hold", async () => {
    // The control, again: a guard that refuses everything is not a guard.
    const { c } = await worker();
    usdcLine = null;
    await expect(c.buildAddTrustline("USDC", ISSUER)).resolves.toMatchObject({
      handle: expect.any(String),
    });
  });
});
