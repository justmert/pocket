// Spec 18.7's display policy, on the path that actually renders.
//
// `core/spam.ts` was imported by exactly one file: its own test. Nothing on the
// history path referenced `partitionForDisplay`, so a zero-value inbound
// confidential transfer became an ordinary "Received privately from G...  0 XLM"
// row, and an account being flooded got one row per spam event with nothing to
// collapse or hide them.
import { describe, it, expect } from "vitest";
import { markSpam } from "./private-history";
import type { HistoryEntry } from "./messages";

const SPAMMER = "GB43MNLS6IL7GZDPTLXKKMFSPHDGSVCUEHBIMLZR6EXPKLXLQCT3HXQD";
const FRIEND = "GDYXWRHXUTWKXQZ33IKCZLKKDTGNKERWXFRVM5Z7H7TFYZJBHMC7UAIK";

let n = 0;
const entry = (over: Partial<HistoryEntry>): HistoryEntry => ({
  id: `e${++n}`,
  pocket: "private",
  kind: "privateReceive",
  direction: "in",
  code: "XLM",
  amount: "0.0000000",
  at: n * 1000,
  hash: `h${n}`,
  ledger: n,
  ...over,
});

const spamOf = (es: HistoryEntry[]) =>
  markSpam(es)
    .filter((e) => e.spam)
    .map((e) => e.id);

describe("zero-value inbound transfers from strangers", () => {
  it("marks one from an address this account has never sent to", () => {
    const e = entry({ counterparty: SPAMMER });
    expect(spamOf([e])).toEqual([e.id]);
  });

  it("does not mark a real payment, however small", () => {
    const e = entry({ counterparty: SPAMMER, amount: "0.0000001" });
    expect(spamOf([e])).toEqual([]);
  });

  it("does not mark an amount this device could not read as a zero", () => {
    // null is "unknowable on this device", which is a different fact from zero,
    // and hiding it would hide a payment that may have been real.
    const e = entry({ counterparty: SPAMMER, amount: null });
    expect(spamOf([e])).toEqual([]);
  });

  it("does not mark one from an address the user chose to transact with", () => {
    // "Known" comes from this same stream: an address this account has sent to
    // is one the user picked. The wallet has no address book to consult.
    const sent = entry({ counterparty: FRIEND, kind: "privateSend", direction: "out" });
    const back = entry({ counterparty: FRIEND });
    expect(spamOf([sent, back])).toEqual([]);
  });

  it("keeps every entry in the list, marked rather than dropped", () => {
    // Nothing filtered may be unreachable, and the event still participates in
    // the balance replay whatever the display does.
    const es = [entry({ counterparty: SPAMMER }), entry({ counterparty: FRIEND, amount: "1.0" })];
    const out = markSpam(es);
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.id)).toEqual(es.map((e) => e.id));
  });

  it("leaves outbound and non-transfer entries alone", () => {
    const es = [
      entry({ counterparty: SPAMMER, kind: "privateSend", direction: "out", amount: "0.0000000" }),
      entry({ counterparty: SPAMMER, kind: "shield", direction: "in", amount: "0.0000000" }),
      entry({ kind: "setup", direction: "self", amount: null, counterparty: undefined }),
    ];
    expect(spamOf(es)).toEqual([]);
  });

  it("marks every one of a flood, so the screen can collapse them into a count", () => {
    const flood = Array.from({ length: 40 }, () => entry({ counterparty: SPAMMER }));
    expect(spamOf(flood)).toHaveLength(40);
  });
});
