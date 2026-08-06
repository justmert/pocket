// The yield path signs an envelope a third party composed.
//
// DeFindex answers POST /vault/{v}/deposit with an XDR and Pocket signs it. The
// only content check used to be "does the vault appear among the invoked
// contracts", which leaves the service free to choose the entry point and every
// argument, while the confirm sheet states an amount and a direction read from
// what the USER typed rather than from the bytes being signed.
//
// The shape asserted here was decoded from a LIVE testnet deposit envelope on
// 2026-08-07 rather than taken from documentation:
//
//   deposit(Vec<i128> amounts_desired, Vec<i128> amounts_min, Address caller, bool invest)
//
// Note that amounts_min is legitimately smaller than amounts_desired, which is
// why the quantity check is an upper bound and not an equality.
import { describe, it, expect, beforeEach, vi } from "vitest";
// type-only, so it is erased and cannot run before `installChrome`.
import type { Transaction } from "@stellar/stellar-sdk/base";
import { installChrome } from "../auth/_harness/chrome";
import { fundedAccountResult } from "./_harness/ledger";

const chrome = installChrome();
const { WalletController } = await import("../../src/core/controller");
const { clearSession } = await import("../../src/core/session");
const { Account, Address, Contract, TransactionBuilder, nativeToScVal, xdr, BASE_FEE } =
  await import("@stellar/stellar-sdk/base");

const PASSWORD = "correct horse battery staple";
const PASSPHRASE = "Test SDF Network ; September 2015";
const VAULT = "CCLV4H7WTLJQ7ATLHBBQV2WW3OINF3FOY5XZ7VPHZO7NH3D2ZS4GFSF6";
const STRANGER = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";

/** i128 vector, the shape the live vault takes its amounts in. */
const amountVec = (v: bigint) => xdr.ScVal.scvVec([nativeToScVal(v, { type: "i128" })]);

/**
 * Build what DeFindex would return. Every parameter is something a hostile or
 * compromised API host gets to choose, which is the whole point.
 */
function vaultEnvelope(opts: {
  source: string;
  contract?: string;
  fn?: string;
  desired?: bigint;
  min?: bigint;
  caller?: string;
}): string {
  const tx = new TransactionBuilder(new Account(opts.source, "100"), {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      new Contract(opts.contract ?? VAULT).call(
        opts.fn ?? "deposit",
        amountVec(opts.desired ?? 10_000000n),
        amountVec(opts.min ?? 10_000000n),
        nativeToScVal(Address.fromString(opts.caller ?? opts.source)),
        xdr.ScVal.scvBool(true),
      ),
    )
    .setTimeout(180)
    .build();
  return tx.toXDR();
}

/** ~0.0044 XLM. A yield move measured on chain came back at 43,505 stroops. */
const SIM_FEE = "43505";

/**
 * The envelope simulation hands back: same bytes, resource fee added.
 *
 * Patched at the XDR level and re-parsed, because a built `Transaction` is
 * immutable and re-adding decoded operations to a builder does not round-trip
 * an `invokeHostFunction`.
 */
function withFee(tx: unknown, fee: string): unknown {
  const t = tx as { toXDR(): string; networkPassphrase: string };
  const env = xdr.TransactionEnvelope.fromXDR(t.toXDR(), "base64");
  env.v1().tx().fee(Number(fee));
  return TransactionBuilder.fromXDR(env.toXDR("base64"), t.networkPassphrase);
}

/** A wallet whose DeFindex client returns exactly the envelope a test supplies. */
async function walletWith(envelope: (address: string) => string) {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create(PASSWORD);
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    // What simulation really does to a Soroban envelope: it fills in the
    // resource fee. Returning it unchanged made every fee assertion vacuous,
    // and the fee is the whole subject of the test below.
    prepareTransaction: async (tx: unknown) => withFee(tx, SIM_FEE),
    getLedgerEntries: async () => fundedAccountResult(address, 100_0000000n),
    _getLedgerEntries: async () => fundedAccountResult(address, 100_0000000n),
  });
  // The vault and key have to look configured, or the guard never runs.
  const { NETWORKS } = await import("../../src/core/config");
  NETWORKS.testnet.defindex = {
    baseUrl: "https://api.defindex.io",
    apiKey: "test-key",
    vault: VAULT,
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ xdr: envelope(address) }),
    })) as unknown as typeof fetch,
  );
  return { c, address };
}

beforeEach(async () => {
  chrome.local.clear();
  chrome.session.clear();
  clearSession();
  vi.restoreAllMocks();
});

describe("what the yield path will and will not sign", () => {
  it("accepts the envelope the live API actually returns", async () => {
    // The control. Without it every refusal below is satisfied by a build path
    // that simply does not work.
    const { c } = await walletWith((address) => vaultEnvelope({ source: address }));
    await expect(c.buildYieldMove("deposit", "1")).resolves.toMatchObject({
      handle: expect.any(String),
      summary: { kind: "deposit" },
    });
  });

  it("refuses a different function on the right contract", async () => {
    // The attack the old check could not see. `transfer` and `approve` are both
    // exported by a vault, and the sheet would still read "Deposit 1".
    const { c } = await walletWith((address) => vaultEnvelope({ source: address, fn: "transfer" }));
    await expect(c.buildYieldMove("deposit", "1")).rejects.toThrow(/rather than "deposit"/);
  });

  it("refuses a withdraw envelope returned for a deposit", async () => {
    const { c } = await walletWith((address) => vaultEnvelope({ source: address, fn: "withdraw" }));
    await expect(c.buildYieldMove("deposit", "1")).rejects.toThrow(/rather than "deposit"/);
  });

  it("refuses an envelope naming somebody else as the caller", async () => {
    // The address lives inside the argument list, so a check that read only the
    // invoked contract never saw it.
    const { c } = await walletWith((address) =>
      vaultEnvelope({ source: address, caller: STRANGER }),
    );
    await expect(c.buildYieldMove("deposit", "1")).rejects.toThrow(/not yours/);
  });

  it("refuses an amount larger than the one the user typed", async () => {
    // The shown-versus-signed gap: the sheet renders the typed amount, so
    // without this the user approves 1 and signs 1000.
    const { c } = await walletWith((address) =>
      vaultEnvelope({ source: address, desired: 1000_0000000n, min: 1000_0000000n }),
    );
    await expect(c.buildYieldMove("deposit", "1")).rejects.toThrow(/more than the amount/);
  });

  it("refuses an inflated amount even when it hides in the slippage floor", async () => {
    // Both vectors are walked, not just the first.
    const { c } = await walletWith((address) =>
      vaultEnvelope({ source: address, desired: 1_0000000n, min: 500_0000000n }),
    );
    await expect(c.buildYieldMove("deposit", "1")).rejects.toThrow(/more than the amount/);
  });

  it("allows a slippage floor below the amount, which is the honest case", async () => {
    // The bound is an upper one on purpose. A vault legitimately takes a
    // desired amount and a smaller minimum, and requiring equality would refuse
    // a correct envelope.
    const { c } = await walletWith((address) =>
      vaultEnvelope({ source: address, desired: 1_0000000n, min: 9_900000n }),
    );
    await expect(c.buildYieldMove("deposit", "1")).resolves.toMatchObject({
      summary: { kind: "deposit" },
    });
  });

  it("refuses an envelope aimed at a contract that is not the vault", async () => {
    const { c } = await walletWith((address) =>
      vaultEnvelope({
        source: address,
        contract: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      }),
    );
    await expect(c.buildYieldMove("deposit", "1")).rejects.toThrow(/configured vault/);
  });

  it("refuses an envelope carrying more than one operation", async () => {
    // Soroban permits exactly one operation per transaction and the SDK enforces
    // it at prepare time, so this is belt and braces. It is worth holding
    // anyway: the refusal should be ours, at build time, not a TypeError from a
    // dependency after the user has already reviewed the screen.
    const { c } = await walletWith((address) => {
      const tx = new TransactionBuilder(new Account(address, "100"), {
        fee: BASE_FEE,
        networkPassphrase: PASSPHRASE,
      })
        .addOperation(new Contract(VAULT).call("deposit", amountVec(1n)))
        .addOperation(new Contract(VAULT).call("deposit", amountVec(1n)))
        .setTimeout(180)
        .build();
      return tx.toXDR();
    });
    await expect(c.buildYieldMove("deposit", "1")).rejects.toThrow(
      /single contract call|configured vault/,
    );
  });
});

describe("an envelope Pocket cannot time out is never submitted", () => {
  // `submitAndConfirm` states the precondition in words: a transaction without
  // timeBounds has an undecidable expiry, so a stuck one can never be safely
  // rebuilt. Nothing enforced it, and DeFindex returns maxTime 0 on every
  // envelope (verified against the live API, 2026-08-07).
  //
  // The consequence is not a stuck transaction, it is a stuck WALLET:
  // `inFlight()` can never report expired, `assertNothingUnresolved` then
  // refuses every later build, and the only user-reachable exit is erase, which
  // removes every opening blob.
  const boundless = (address: string) => {
    const tx = new TransactionBuilder(new Account(address, "100"), {
      fee: BASE_FEE,
      networkPassphrase: PASSPHRASE,
      timebounds: { minTime: 0, maxTime: 0 },
    })
      .addOperation(
        new Contract(VAULT).call(
          "deposit",
          amountVec(10_000000n),
          amountVec(10_000000n),
          nativeToScVal(Address.fromString(address)),
          xdr.ScVal.scvBool(true),
        ),
      )
      .build();
    return tx.toXDR();
  };

  it("rebinds a boundless third-party envelope instead of refusing it", async () => {
    // Refusing outright would mean a service that omits time bounds simply
    // cannot be used, so the envelope is rebuilt on the wallet's own 180s
    // window. The build must succeed AND the stored envelope must be expirable.
    const { c } = await walletWith(boundless);
    const { handle } = await c.buildYieldMove("deposit", "1");
    const pending = (c as unknown as { pending: Map<string, { xdr: string }> }).pending.get(handle);
    expect(pending, "nothing was staged under the returned handle").toBeTruthy();
    const stored = TransactionBuilder.fromXDR(pending!.xdr, PASSPHRASE);
    const maxTime = Number((stored as Transaction).timeBounds?.maxTime ?? 0);
    expect(maxTime, "the stored envelope is still unbounded").toBeGreaterThan(0);
    expect(maxTime).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 3600);
  });

  it("keeps the invocation intact through the rebind", async () => {
    // cloneFrom copies operations verbatim. If it did not, the rebind would
    // quietly change what is being signed, which is the defect it exists to
    // prevent, and the assertions above would be checking the wrong bytes.
    const { c, address } = await walletWith(boundless);
    const { handle } = await c.buildYieldMove("deposit", "1");
    const pending = (c as unknown as { pending: Map<string, { xdr: string }> }).pending.get(
      handle,
    )!;
    const stored = TransactionBuilder.fromXDR(pending.xdr, PASSPHRASE) as Transaction;
    expect(stored.source).toBe(address);
    expect(stored.operations).toHaveLength(1);
    const op = stored.operations[0] as { type: string; func: { invokeContract(): unknown } };
    expect(op.type).toBe("invokeHostFunction");
  });
});

describe("the expiry check sits on the submit path, not only the build path", () => {
  it("refuses to sign when simulation hands back an envelope with no expiry", async () => {
    // `prepareTransaction` rewrites the envelope after review, so the bytes that
    // get signed are not the bytes that were checked at build time. The guard
    // therefore has to sit at the point every submission passes through. Here
    // the RPC strips the bounds, which is what a hostile or broken one does.
    const { c, address } = await walletWith((addr) => vaultEnvelope({ source: addr }));
    const { handle } = await c.buildYieldMove("deposit", "1");
    (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
      getAccount: async () => new Account(address, "100"),
      prepareTransaction: async (tx: Transaction) =>
        TransactionBuilder.cloneFrom(tx, { timebounds: { minTime: 0, maxTime: 0 } }).build(),
      getLedgerEntries: async () => fundedAccountResult(address, 100_0000000n),
      _getLedgerEntries: async () => fundedAccountResult(address, 100_0000000n),
    });
    await expect(c.confirmYieldMove(handle)).rejects.toThrow(/no expiry|cannot time out/i);
  });
});

/**
 * The fee on the yield review is the fee that gets charged.
 *
 * `withOwnDeadline` rebuilds a third-party envelope through `cloneFrom`, which
 * DROPS the Soroban resource data DeFindex had put on it, and nothing put it
 * back before the sheet was drawn. So the review quoted the bare 105 stroops
 * the clone carried, 0.0000105 XLM, for a transaction that lands at around
 * 43,505: two orders of magnitude out, on the one figure a confirm screen
 * exists to state.
 */
describe("what the yield review says the fee is", () => {
  it("quotes the simulated fee, not the one the clone was left with", async () => {
    const { c } = await walletWith((address) => vaultEnvelope({ source: address }));
    const { summary } = await c.buildYieldMove("deposit", "10");

    expect(summary.fee, "the review quoted the base fee for a Soroban invocation").not.toBe(
      "0.0000105",
    );
    expect(summary.fee).toBe("0.0043505");
  });

  it("stages the SIMULATED envelope, so the reviewed bytes are the signed bytes", async () => {
    // The handle is the prepared envelope's hash. Staging the pre-simulation
    // one would mean the fee on the sheet belonged to a transaction that was
    // never sent.
    const { c } = await walletWith((address) => vaultEnvelope({ source: address }));
    const { handle } = await c.buildYieldMove("deposit", "10");
    const entry = (c as unknown as { pending: Map<string, { xdr: string }> }).pending.get(handle)!;
    const staged = TransactionBuilder.fromXDR(entry.xdr, PASSPHRASE) as { fee: string };
    expect(staged.fee).toBe(SIM_FEE);
  });
});
