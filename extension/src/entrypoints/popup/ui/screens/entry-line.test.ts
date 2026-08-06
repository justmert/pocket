// The sentence a history row says about itself.
//
// One entry kind reaches this function from BOTH directions, and the wording
// only fitted one of them.
import { describe, it, expect } from "vitest";
import { entryLine } from "./History";
import type { HistoryEntry } from "../../../../core/messages";

const THEM = "GATHEM7AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAATHEM";

const entry = (over: Partial<HistoryEntry>): HistoryEntry =>
  ({
    id: "1",
    pocket: "public",
    at: 0,
    hash: "h",
    kind: "receive",
    direction: "in",
    code: "XLM",
    amount: "1.0000000",
    ...over,
  }) as HistoryEntry;

describe("what a create_account row says", () => {
  it("calls the account's own creation what it is", () => {
    expect(entryLine(entry({ kind: "create", direction: "in", counterparty: THEM }))).toBe(
      "Account funded",
    );
  });

  it("does not tell the FUNDER their account was funded", () => {
    // Same kind, other side: this account paid the starting balance of a new
    // one and the XLM is gone. "Account funded" reads as money arriving.
    const said = entryLine(entry({ kind: "create", direction: "out", counterparty: THEM }));
    expect(said, "the funder's row read as money arriving").not.toBe("Account funded");
    expect(said).toContain("Funded a new account");
    expect(said, "the row has to name the account that got the money").toContain("GATH");
  });
});
