// A handle must not outlive the envelope it stands for.
//
// `buildPayment` returns a handle, the popup shows a summary, and `confirmPayment`
// signs the exact bytes behind that handle. Those bytes carry time bounds: 180
// seconds, from `DEFAULT_TIMEOUT_SECONDS` or a literal `.setTimeout(180)` in
// every builder that stages one. The handle itself lived for ten minutes.
//
// So for seven of those ten the handle was alive and the bytes were dead.
// Confirming spent an unlock, a signature and a submission to be told
// `txTooLate` by the network, and on the private path it consumed a staged
// operation the user had waited on a proof for. Nothing about that is a security
// hole; it is a wallet spending someone's time and their proof to reach a worse
// error message than it already had the facts to write itself.
//
// Written because changing PENDING_TTL_MS on its own turns nothing red: the
// happy path never waits, so no existing test is anywhere near the boundary.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installChrome } from "../auth/_harness/chrome";
import { anyFundedAccount } from "./_harness/ledger";

const chrome = installChrome();
const { WalletController, StaleHandleError } = await import("../../src/core/controller");
const { KEYS, removeLocal } = await import("../../src/lib/storage");
const { clearSession } = await import("../../src/core/session");
const { DEFAULT_TIMEOUT_SECONDS } = await import("../../src/core/chain/submit");
const { Account } = await import("@stellar/stellar-sdk/base");

const PASSWORD = "correct horse battery staple";
// `buildPayment` returns the handle in a field called `xdr`, which is not what
// it sounds like: the popup never receives envelope bytes, only the key the
// worker files them under. Destructuring `handle` off it silently yields
// undefined, which is how this file first "passed" three assertions.
const TO = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";

/**
 * A wallet whose submission path is OBSERVED rather than mocked away.
 *
 * `sendTransaction` counts its calls, because the assertion that matters is not
 * only "confirm was refused" but "nothing was signed and put on the wire". A
 * refusal after submission would satisfy the first and be the exact bug.
 */
async function wallet() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create(PASSWORD);
  const sent: unknown[] = [];
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    prepareTransaction: async (tx: unknown) => tx,
    getLedgerEntries: anyFundedAccount(),
    _getLedgerEntries: anyFundedAccount(),
    sendTransaction: async (tx: unknown) => {
      sent.push(tx);
      return { status: "PENDING", hash: "c".repeat(64) };
    },
    getTransaction: async () => ({ status: "SUCCESS", ledger: 1 }),
  });
  return { c, address, sent };
}

beforeEach(async () => {
  chrome.local.clear();
  chrome.session.clear();
  clearSession();
  await removeLocal(KEYS.inFlight);
});
afterEach(() => clearSession());

/**
 * Age the staged entry, and NOTHING else.
 *
 * The obvious version of this moved the system clock instead, and it was wrong
 * in the way that matters: jumping forward 175 seconds also fires the idle-lock
 * alarm, `lock` calls `dropVolatileState`, and that clears `pending` outright.
 * Every assertion below still passed, and every one of them would have been
 * about the lock rather than about the TTL. The control caught it: a handle only
 * 175 seconds old, which must still work, was refused too.
 *
 * So this reaches for the entry's own timestamp. It is the single fact under
 * test, and moving one fact is what makes the result mean something.
 */
const age = (c: unknown, handle: string, seconds: number) => {
  const pending = (c as { pending: Map<string, { at: number }> }).pending;
  const entry = pending.get(handle);
  if (!entry) throw new Error("nothing staged under that handle, so this proves nothing");
  entry.at -= seconds * 1000;
};

describe("a staged handle dies with its envelope", () => {
  it("is refused once the envelope's own window has passed", async () => {
    const { c, sent } = await wallet();
    const { xdr: handle } = await c.buildPayment({ to: TO, amount: "1", assetId: "native" });

    age(c, handle, DEFAULT_TIMEOUT_SECONDS + 1);

    await expect(c.confirmPayment(handle)).rejects.toThrow(StaleHandleError);
    expect(sent, "an expired envelope was signed and submitted anyway").toHaveLength(0);
  });

  it("is still confirmable a moment before that", async () => {
    // The control. Without it the test above is satisfied by a handle that
    // never worked at all, and by a TTL of zero.
    const { c, sent } = await wallet();
    const { xdr: handle } = await c.buildPayment({ to: TO, amount: "1", assetId: "native" });

    age(c, handle, DEFAULT_TIMEOUT_SECONDS - 5);

    await expect(c.confirmPayment(handle)).resolves.toMatchObject({ hash: expect.any(String) });
    expect(sent).toHaveLength(1);
  });

  it("says to build it again, rather than inviting a blind retry", async () => {
    // The sentence matters here. "Try again" next to a transaction that may
    // already be on the wire is the resend the in-flight machinery exists to
    // prevent; this one sends the user back through the review screen.
    const { c } = await wallet();
    const { xdr: handle } = await c.buildPayment({ to: TO, amount: "1", assetId: "native" });
    age(c, handle, DEFAULT_TIMEOUT_SECONDS + 1);

    const err = await c.confirmPayment(handle).catch((e: unknown) => e);
    const { describeError } = await import("../../src/core/dispatch");
    const shown = describeError(err);
    expect(shown).toMatch(/build it again|review/i);
    expect(shown).not.toMatch(/check your connection/i);
  });

  it("keeps the window tied to the envelope rather than to a number typed here", () => {
    // The invariant, asserted directly, because the whole fix is that these two
    // are the same fact. A builder that picks a longer deadline without moving
    // the TTL re-opens the gap this file closed.
    const ttl = (WalletController as unknown as { PENDING_TTL_MS: number }).PENDING_TTL_MS;
    expect(ttl).toBe(DEFAULT_TIMEOUT_SECONDS * 1000);
  });
});
