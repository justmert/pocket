// What a completed operation claims about the user's money.
import { describe, it, expect } from "vitest";
import { opToEntry, OP_SHAPE, isPlainReason } from "./opEntry";
import type { BgOp } from "./WalletProvider";

const op = (verb: string, extra: Partial<BgOp> = {}): BgOp => ({
  id: "op-1",
  verb,
  pocket: "public",
  code: "XLM",
  amount: "10.0000000",
  status: "done",
  hash: "h".repeat(64),
  at: 1_700_000_000_000,
  ...extra,
});

describe("a watched operation drawn as its settled row", () => {
  it("keeps the shape the real entry will have", () => {
    expect(opToEntry(op("Shield"))).toMatchObject({ kind: "shield", direction: "in" });
    expect(opToEntry(op("Unshield"))).toMatchObject({ kind: "unshield", direction: "out" });
    expect(opToEntry(op("Send"))).toMatchObject({ kind: "send", direction: "out" });
    expect(opToEntry(op("Send privately"))).toMatchObject({
      kind: "privateSend",
      direction: "out",
    });
    expect(opToEntry(op("Make spendable"))).toMatchObject({
      kind: "makeSpendable",
      direction: "self",
    });
    expect(opToEntry(op("Swap"))).toMatchObject({ kind: "swap", direction: "out" });
  });

  it("draws nothing for a verb it has no settled word for", () => {
    // The defect: a chain of `?:` ending in `: "send"`. Every one of these
    // rendered as an outbound payment, and none of them has a recipient, so the
    // row read "Sent to " with nothing after it. Drawing no stand-in is strictly
    // better: the real entry arrives on its own.
    for (const verb of [
      "Deposit",
      "Withdraw",
      "Bridge",
      "Claim",
      // money words, matching every other surface for the same act. the second
      // pair is kept so a rename cannot silently reintroduce a stand-in row.
      "Add asset",
      "Remove asset",
      "Add trustline",
      "Remove trustline",
    ]) {
      expect(opToEntry(op(verb)), verb).toBeNull();
    }
  });

  it("never invents an outbound payment for an unknown verb", () => {
    // The property, not the list: whatever verbs exist in future, none may
    // default into a send.
    expect(opToEntry(op("Some Future Operation"))).toBeNull();
  });

  it("agrees with the private history on direction, so the row does not change shape", () => {
    // core/private-history.ts gives shield "in" and unshield "out". The derived
    // version gave both "self", so the stand-in and the entry it stood in for
    // disagreed and the badge flipped when the archive caught up.
    expect(OP_SHAPE["Shield"]!.direction).toBe("in");
    expect(OP_SHAPE["Unshield"]!.direction).toBe("out");
  });
});

describe("which failure reasons a row may print", () => {
  it("takes a translated reason", () => {
    expect(isPlainReason("the destination account does not exist yet")).toBe(true);
  });

  it("refuses a raw XDR discriminant, so the row says only Failed", () => {
    // `OP_REASON` and `TX_REASON` pass through codes they do not know, and the
    // row then read "Failed · txBadSeq" beside a red alert badge.
    expect(isPlainReason("txBadSeq")).toBe(false);
    expect(isPlainReason("op_underfunded")).toBe(false);
    expect(isPlainReason(undefined)).toBe(false);
  });
});
