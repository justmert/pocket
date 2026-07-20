// What a lock actually drops from the worker's memory.
//
// `lock()` opens with "Everything in memory goes first and synchronously". That
// was true of the session, the readiness flags and the decrypted history, and
// false of `pending`, the map of envelopes this controller has built and not yet
// submitted. A staged private operation keeps its post-state openings there as
// plain decimal strings, value and blinding both, next to the unsigned envelope;
// a payment keeps the recipient and the memo.
//
// Nothing expired them either. `prunePending` runs only from inside a build or a
// confirm, so the ten-minute TTL is enforced by nothing at all once the user has
// walked away and locked up.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { installChrome } from "./_harness/chrome";
import { anyFundedAccount } from "../failure/_harness/ledger";

const chrome = installChrome();
const { WalletController } = await import("../../src/core/controller");
const { clearSession } = await import("../../src/core/session");
const { Account } = await import("@stellar/stellar-sdk/base");

const PASSWORD = "correct horse battery staple";
const RECIPIENT = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";

/** The controller's private in-memory maps, for reading only. */
const memoryOf = (c: InstanceType<typeof WalletController>) =>
  c as unknown as {
    pending: Map<string, { xdr: string; private?: unknown }>;
    dappPending: Map<string, { resolve(verdict: string): void }>;
  };

async function wallet() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create(PASSWORD);
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    prepareTransaction: async (tx: unknown) => tx,
    getLedgerEntries: anyFundedAccount(),
    _getLedgerEntries: anyFundedAccount(),
  });
  return { c, address };
}

beforeEach(async () => {
  chrome.local.clear();
  chrome.session.clear();
  clearSession();
  vi.restoreAllMocks();
});

describe("locking drops the envelopes the worker has built", () => {
  it("holds a built envelope in memory before the lock", async () => {
    // The control. Without it the assertion below passes against a build path
    // that never stored anything.
    const { c } = await wallet();
    await c.buildPayment({ to: RECIPIENT, amount: "1", assetId: "native" });
    expect(memoryOf(c).pending.size).toBe(1);
  });

  it("clears it on lock", async () => {
    const { c } = await wallet();
    await c.buildPayment({ to: RECIPIENT, amount: "1", assetId: "native" });
    await c.lock();
    expect(memoryOf(c).pending.size).toBe(0);
  });

  it("clears it on erase, which used to leave it too", async () => {
    const { c } = await wallet();
    await c.buildPayment({ to: RECIPIENT, amount: "1", assetId: "native" });
    await c.reset(PASSWORD);
    expect(memoryOf(c).pending.size).toBe(0);
  });

  it("leaves no opening material behind for a staged private operation", async () => {
    // The case that matters: a private op stages `spendable` and `receiving` as
    // [value, randomness] decimal strings. This seeds that shape directly rather
    // than proving one, because the prover is not available here and the
    // question is about what LOCK does, not about what BUILD produced.
    const { c } = await wallet();
    const secret = "123456789012345678901234567890";
    memoryOf(c).pending.set("deadbeef", {
      xdr: "AAAA",
      private: { resolve: { kind: "openings", spendable: [secret, secret] } },
    });
    await c.lock();
    const left = JSON.stringify([...memoryOf(c).pending.entries()]);
    expect(left).not.toContain(secret);
    expect(memoryOf(c).pending.size).toBe(0);
  });

  it("answers a parked dApp approval rather than abandoning it", async () => {
    // The map holds the site's `resolve`. Clearing it without calling that would
    // leave the page hanging until its own timeout, so a lock has to be an
    // answer, and the answer is no.
    const { c } = await wallet();
    let answered: string = "never";
    memoryOf(c).dappPending.set("req-1", {
      resolve: (verdict: string) => {
        answered = verdict;
      },
    });
    await c.lock();
    // "declined", not "busy". The lock is an answer about consent, and the site
    // must be told no rather than told to come back: a retry after a lock is
    // exactly the loop the per-origin cap exists to stop.
    expect(answered, "the waiting site was never answered").toBe("declined");
    expect(memoryOf(c).dappPending.size).toBe(0);
  });
});
