// Nothing is built while an earlier submission is still unresolved.
//
// "Unresolved" means submitted, not yet known to have landed or failed, and
// still inside its time bounds. Building a second transaction then takes the
// sequence number the first was built against. Whichever lands first, the other
// is destroyed, and the user paid a fee for both.
//
// The unfinished-transaction screen only appears when the popup MOUNTS, so a
// popup left open through a timeout walks straight past it. The guard has to sit
// in the worker, where nothing can route around it.
//
// Written because reverting the guard, and separately reverting the merge
// exemption's narrowing, turned nothing red. The guard existed, the reasoning
// behind it was written down, and no test held either in place.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { installChrome } from "../auth/_harness/chrome";
import { fundedAccountResult } from "./_harness/ledger";

const chrome = installChrome();
const { WalletController, UnresolvedTransactionError } = await import("../../src/core/controller");
const { KEYS, writeLocal, removeLocal } = await import("../../src/lib/storage");
const { clearSession } = await import("../../src/core/session");
const { Account } = await import("@stellar/stellar-sdk/base");

const PASSWORD = "correct horse battery staple";

async function wallet() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create(PASSWORD);
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    prepareTransaction: async (tx: unknown) => tx,
    // A funded account, because the reserve check is real: `buildPayment`
    // reads the native balance and refuses to send more than the reserve
    // leaves. An empty entries list is an account that does not exist, and
    // that error would stand in for the guard's and prove nothing.
    getLedgerEntries: async () => fundedAccountResult(address, 100_0000000n),
    _getLedgerEntries: async () => fundedAccountResult(address, 100_0000000n),
  });
  return { c, address };
}

/** Now, in the units the in-flight record uses. */
const nowSec = () => Math.floor(Date.now() / 1000);

/** A submission that is still live: inside its time bounds, verdict unknown. */
const unresolved = (kind?: string) =>
  writeLocal(KEYS.inFlight, {
    hash: "a".repeat(64),
    maxTime: nowSec() + 300,
    ...(kind ? { kind } : {}),
  });

/** A submission whose time bounds have passed. It can never be included now. */
const expired = (kind?: string) =>
  writeLocal(KEYS.inFlight, {
    hash: "b".repeat(64),
    maxTime: nowSec() - 300,
    ...(kind ? { kind } : {}),
  });

const payment = { to: "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF", amount: "1", assetId: "native" };

beforeEach(async () => {
  chrome.local.clear();
  chrome.session.clear();
  clearSession();
  vi.restoreAllMocks();
});

describe("building is refused while a submission is unresolved", () => {
  it("refuses a public payment", async () => {
    const { c } = await wallet();
    await unresolved("payment");
    await expect(c.buildPayment(payment)).rejects.toThrow(UnresolvedTransactionError);
  });

  it("says what happened and what to do, in our own words", async () => {
    const { c } = await wallet();
    await unresolved("payment");
    const err = await c.buildPayment(payment).catch((e: unknown) => e);
    const { describeError } = await import("../../src/core/dispatch");
    const shown = describeError(err);
    expect(shown).toMatch(/has not resolved/i);
    expect(shown).toMatch(/may still land/i);
    // Not a network problem. Telling someone to check their connection here
    // sends them to retry the exact thing that causes the damage.
    expect(shown).not.toMatch(/check your connection/i);
  });

  it("builds again once the earlier envelope can no longer be included", async () => {
    // The release condition, and the reason the guard is not simply "is there a
    // record". Past its time bounds the first envelope is dead: it cannot take
    // the sequence number, so refusing further would strand the wallet.
    const { c } = await wallet();
    await expired("payment");
    await expect(c.buildPayment(payment)).resolves.toMatchObject({ xdr: expect.any(String) });
  });

  it("builds normally when there is nothing in flight at all", async () => {
    // The control. Without it every assertion above is satisfied by a build
    // path that is simply broken.
    const { c } = await wallet();
    await removeLocal(KEYS.inFlight);
    await expect(c.buildPayment(payment)).resolves.toMatchObject({ xdr: expect.any(String) });
  });
});

describe("the merge exemption turns on WHICH transaction is unresolved", () => {
  // A merge folds the whole receiving balance into spendable, so repeating one
  // folds nothing: idempotent in effect. That is true, and it answers the wrong
  // question. The guard is about the SEQUENCE NUMBER, and a merge consumes one
  // like anything else. So the exemption is only ever safe when the thing we
  // are waiting on is itself the merge.
  it("refuses a merge while a PAYMENT is unresolved", async () => {
    const { c } = await wallet();
    await unresolved("payment");
    await expect(c.buildPrivateOp({ kind: "merge" })).rejects.toThrow(UnresolvedTransactionError);
  });

  it("refuses a merge while an unresolved submission has no recorded kind", async () => {
    // An older record, or one written by a path that did not stamp a kind. The
    // exemption must not be granted to something we cannot identify.
    const { c } = await wallet();
    await unresolved();
    await expect(c.buildPrivateOp({ kind: "merge" })).rejects.toThrow(UnresolvedTransactionError);
  });

  it("refuses every non-merge private operation while a MERGE is unresolved", async () => {
    // The exemption is for repeating the merge, not for building anything else
    // on top of one.
    const { c } = await wallet();
    await unresolved("merge");
    for (const kind of ["deposit", "withdraw", "transfer"] as const) {
      await expect(
        c.buildPrivateOp({ kind, amount: "1" } as never),
        kind,
      ).rejects.toThrow(UnresolvedTransactionError);
    }
  });

  it("lets a merge through while a MERGE is unresolved", async () => {
    // The one case the exemption exists for. It must get PAST the guard: it
    // fails later, on proving, which this harness has no prover for. What
    // matters is that the failure is not the guard's.
    const { c } = await wallet();
    await unresolved("merge");
    const err = await c.buildPrivateOp({ kind: "merge" }).catch((e: unknown) => e);
    expect(err, "the merge exemption did not apply").not.toBeInstanceOf(
      UnresolvedTransactionError,
    );
  });
});
