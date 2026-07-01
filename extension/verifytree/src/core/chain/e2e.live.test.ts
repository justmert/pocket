import { describe, it, expect } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import { buildPayment } from "./payment";
import { submitAndConfirm, hasExpired } from "./submit";
import { readNative, parseAmount } from "./balances";
import { NETWORKS } from "../config";

// A real payment on live testnet: build, sign, submit, confirm, and verify the
// balance actually moved. Nothing here is mocked.
const net = NETWORKS.testnet;
const server = new rpc.Server(net.rpcUrl);
// From the environment, never from the source tree. The same file naming would
// carry a mainnet key without any structural change to catch it.
const SECRET = process.env.POCKET_TESTNET_SECRET;
const SENDER = SECRET ? Keypair.fromSecret(SECRET) : null;
const RECIPIENT = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";

// Skipped, loudly, when no funded account is supplied. A silent green run
// without the key would report a payment path as exercised when it was not.
describe.skipIf(!SENDER)("live testnet payment, end to end", () => {
  it("is configured with two distinct accounts", () => {
    // Paying yourself nets the fee and reads as a balance that went backwards,
    // which looks like a broken payment path rather than a misconfigured test.
    expect(SENDER!.publicKey()).not.toBe(RECIPIENT);
  });

  it("moves XLM and confirms the balance changed", async () => {
    const amount = parseAmount("1.5");
    const before = await readNative(server, RECIPIENT);

    const seq = await server.getAccount(SENDER!.publicKey());
    const tx = buildPayment(
      new Account(SENDER!.publicKey(), seq.sequenceNumber()),
      {
        from: SENDER!.publicKey(),
        to: RECIPIENT,
        asset: Asset.native(),
        amount,
        memo: "pocket e2e",
      },
      net.passphrase,
    );
    tx.sign(SENDER!);

    const outcome = await submitAndConfirm(server, tx);
    expect(outcome.kind).toBe("succeeded");
    if (outcome.kind !== "succeeded") throw new Error(outcome.kind);
    expect(outcome.ledger).toBeGreaterThan(0);

    const after = await readNative(server, RECIPIENT);
    expect(after.raw - before.raw).toBe(amount);
  }, 60_000);

  it("reports a rejected submission rather than throwing", async () => {
    // Deliberately expired: maxTime in the past. This must present as a clean
    // "rejected" outcome (never included, no fee, sequence not consumed), not
    // as an exception the caller has to catch.
    const seq = await server.getAccount(SENDER!.publicKey());
    const past = Math.floor(Date.now() / 1000) - 3600;
    const expired = new TransactionBuilder(new Account(SENDER!.publicKey(), seq.sequenceNumber()), {
      fee: "100",
      networkPassphrase: net.passphrase,
      timebounds: { minTime: 0, maxTime: past },
    })
      .addOperation(
        Operation.payment({
          destination: RECIPIENT,
          asset: Asset.native(),
          amount: "1.0000000",
        }),
      )
      .build();
    expired.sign(SENDER!);

    expect(hasExpired(expired)).toBe(true);
    const outcome = await submitAndConfirm(server, expired);
    expect(outcome.kind).toBe("rejected");
    if (outcome.kind === "rejected") expect(outcome.reason).toContain("txTooLate");
  }, 60_000);
});
