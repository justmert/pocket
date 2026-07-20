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
import { anyFundedAccount } from "./_harness/ledger";

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
    getLedgerEntries: anyFundedAccount(),
    _getLedgerEntries: anyFundedAccount(),
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

/**
 * A submission that is decidably dead: its time bounds have passed AND the
 * ledger answered that it does not have it.
 *
 * Both halves are required, and this helper carried only the first. A deadline
 * passing says nothing about whether the envelope was included before it, so
 * `answered` is what makes a rebuild safe rather than a double spend. See
 * `deadlineOnly` for the case that separates them.
 */
const expired = (kind?: string) =>
  writeLocal(KEYS.inFlight, {
    hash: "b".repeat(64),
    maxTime: nowSec() - 300,
    answered: true,
    ...(kind ? { kind } : {}),
  });

/** Deadline passed, but no poll ever got an answer: an outage, not an absence. */
const deadlineOnly = (kind?: string) =>
  writeLocal(KEYS.inFlight, {
    hash: "b".repeat(64),
    maxTime: nowSec() - 300,
    ...(kind ? { kind } : {}),
  });

const payment = {
  to: "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF",
  amount: "1",
  assetId: "native",
};

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
    // record". Past its time bounds AND answered NOT_FOUND, the first envelope
    // is dead: it cannot take the sequence number and it never did, so refusing
    // further would strand the wallet.
    const { c } = await wallet();
    await expired("payment");
    await expect(c.buildPayment(payment)).resolves.toMatchObject({ xdr: expect.any(String) });
  });

  it("keeps refusing when the deadline passed with no answer from the ledger", async () => {
    // Half the release condition is not the release condition. An RPC outage
    // spanning the 180-second window leaves the deadline behind us with nobody
    // having heard anything, and the first envelope may well have been
    // included. Building here is how a payment is made twice, and how the
    // record pointing at a private op's only openings gets overwritten.
    const { c } = await wallet();
    await deadlineOnly("payment");
    await expect(c.buildPayment(payment)).rejects.toThrow(/has not resolved yet/);
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
      await expect(c.buildPrivateOp({ kind, amount: "1" } as never), kind).rejects.toThrow(
        UnresolvedTransactionError,
      );
    }
  });

  it("refuses a merge while a MERGE is unresolved, which the exemption used to allow", async () => {
    // BEHAVIOUR CHANGE, and the reason is the whole point of this block.
    //
    // This case used to be allowed, for the shield-recovery flow: a deposit
    // lands, its follow-merge does not, and the wallet says "Press Make
    // spendable". But an UNRESOLVED merge is one whose outcome is unknown, not
    // one known to have failed, because a terminal failure clears the record.
    // It may still land. A second merge takes its sequence number, so the first
    // is included and the second is rejected, and that rejection deletes the
    // in-flight and staged records the second submission had already relabelled
    // with its own hash. Nothing then names the merge that landed, so
    // `applyStaged` never runs for it and the pocket reads `diverged`.
    //
    // The dead end is closed on the other side: the shield-failure message now
    // sends the user to reopen Pocket, which reconciles the record.
    const { c } = await wallet();
    await unresolved("merge");
    await expect(c.buildPrivateOp({ kind: "merge" })).rejects.toThrow(UnresolvedTransactionError);
  });

  it("lets a merge through once the earlier merge can no longer be included", async () => {
    // The release condition, and the only safe version of the old exemption.
    // Past its time bounds the first merge is dead, so a second cannot collide
    // with it. It fails later on proving, which this harness has no prover for;
    // what matters is that the failure is not the guard's.
    const { c } = await wallet();
    await expired("merge");
    const err = await c.buildPrivateOp({ kind: "merge" }).catch((e: unknown) => e);
    expect(err, "an expired merge still blocked a retry").not.toBeInstanceOf(
      UnresolvedTransactionError,
    );
  });
});

describe("the integration builders are behind the same guard", () => {
  // These four shipped without it. Each one reads a fresh sequence number and
  // its confirm half writes the in-flight slot, so a swap or a claim started
  // while a private operation was unresolved displaced that operation's
  // recovery pointer. `applyStaged` is keyed on the record, so the openings of
  // the private op that landed were then never written, and on a build with no
  // archive they cannot be re-derived.
  //
  // The guard sits immediately after `requireSession()`, before any config read
  // or network call, so these assertions do not need a configured integration.
  const builders: [string, (c: InstanceType<typeof WalletController>) => Promise<unknown>][] = [
    ["buildYieldMove", (c) => c.buildYieldMove("deposit", "1")],
    [
      "buildSwap",
      (c) =>
        c.buildSwap("native", "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5", "1"),
    ],
    ["buildCctpSend", (c) => c.buildCctpSend(0, "0x" + "1".repeat(40), "1")],
    ["buildCctpClaim", (c) => c.buildCctpClaim(0, "c".repeat(64))],
    [
      "buildAddTrustline",
      (c) =>
        c.buildAddTrustline("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
    ],
  ];

  for (const [name, run] of builders) {
    it(`refuses ${name} while a private operation is unresolved`, async () => {
      const { c } = await wallet();
      await unresolved("transfer");
      await expect(run(c), name).rejects.toThrow(UnresolvedTransactionError);
    });
  }

  it("lets them build once the earlier envelope can no longer be included", async () => {
    // The release condition, same as the payment path's. Past its time bounds
    // the earlier envelope is dead, so refusing further would strand the wallet.
    // These fail later for want of configuration or a network; what matters is
    // that the failure is no longer the guard's.
    const { c } = await wallet();
    await expired("transfer");
    for (const [name, run] of builders) {
      const err = await run(c).catch((e: unknown) => e);
      expect(err, name).not.toBeInstanceOf(UnresolvedTransactionError);
    }
  });
});

describe("the in-flight slot refuses to be written over", () => {
  // The backstop behind the build-time guard. `assertNothingUnresolved` runs at
  // BUILD time and cannot see a submission that starts while it is running, so
  // the sink itself has to hold the invariant. There were two sinks and they
  // disagreed: both clears were meant to be hash-guarded and only one was,
  // while both records wrote unconditionally.
  //
  // Refusing here aborts before `sendTransaction`, so nothing is submitted and
  // no sequence number is consumed.
  const sinkOf = (c: InstanceType<typeof WalletController>, kind?: string) =>
    (
      c as unknown as {
        inFlightSink(k?: string): {
          record(e: { hash: string; maxTime: number }): Promise<void>;
          clear(hash: string): Promise<void>;
        };
      }
    ).inFlightSink(kind);

  it("refuses a second submission over a live record for a different transaction", async () => {
    const { c } = await wallet();
    await unresolved("transfer");
    await expect(
      sinkOf(c, "swap").record({ hash: "f".repeat(64), maxTime: nowSec() + 300 }),
    ).rejects.toThrow(UnresolvedTransactionError);
  });

  it("leaves the earlier record intact when it refuses", async () => {
    // The whole point. If the refusal still clobbered the slot it would be
    // worse than no guard: the operation is aborted AND the pointer is gone.
    const { c } = await wallet();
    await unresolved("transfer");
    await sinkOf(c, "swap")
      .record({ hash: "f".repeat(64), maxTime: nowSec() + 300 })
      .catch(() => undefined);
    const { readLocal } = await import("../../src/lib/storage");
    expect(await readLocal(KEYS.inFlight)).toMatchObject({
      hash: "a".repeat(64),
      kind: "transfer",
    });
  });

  it("allows re-recording the SAME transaction", async () => {
    // A retry of the identical envelope is not a second transaction and must
    // not be refused, or a resumed confirm could never re-record its own hash.
    const { c } = await wallet();
    await unresolved("transfer");
    await expect(
      sinkOf(c, "transfer").record({ hash: "a".repeat(64), maxTime: nowSec() + 300 }),
    ).resolves.toBeUndefined();
  });

  it("allows a new submission once the held record has expired", async () => {
    const { c } = await wallet();
    await expired("transfer");
    await expect(
      sinkOf(c, "swap").record({ hash: "f".repeat(64), maxTime: nowSec() + 300 }),
    ).resolves.toBeUndefined();
  });

  it("clears only its own record, on both paths", async () => {
    // The payment path used to clear unconditionally, so a keep-alive or an
    // integration resolving beside a payment erased the payment's pointer.
    const { c } = await wallet();
    const { readLocal } = await import("../../src/lib/storage");
    await unresolved("transfer");
    await sinkOf(c, "payment").clear("f".repeat(64));
    expect(await readLocal(KEYS.inFlight), "a stranger's hash cleared our record").toMatchObject({
      hash: "a".repeat(64),
    });
    await sinkOf(c, "payment").clear("a".repeat(64));
    expect(await readLocal(KEYS.inFlight)).toBeUndefined();
  });
});
