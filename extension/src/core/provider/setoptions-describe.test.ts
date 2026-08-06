// A takeover and a rename must not read identically.
//
// `describeOperation`'s setOptions case returned a CONSTANT:
// "CHANGE ACCOUNT SECURITY SETTINGS (signers, thresholds or home domain)". No
// argument was read. Measured side by side, adding an attacker's key at weight
// 255 and setting a home domain produced byte-identical effects, and the
// attacker's key appeared nowhere on the screen the user approved from.
//
// That is blind signing with a caption, which is the exact thing this module
// exists to prevent. Its own header states the rule: a wallet that signs bytes
// it cannot describe is asking the user to approve a hash, and that is not
// consent.
import { describe, it, expect } from "vitest";
import "../../lib/polyfill";
import { describeSetOptions } from "./describe-tx";

const ATTACKER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";

describe("a setOptions the user is asked to approve", () => {
  it("names the key being given signing power, in full", () => {
    const said = describeSetOptions({ signer: { ed25519PublicKey: ATTACKER, weight: 255 } });
    expect(said).toContain(ATTACKER);
    expect(said).toMatch(/weight 255/);
    // Never truncated. Matching first-4 and last-4 is about an hour of work on
    // a laptop, and this is the field that hands the account away.
    expect(said).not.toMatch(/…|\.\.\./);
  });

  it("does not read the same as a harmless change", () => {
    // The measurement that made this a finding.
    const takeover = describeSetOptions({ signer: { ed25519PublicKey: ATTACKER, weight: 255 } });
    const harmless = describeSetOptions({ homeDomain: "example.com" });
    expect(takeover).not.toBe(harmless);
    expect(harmless).toContain("example.com");
  });

  it("says when the account's own key is being disabled", () => {
    // masterWeight 0 is permanent and is the other half of a takeover: add
    // their key, remove yours.
    expect(describeSetOptions({ masterWeight: 0 })).toMatch(/DISABLE this account's own key/);
    expect(describeSetOptions({ masterWeight: 3 })).toMatch(/weight to 3/);
  });

  it("distinguishes removing a signer from adding one", () => {
    // Weight 0 removes. Reading that as "add with weight 0" would describe the
    // opposite act.
    expect(describeSetOptions({ signer: { ed25519PublicKey: ATTACKER, weight: 0 } })).toMatch(
      /REMOVE the signer/,
    );
  });

  it("names every threshold it changes", () => {
    const said = describeSetOptions({ lowThreshold: 1, medThreshold: 2, highThreshold: 255 });
    expect(said).toMatch(/low threshold to 1/);
    expect(said).toMatch(/medium threshold to 2/);
    expect(said).toMatch(/high threshold to 255/);
  });

  it("lists every field when one operation carries several", () => {
    // The real takeover shape: add their key, disable yours, raise the bar. The
    // strongest must not hide behind the mildest.
    const said = describeSetOptions({
      signer: { ed25519PublicKey: ATTACKER, weight: 255 },
      masterWeight: 0,
      highThreshold: 255,
      homeDomain: "evil.example",
    });
    expect(said).toContain(ATTACKER);
    expect(said).toMatch(/DISABLE this account's own key/);
    expect(said).toMatch(/high threshold to 255/);
    expect(said).toContain("evil.example");
  });

  it("distinguishes clearing a home domain from setting one", () => {
    expect(describeSetOptions({ homeDomain: "" })).toMatch(/Clear the home domain/);
  });

  it("says it cannot name the field rather than claiming nothing happens", () => {
    // An operation that sets nothing this build understands is still a signed
    // operation. "Changes nothing" would be a claim about a shape it did not
    // recognise.
    const said = describeSetOptions({});
    expect(said).toMatch(/unknown field/);
    expect(said).not.toMatch(/nothing/i);
  });

  it("describes the exotic signer types rather than dropping them", () => {
    expect(describeSetOptions({ signer: { sha256Hash: new Uint8Array(32), weight: 1 } })).toMatch(
      /hash-x signer/,
    );
    expect(describeSetOptions({ signer: { preAuthTx: new Uint8Array(32), weight: 1 } })).toMatch(
      /pre-authorised transaction signer/,
    );
  });
});

describe("an asset named on the approval screen", () => {
  // A CODE is not an identity. Anyone can issue an asset called USDC, and a
  // payment of the real one and a payment of a worthless lookalike rendered as
  // the same six characters on the screen where the user says yes.
  it("names the issuer, so a lookalike cannot pass as the real asset", async () => {
    const { assetName } = await import("./describe-tx");
    const { Asset } = await import("@stellar/stellar-sdk/base");
    const real = new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    const fake = new Asset("USDC", "GCY7W6TM623NI5TNN3YA6BQ2L6DMRCFJUDXZT447OLSKUJE67J7GTIU4");
    expect(assetName(real)).not.toBe(assetName(fake));
    expect(assetName(real)).toContain("GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5");
    // Never truncated: the issuer is the ONLY distinguishing field here.
    expect(assetName(real)).not.toMatch(/…|\.\.\./);
  });

  it("leaves XLM alone, which has no issuer to name", async () => {
    const { assetName } = await import("./describe-tx");
    const { Asset } = await import("@stellar/stellar-sdk/base");
    expect(assetName(Asset.native())).toBe("XLM");
  });

  it("reaches the payment and path-payment sentences, not just the helper", async () => {
    // The helper can be right and unused. These are the three operations that
    // name an asset on this screen.
    const { describeTransaction } = await import("./describe-tx");
    const { TransactionBuilder, Account, Operation, Asset, BASE_FEE, Networks } = await import(
      "@stellar/stellar-sdk/base"
    );
    const ISSUER = "GCY7W6TM623NI5TNN3YA6BQ2L6DMRCFJUDXZT447OLSKUJE67J7GTIU4";
    const xdr = new TransactionBuilder(new Account(ATTACKER, "1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(
        Operation.payment({
          destination: ATTACKER,
          asset: new Asset("USDC", ISSUER),
          amount: "1",
        }),
      )
      .setTimeout(180)
      .build()
      .toXDR();
    const summary = describeTransaction(xdr, Networks.TESTNET);
    expect(summary.effects.join(" ")).toContain(ISSUER);
  });
});
