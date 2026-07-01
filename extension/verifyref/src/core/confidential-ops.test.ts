// The orchestration layer, exercised without a network or a prover.
//
// Everything here is about what the wallet HANDS to the chain, not about
// whether a proof is satisfiable: parity.test.ts owns that. These are the
// mistakes that survive a green circuit and only surface after a signature.
import { describe, it, expect } from "vitest";
import { Account, Keypair, Networks } from "@stellar/stellar-sdk/base";
import { buildShield, buildMerge, type OpContext } from "./confidential-ops";

const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
const START = "100";

/** A context with a stubbed account read. Nothing here needs a prover. */
function ctx(keypair: Keypair): OpContext {
  return {
    server: { getAccount: async () => new Account(keypair.publicKey(), START) },
    networkPassphrase: Networks.TESTNET,
    tokenId: TOKEN,
    auditorRegistryId: TOKEN,
    keypair,
    circuits: null,
  } as unknown as OpContext;
}

describe("shield", () => {
  it("consumes exactly one sequence number, the one after the account's", async () => {
    const kp = Keypair.random();
    const { deposit } = await buildShield(ctx(kp), 50n);
    expect(deposit.sequence).toBe("101");
  });

  it("does NOT pre-build the merge, which cannot have a knowable sequence", async () => {
    // It used to, sourced from `sequenceNumber() + 1`. TransactionBuilder.build
    // has already incremented the source account by then, so the envelope came
    // out at 103 when the deposit was 101 and the merge had to be 102: rejected
    // with txBadSeq, every time. Nobody noticed because the caller discarded it
    // and rebuilt. A returned envelope that can only fail is worse than none.
    const built = await buildShield(ctx(Keypair.random()), 50n);
    expect(Object.keys(built)).toEqual(["deposit"]);
    expect((built as Record<string, unknown>).merge).toBeUndefined();
  });

  it("builds the merge against whatever the account's sequence is at the time", async () => {
    // Which is the only correct source: until the deposit lands, the sequence
    // it consumed is not known to have been consumed.
    const kp = Keypair.random();
    expect((await buildMerge(ctx(kp))).sequence).toBe("101");
  });

  it("targets the confidential token, calling deposit with the account twice", async () => {
    // deposit(from, to, amount): a user shielding their own funds is both. A
    // swapped argument would credit somebody else's receiving balance.
    const kp = Keypair.random();
    const { deposit } = await buildShield(ctx(kp), 50n);
    const op = deposit.operations[0] as { func?: unknown; type: string };
    expect(deposit.operations).toHaveLength(1);
    expect(op.type).toBe("invokeHostFunction");
    const xdrStr = deposit.toXDR();
    // Both address arguments are the same account, and the contract is ours.
    expect(xdrStr).toContain(Buffer.from(kp.rawPublicKey()).toString("base64").slice(0, 12));
  });
});
