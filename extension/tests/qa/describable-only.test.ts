// D-007: an operation the wallet cannot describe is never offered for approval.
//
// `describeOperation`'s switch covers eight operation types. Everything else
// fell through to `${n} ${op.type}` and the envelope was still returned
// `decoded: true`, so `DappApproval` rendered an enabled Approve. Lane L1 drove
// it end to end: a connected site asked to sign a `createClaimableBalance` of
// 9,500 XLM to an address of its choosing, the screen showed one line reading
// "1. createClaimableBalance", and pressing Approve returned a valid signature
// over exactly those bytes. Neither the amount nor the beneficiary was anywhere
// on screen.
//
// describe-tx.ts's own header says an envelope the wallet cannot describe must
// never get an affirmative control, and the `decoded: false` path that enforces
// that already existed and already worked — for a malformed envelope and for a
// fee bump. It simply was not reached for an operation nobody had written a
// sentence for.
//
// This is a unit test rather than a browser one because the defect is in the
// decode, and the decode is where the fix has to hold: the UI's job is only to
// honour `decoded`, which it already does.
import { describe, expect, it } from "vitest";
import {
  Account,
  Asset,
  Claimant,
  Operation,
  TransactionBuilder,
  Keypair,
} from "@stellar/stellar-sdk";
import { describeTransaction } from "../../src/core/provider/describe-tx";

const NETWORK = "Test SDF Network ; September 2015";
const SOURCE = Keypair.random().publicKey();
const OTHER = Keypair.random().publicKey();

function envelope(op: ReturnType<typeof Operation.payment>): string {
  return new TransactionBuilder(new Account(SOURCE, "1"), {
    fee: "100",
    networkPassphrase: NETWORK,
  })
    .addOperation(op)
    .setTimeout(180)
    .build()
    .toXDR();
}

describe("an operation the wallet cannot describe", () => {
  it("refuses a claimable balance rather than naming its type and offering to sign", () => {
    // The exact shape L1 signed: the whole balance, to a claimant of the
    // attacker's choosing, under a one-line description.
    const summary = describeTransaction(
      envelope(
        Operation.createClaimableBalance({
          asset: Asset.native(),
          amount: "9500",
          // the beneficiary the attacker chooses. an empty list is refused by
          // the SDK, and an envelope that cannot be built is not the envelope
          // this defect was found with.
          claimants: [new Claimant(OTHER, Claimant.predicateUnconditional())],
        }) as ReturnType<typeof Operation.payment>,
      ),
      NETWORK,
    );

    expect(
      summary.decoded,
      "the wallet offered to sign an operation it could not put into words",
    ).toBe(false);
    expect(summary.effects, "a refused envelope must not carry a half-description").toEqual([]);
    expect(summary.warning ?? "").toMatch(/cannot describe/i);
    expect(summary.warning ?? "", "the refusal must name what it could not read").toMatch(
      /createClaimableBalance/,
    );
    expect(summary.warning ?? "", "and must say it will not sign").toMatch(/will not sign this/i);
  });

  it("refuses every other operation type nobody has written a sentence for", () => {
    // Each of these moves value, changes who can move it, or changes what the
    // account will accept. None had a description and all were signable.
    const cases: Record<string, ReturnType<typeof Operation.payment>> = {
      manageData: Operation.manageData({ name: "k", value: "v" }) as never,
      bumpSequence: Operation.bumpSequence({ bumpTo: "9223372036854775807" }) as never,
      manageSellOffer: Operation.manageSellOffer({
        selling: Asset.native(),
        buying: new Asset("USD", OTHER),
        amount: "1000",
        price: "1",
      }) as never,
      claimClaimableBalance: Operation.claimClaimableBalance({
        balanceId: "00".repeat(36),
      }) as never,
    };

    for (const [name, op] of Object.entries(cases)) {
      const summary = describeTransaction(envelope(op), NETWORK);
      expect(summary.decoded, `${name} was offered for approval undescribed`).toBe(false);
      expect(summary.warning ?? "", `${name} must be named in the refusal`).toContain(name);
    }
  });

  it("refuses the whole envelope when only one operation is undescribable", () => {
    // A list where four lines are real and the fifth is a bare type name reads
    // as a complete description, and the line that is not is the one carrying
    // the operation nobody reviewed.
    const tx = new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: "100",
      networkPassphrase: NETWORK,
    })
      .addOperation(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: "1" }))
      .addOperation(Operation.bumpSequence({ bumpTo: "9223372036854775807" }) as never)
      .setTimeout(180)
      .build();

    const summary = describeTransaction(tx.toXDR(), NETWORK);
    expect(summary.decoded, "one undescribable operation must refuse the envelope").toBe(false);
    expect(
      summary.effects,
      "a partly-described envelope is the most dangerous kind: it reads as complete",
    ).toEqual([]);
  });

  it("still describes everything it has a sentence for", () => {
    // The other half. A refusal that refuses everything is not a fix, it is a
    // removed feature — and the eight described types are the ones a real site
    // actually sends.
    const summary = describeTransaction(
      envelope(Operation.payment({ destination: OTHER, asset: Asset.native(), amount: "40" })),
      NETWORK,
    );
    expect(summary.decoded).toBe(true);
    expect(summary.effects.join(" ")).toMatch(/Send 40/);
    expect(summary.warning).toBeUndefined();
  });

  it("keeps naming the operations that hand away the account", () => {
    const summary = describeTransaction(
      envelope(Operation.setOptions({ homeDomain: "example.com" }) as never),
      NETWORK,
    );
    expect(summary.decoded, "setOptions is described, not refused").toBe(true);
    expect(summary.warning ?? "", "and it keeps its warning").toMatch(/changes who controls/i);
  });
});
