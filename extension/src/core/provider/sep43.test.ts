import { describe, it, expect } from "vitest";
import {
  ERROR,
  err,
  isDappPermittedMethod,
  CONFIDENTIAL_METHODS,
  DAPP_ALLOWED_CONTRACT_METHODS,
  dappForbiddenInvocation,
} from "./sep43";
import "../../lib/polyfill";
import {
  TransactionBuilder,
  Account,
  Operation,
  Address,
  Asset,
  nativeToScVal,
  BASE_FEE,
  Networks,
} from "@stellar/stellar-sdk/base";

describe("SEP-43 error codes", () => {
  it("matches the spec's four codes exactly", () => {
    expect(ERROR).toEqual({
      INTERNAL: -1,
      EXTERNAL: -2,
      INVALID_REQUEST: -3,
      USER_REJECTED: -4,
    });
  });

  it("returns errors in the resolved object rather than throwing", () => {
    // A dapp reads result.error; it does not catch. Throwing would break every
    // conforming client.
    const e = err(ERROR.USER_REJECTED, "The user declined.");
    expect(e.error.code).toBe(-4);
    expect(e.error.message).toBe("The user declined.");
  });

  it("supports the optional ext field", () => {
    expect(err(ERROR.INVALID_REQUEST, "bad", ["detail"]).error.ext).toEqual(["detail"]);
  });
});

describe("the dapp privacy boundary", () => {
  it("permits nothing by default", () => {
    // An allowlist that starts empty cannot fail open.
    expect(DAPP_ALLOWED_CONTRACT_METHODS.size).toBe(0);
    expect(isDappPermittedMethod("anything")).toBe(false);
  });

  it("refuses EVERY confidential operation", () => {
    for (const m of CONFIDENTIAL_METHODS) {
      expect(isDappPermittedMethod(m), `${m} must never be dapp-reachable`).toBe(false);
    }
  });

  it("refuses a method nobody has heard of", () => {
    // The property that a denylist cannot give: a confidential operation added
    // upstream tomorrow is already refused today.
    expect(isDappPermittedMethod("some_future_confidential_op")).toBe(false);
    expect(isDappPermittedMethod("")).toBe(false);
  });

  it("names the confidential set explicitly, for legibility", () => {
    // The allowlist is what enforces; this set exists so a reader can see the
    // intent without inferring it.
    expect(CONFIDENTIAL_METHODS.has("confidential_transfer")).toBe(true);
    expect(CONFIDENTIAL_METHODS.has("register")).toBe(true);
    expect(CONFIDENTIAL_METHODS.has("withdraw")).toBe(true);
  });
});

// The allowlist, now actually in the path.
//
// It was reachable from exactly one place in the repo: the test above. The
// session path held it at arm's length with `void CONFIDENTIAL_METHODS`, so
// the boundary CLAUDE.md described as structural was a comment, and what
// really kept sites out was an unrelated gap in a different file.
describe("what a website may not ask this wallet to sign", () => {
  const SOURCE = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
  const OTHER = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
  const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  const build = (op: Parameters<TransactionBuilder["addOperation"]>[0]) =>
    new TransactionBuilder(new Account(SOURCE, "1"), {
      fee: BASE_FEE,
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(op)
      .setTimeout(180)
      .build()
      .toXDR();

  const call = (fn: string) =>
    build(
      Operation.invokeContractFunction({
        contract: TOKEN,
        function: fn,
        args: [new Address(SOURCE).toScVal(), nativeToScVal(1n, { type: "i128" })],
      }),
    );

  it("refuses every confidential entry point by name", () => {
    for (const m of CONFIDENTIAL_METHODS) {
      expect(dappForbiddenInvocation(call(m), Networks.TESTNET), m).toBe(m);
    }
  });

  it("refuses an ordinary contract call too, because the list is an ALLOWlist", () => {
    // The point of the shape. A denylist would let this through and would let
    // through whatever confidential operation is added to the contract next.
    expect(dappForbiddenInvocation(call("transfer"), Networks.TESTNET)).toBe("transfer");
    expect(dappForbiddenInvocation(call("swap_exact_in"), Networks.TESTNET)).toBe("swap_exact_in");
  });

  it("refuses deploying or uploading code, which has no consent screen at all", () => {
    const upload = build(Operation.uploadContractWasm({ wasm: Buffer.from([0, 97, 115, 109]) }));
    expect(dappForbiddenInvocation(upload, Networks.TESTNET)).toMatch(/contract code/);
  });

  it("permits a classic payment, which is what a public-pocket session is for", () => {
    const pay = build(
      Operation.payment({ destination: OTHER, asset: Asset.native(), amount: "1" }),
    );
    expect(dappForbiddenInvocation(pay, Networks.TESTNET)).toBeNull();
  });

  it("refuses rather than permits when it cannot read the envelope", () => {
    // This function must never be the reason something gets through.
    expect(dappForbiddenInvocation("not-xdr", Networks.TESTNET)).not.toBeNull();
  });

  it("would permit a method only once it is explicitly listed", () => {
    // Documents the one way through, so the empty set is a decision rather
    // than an oversight.
    expect(DAPP_ALLOWED_CONTRACT_METHODS.size).toBe(0);
    expect(isDappPermittedMethod("anything")).toBe(false);
  });
});
