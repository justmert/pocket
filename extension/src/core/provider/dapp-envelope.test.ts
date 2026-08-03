// What the approval screen says about an envelope a SITE composed.
//
// Everything here is the site's choice: the operations, the memo, and the fee.
// The screen is the only thing between that and a signature, so a field it
// renders wrongly, or does not render at all, is blind signing with a caption.
//
// Three defects, all measured:
//   - a 100 XLM fee rendered as an ordinary quiet fee row with no warning;
//   - a trustline REMOVAL was described as "Trust USDC:G... up to 0.0000000",
//     the opposite operation, because the zero check compared against "0" and
//     an XDR round trip yields "0.0000000";
//   - hash and return memos rendered as 32 replacement characters.
import { describe, it, expect } from "vitest";
import "../../lib/polyfill";
import {
  Account,
  Asset,
  Memo,
  Operation,
  TransactionBuilder,
  Networks,
} from "@stellar/stellar-sdk/base";
import { describeTransaction } from "./describe-tx";

const SOURCE = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";
const TO = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";
const ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/** An envelope as a site hands one over: built, serialised, decoded again. */
function envelope(
  build: (b: InstanceType<typeof TransactionBuilder>) => InstanceType<typeof TransactionBuilder>,
  fee = "100",
) {
  const b = new TransactionBuilder(new Account(SOURCE, "100"), {
    fee,
    networkPassphrase: Networks.TESTNET,
  });
  return build(b).setTimeout(180).build().toXDR();
}

const summarise = (xdr: string) => describeTransaction(xdr, Networks.TESTNET);

describe("the fee a site chose", () => {
  it("is called out when it is far above anything a transaction costs", () => {
    // 100 XLM. Measured on the shipped path as fee 1,000,000,000 with
    // `warning: undefined`.
    const s = summarise(
      envelope(
        (b) =>
          b.addOperation(
            Operation.payment({ destination: TO, asset: Asset.native(), amount: "1" }),
          ),
        "1000000000",
      ),
    );
    expect(s.warning ?? "", "a 100 XLM fee passed without a word").toMatch(/far more than/i);
    expect(s.warning!).toMatch(/The site chose it/);
  });

  it("says nothing about an ordinary fee", () => {
    const s = summarise(
      envelope((b) =>
        b.addOperation(Operation.payment({ destination: TO, asset: Asset.native(), amount: "1" })),
      ),
    );
    expect(s.warning).toBeUndefined();
  });

  it("says nothing about a real Soroban-sized fee either", () => {
    // 350,412 stroops is the largest fee anything in this product produces.
    // A threshold that trips on it would be noise on every legitimate envelope.
    const s = summarise(
      envelope(
        (b) =>
          b.addOperation(
            Operation.payment({ destination: TO, asset: Asset.native(), amount: "1" }),
          ),
        "350412",
      ),
    );
    expect(s.warning).toBeUndefined();
  });

  it("still leads with the security warning when both apply", () => {
    const s = summarise(
      envelope(
        (b) => b.addOperation(Operation.setOptions({ homeDomain: "example.com" })),
        "1000000000",
      ),
    );
    expect(s.warning!).toMatch(/^This transaction changes who controls the account/);
    expect(s.warning!, "the fee warning was dropped for the security one").toMatch(
      /far more than/i,
    );
  });
});

describe("a trustline change", () => {
  it("describes a removal as a removal", () => {
    const s = summarise(
      envelope((b) =>
        b.addOperation(Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "0" })),
      ),
    );
    expect(s.effects.join(" "), "a removal was described as its opposite").toMatch(/REMOVE/);
  });

  it("still describes an ordinary trust as a trust", () => {
    const s = summarise(
      envelope((b) =>
        b.addOperation(Operation.changeTrust({ asset: new Asset("USDC", ISSUER), limit: "1000" })),
      ),
    );
    expect(s.effects.join(" ")).toMatch(/Trust/);
    expect(s.effects.join(" ")).not.toMatch(/REMOVE/);
  });
});

describe("a memo the user is asked to check", () => {
  it("renders a hash memo as hex, not as replacement characters", () => {
    const s = summarise(
      envelope((b) =>
        b
          .addOperation(Operation.payment({ destination: TO, asset: Asset.native(), amount: "1" }))
          .addMemo(Memo.hash(Buffer.alloc(32, 0xab).toString("hex"))),
      ),
    );
    expect(s.memoType).toBe("hash");
    expect(s.memo, "the one field a user is asked to match was unreadable").toBe("ab".repeat(32));
    expect(s.memo).not.toContain("�");
  });

  it("keeps a text memo as text", () => {
    const s = summarise(
      envelope((b) =>
        b
          .addOperation(Operation.payment({ destination: TO, asset: Asset.native(), amount: "1" }))
          .addMemo(Memo.text("invoice 42")),
      ),
    );
    expect(s.memoType).toBe("text");
    expect(s.memo).toBe("invoice 42");
  });
});
