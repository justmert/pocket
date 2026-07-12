// The bridge must spend the amount it names.
//
// CCTP carries six decimals; Stellar USDC has seven. So the last digit of an
// amount cannot be represented in the cross-chain message, and something has to
// happen to it.
//
// What used to happen: the approve and the burn were built with the full 7dp
// amount, the sheet's headline stated the full 7dp amount, and a separate line
// said the dust "stays on Stellar". The whole sum was handed to Circle's token
// messenger. Whether that contract truncates, refunds or simply consumes the
// last digit is not knowable from the wallet, so the reassuring line was a claim
// the wallet had no way to make, on the one path in the product that is final in
// both directions at once.
//
// Rounding down removes the question. The dust is never spent, so it stays in the
// account because it never left, and one number describes the approve, the burn,
// the headline and the receipt.
import { describe, it, expect, beforeEach } from "vitest";
import { installChrome } from "../auth/_harness/chrome";
import { ledgerAnswering } from "./_harness/ledger";

const chrome = installChrome();
const { WalletController } = await import("../../src/core/controller");
const { KEYS, removeLocal } = await import("../../src/lib/storage");
const { clearSession } = await import("../../src/core/session");
const { Account, Asset } = await import("@stellar/stellar-sdk/base");
const { CCTP, toCctpAmount, fromCctpAmount } = await import("../../src/core/integrations/cctp");

const PASSWORD = "correct horse battery staple";
// Ethereum's CCTP domain. Anything but Stellar's own would do.
const ETHEREUM = 0;
const RECIPIENT = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed";
/** The classic USDC the bridge spends, from the same config the wallet reads. */
const USDC = new Asset("USDC", CCTP.testnet.usdc.split("-")[1]!);

async function wallet() {
  const c = new WalletController();
  await c.init();
  const { address } = await c.create(PASSWORD);
  // Enough USDC that the dust arithmetic, not the balance, is what is measured.
  const ledger = ledgerAnswering(address, {
    trustlines: [{ asset: USDC, balance: 1_000_0000000n }],
  });
  (c as unknown as { servers: Map<string, unknown> }).servers.set("testnet", {
    getAccount: async () => new Account(address, "100"),
    getLatestLedger: async () => ({ sequence: 1_000_000 }),
    // Returned unchanged: this test is about the arguments the wallet composes,
    // not about what simulation adds to them.
    prepareTransaction: async (tx: unknown) => tx,
    // A ledger that answers the key it is ASKED about. The bridge path reads
    // the USDC trustline now, to refuse an over-balance bridge before the
    // approve leg is built and charged for, so an account-only fixture answers
    // the wrong entry and the read refuses.
    getLedgerEntries: ledger,
    _getLedgerEntries: async (key: Parameters<typeof ledger>[0]) => ledger(key),
  });
  return { c, address };
}

/** The burn spec the confirm step will build its second transaction from. */
const burnSpec = (c: unknown, handle: string) =>
  (c as { pending: Map<string, { cctpBurn?: { amount: string } }> }).pending.get(handle)?.cctpBurn;

beforeEach(async () => {
  chrome.local.clear();
  chrome.session.clear();
  clearSession();
  await removeLocal(KEYS.inFlight);
});

describe("an amount with a seventh decimal is rounded down, not quietly spent", () => {
  // 1.2345678 USDC: six decimals cross, the trailing 8 cannot.
  const TYPED = "1.2345678";
  const TYPED_STROOPS = 12345678n;

  it("names the amount that can actually cross", async () => {
    const { c } = await wallet();
    const { summary } = await c.buildCctpSend(ETHEREUM, RECIPIENT, TYPED);

    const { cctpAmount, dust } = toCctpAmount(TYPED_STROOPS);
    expect(dust, "the fixture has no dust, so it tests nothing").toBeGreaterThan(0n);
    expect(summary.amount).toBe("1.2345670");
    expect(summary.amount, "the headline still states the un-bridgeable digit").not.toBe(TYPED);
    // Stated as the amount, not merely as an arithmetic identity.
    expect(fromCctpAmount(cctpAmount)).toBe(12345670n);
  });

  it("burns exactly what it named", async () => {
    // The assertion the old code failed. The summary and the bytes have to be
    // the same number; a headline is not a promise unless the transaction keeps
    // it.
    const { c } = await wallet();
    const { handle, summary } = await c.buildCctpSend(ETHEREUM, RECIPIENT, TYPED);

    const spec = burnSpec(c, handle);
    expect(spec, "no burn spec was recorded").toBeTruthy();
    expect(spec!.amount, "the burn spends more than the sheet said").toBe("12345670");
    expect(spec!.amount).not.toBe(TYPED_STROOPS.toString());
    // And the two agree, which is the property rather than the two constants.
    expect(summary.amount).toBe("1.2345670");
  });

  it("approves no more than the burn will take", async () => {
    // An allowance above the burn is a standing permission over USDC that
    // outlives the transaction it was created for.
    const { c, address } = await wallet();
    const { handle } = await c.buildCctpSend(ETHEREUM, RECIPIENT, TYPED);
    const entry = (c as unknown as { pending: Map<string, { xdr: string }> }).pending.get(handle)!;

    const { TransactionBuilder, Networks, scValToNative } = await import(
      "@stellar/stellar-sdk/base"
    );
    const tx = TransactionBuilder.fromXDR(entry.xdr, Networks.TESTNET);
    const args = (
      tx as unknown as {
        operations: { func: { invokeContract(): { args(): { toXDR(): Buffer }[] } } }[];
      }
    ).operations[0]!.func.invokeContract().args();
    // approve(from, spender, amount, expiration): the amount is the third.
    const approved = scValToNative(
      args[2] as unknown as Parameters<typeof scValToNative>[0],
    ) as bigint;
    expect(approved, "the allowance exceeds what the burn spends").toBe(12345670n);
    void address;
  });

  it("says the dust stays here, and says why", async () => {
    const { c } = await wallet();
    const { summary } = await c.buildCctpSend(ETHEREUM, RECIPIENT, TYPED);

    expect(summary.dust).toBe("0.0000008");
    const said = summary.effects.join(" ");
    expect(said).toMatch(/stays in this account/i);
    expect(said).toMatch(/6 decimals/i);
    // The old sentence said it stayed "on Stellar" while the whole amount was
    // handed to the messenger. Where it stays is the part that was wrong.
    expect(said, "still claiming the dust merely stays on the network").not.toMatch(
      /dust stays on Stellar/i,
    );
  });

  it("states where the money lands, decoded from the bytes it recorded", async () => {
    // The sheet used to show an amount and a chain and no destination at all,
    // so the only irreversible field in the flow was reviewable on the form the
    // user had already left. This value is decoded back out of the 32-byte mint
    // recipient the worker stored, which is what the burn will carry.
    const { c } = await wallet();
    const { summary } = await c.buildCctpSend(ETHEREUM, RECIPIENT.toLowerCase(), TYPED);

    // In EIP-55 capitalisation even though a lowercase address was typed,
    // because the case is derived from the bytes rather than from the input.
    expect(summary.recipient).toBe(RECIPIENT);
    // Never truncated: matching first-4 and last-4 is about an hour of work.
    expect(summary.recipient).toHaveLength(42);
    expect(summary.recipient).not.toMatch(/[….]{2,}/);
  });

  it("leaves a clean amount completely alone", async () => {
    // The control. Every assertion above is satisfied by a builder that mangles
    // all amounts, and most of them by one that always subtracts.
    const { c } = await wallet();
    const { handle, summary } = await c.buildCctpSend(ETHEREUM, RECIPIENT, "2.5");
    expect(summary.amount).toBe("2.5000000");
    expect(summary.dust).toBeUndefined();
    expect(burnSpec(c, handle)!.amount).toBe("25000000");
  });

  it("still refuses an amount too small to bridge at all", async () => {
    // Below 0.000001 USDC everything rounds to nothing, and a burn of zero is
    // a fee paid to move no money.
    const { c } = await wallet();
    await expect(c.buildCctpSend(ETHEREUM, RECIPIENT, "0.0000005")).rejects.toThrow(
      /smallest bridgeable/i,
    );
    void CCTP;
  });
});
