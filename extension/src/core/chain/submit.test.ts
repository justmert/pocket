import { describe, it, expect } from "vitest";
import { hasExpired } from "./submit";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";

const PASSPHRASE = "Test SDF Network ; September 2015";

function tx(maxTime: number) {
  const kp = Keypair.random();
  return new TransactionBuilder(new Account(kp.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .build();
}

describe("expiry decidability (audit M1)", () => {
  it("reports a past maxTime as expired", () => {
    expect(hasExpired(tx(Math.floor(Date.now() / 1000) - 60))).toBe(true);
  });

  it("does not report a future maxTime as expired", () => {
    expect(hasExpired(tx(Math.floor(Date.now() / 1000) + 600))).toBe(false);
  });

  it("treats an unbounded transaction as never decidably expired", () => {
    // maxTime 0 means no upper bound, so "still in flight" and "expired" can
    // never be told apart. That is why buildPayment always sets timeBounds.
    expect(hasExpired(tx(0))).toBe(false);
  });
});
