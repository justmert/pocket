// The refusals a private operation gets before anything slow happens.
//
// These run ahead of the verification-key check and the circuit load, so they
// are reachable without a chain, a session or a proving backend, which is why
// they can be tested at all. Two of them are here because of what they cost
// when they were missing, not because they are obvious.
import { describe, it, expect } from "vitest";
import { refusePrivateOp } from "./controller";

const ME = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPV6LY4UV2GL6VJGIQRXFDNMADI";
const SOMEONE = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("what a private operation is refused for", () => {
  it("lets an ordinary transfer to somebody else through", () => {
    expect(refusePrivateOp({ kind: "transfer", to: SOMEONE, amount: "1" }, ME)).toBeNull();
  });

  it("refuses a transfer to this wallet's own address", () => {
    // The only transfer that moves the SENDER's receiving commitment, because
    // sender and recipient are one account. Nothing refused it, and the wallet
    // staged a post-state that said receiving had not moved, so an operation
    // that succeeded on chain could not be recorded and the pocket sat
    // diverged with the money already spent.
    const why = refusePrivateOp({ kind: "transfer", to: ME, amount: "1" }, ME);
    expect(why).toMatch(/own address/);
    // It has to say what to do instead. "Make spendable" is the real label on
    // the control that does the thing a self-send was reaching for.
    expect(why).toMatch(/Make spendable/);
  });

  it("refuses a contract address, which cannot hold a confidential balance", () => {
    expect(refusePrivateOp({ kind: "transfer", to: CONTRACT, amount: "1" }, ME)).toMatch(/G\.\.\./);
  });

  it("has nothing to say about the operations that take no address", () => {
    for (const kind of ["register", "shield", "unshield", "merge"] as const) {
      expect(refusePrivateOp({ kind, amount: "1" }, ME)).toBeNull();
    }
  });

  it("refuses a NEGATIVE amount on every operation that takes one", () => {
    // `shield` was not amount-checked at all: it parsed the string, built a
    // deposit for it, and put "Move -5 XLM from the public pocket into the
    // private one" on the review as a signed fact. `transfer` and `unshield`
    // were checked against the spendable balance, which a negative passes
    // trivially.
    for (const kind of ["shield", "unshield"] as const) {
      expect(refusePrivateOp({ kind, amount: "-5" }, ME), kind).toMatch(/greater than zero/);
    }
    expect(refusePrivateOp({ kind: "transfer", to: SOMEONE, amount: "-5" }, ME)).toMatch(
      /greater than zero/,
    );
  });

  it("refuses zero, which costs a fee and a proof to change nothing", () => {
    expect(refusePrivateOp({ kind: "shield", amount: "0" }, ME)).toMatch(/greater than zero/);
    expect(refusePrivateOp({ kind: "shield", amount: "0.0000000" }, ME)).toMatch(
      /greater than zero/,
    );
  });

  it("checks the amount BEFORE the address, so a negative self-send says so", () => {
    // Two things wrong at once should report the one the user can act on
    // first; either sentence is honest, but the order has to be deterministic.
    expect(refusePrivateOp({ kind: "transfer", to: ME, amount: "-1" }, ME)).toMatch(
      /greater than zero/,
    );
  });

  it("leaves an unparseable amount to the builder, which words it better", () => {
    // `parseAmount` throws an authored sentence naming what is wrong with the
    // text. Pre-empting it here with a worse one would be a regression.
    expect(refusePrivateOp({ kind: "shield", amount: "not a number" }, ME)).toBeNull();
  });
});
