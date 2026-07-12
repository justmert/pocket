// The private-history walk: turning replayed confidential events into a
// per-transaction list, with amounts read off the same state transitions that
// make a balance spendable.
//
// Events are built as the sync engine's own tests build them (plain decoded
// objects), and the one checkpoint case uses the real crypto so the sent/
// withdrawn amount is derived exactly as it would be on chain.
import { describe, it, expect } from "vitest";
import { deriveHistory, type DecodedEvent } from "./private-history";
import type { ConfidentialEvent } from "./sync";
import { encryptBalance, vkFromSk } from "./crypto/derive";
import { toBytesBE } from "./crypto/field";

const VK = vkFromSk(0xdeadn, 0xbeefn);
const ME = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";
const THEM = "GB43MNLS6IL7GZDPTLXKKMFSPHDGSVCUEHBIMLZR6EXPKLXLQCT3HXQD";
const KEYS = { vk: VK, address: ME };

/** A decoded event at a given ledger, with synthetic timestamp and hash. */
function ev(
  ledger: number,
  p: Partial<ConfidentialEvent> & Pick<ConfidentialEvent, "type" | "id">,
): DecodedEvent {
  const event: ConfidentialEvent = {
    ledger,
    txApplicationOrder: 1,
    eventIndex: 0,
    topics: [ME],
    data: {},
    ...p,
  };
  return { event, at: ledger * 1000, hash: `hash-${p.id}`, ledger };
}

const deposit = (ledger: number, id: string, from: string, to: string, amount: bigint) =>
  ev(ledger, { id, type: "deposit", topics: [from, to], data: { amount } });

/** A spendable checkpoint that resolves to `vNew`, as withdraw and sent transfers emit. */
function checkpointBody(vNew: bigint, sigma = 0x1234n) {
  return { b_tilde: toBytesBE(encryptBalance(vNew, VK, sigma)), sigma: toBytesBE(sigma) };
}

const run = (events: DecodedEvent[]) => deriveHistory(events, KEYS, "XLM");

describe("private history from replayed events", () => {
  it("shows a deposit as a shield in, with the public amount and the funder", () => {
    const [entry, ...rest] = run([deposit(1, "d1", THEM, ME, 500n)]);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      pocket: "private",
      kind: "shield",
      direction: "in",
      code: "XLM",
      amount: "0.0000500",
      counterparty: THEM,
      at: 1000,
      hash: "hash-d1",
      ledger: 1,
    });
  });

  it("has no counterparty when the deposit is the account funding its own pocket", () => {
    const [entry] = run([deposit(1, "d1", ME, ME, 500n)]);
    expect(entry!.counterparty).toBeUndefined();
    expect(entry!.direction).toBe("in");
  });

  it("shows a merge as making the received balance spendable, for its amount", () => {
    const entries = run([
      deposit(1, "d1", THEM, ME, 500n),
      ev(2, { id: "m1", type: "merge", topics: [ME] }),
    ]);
    const merge = entries.find((e) => e.id === "m1")!;
    expect(merge).toMatchObject({ kind: "makeSpendable", direction: "self", amount: "0.0000500" });
  });

  it("derives an unshield amount from the drop in the spendable balance", () => {
    // deposit 500, merge it to spendable, then withdraw down to 200: unshield 300.
    const entries = run([
      deposit(1, "d1", THEM, ME, 500n),
      ev(2, { id: "m1", type: "merge", topics: [ME] }),
      ev(3, { id: "w1", type: "withdraw", topics: [ME, THEM], data: checkpointBody(200n) }),
    ]);
    const withdraw = entries.find((e) => e.id === "w1")!;
    expect(withdraw).toMatchObject({
      kind: "unshield",
      direction: "out",
      amount: "0.0000300",
      counterparty: THEM,
    });
  });

  it("shows an inbound transfer it cannot verify with a null amount, and does not guess", () => {
    // A transfer TO us with no invocation payload cannot be opened; the amount is
    // unknowable on this device, but the transaction itself is still shown.
    const [entry] = run([ev(1, { id: "t1", type: "transfer", topics: [THEM, ME], data: {} })]);
    expect(entry).toMatchObject({
      kind: "privateReceive",
      direction: "in",
      counterparty: THEM,
      amount: null,
    });
  });

  it("nulls amounts derived from the running total once an event could not be replayed", () => {
    // deposit (exact), then an unreadable inbound transfer, then a merge: the
    // merge's amount now depends on a total we could not complete, so it is null
    // rather than wrong. The deposit's own public amount stays exact.
    const entries = run([
      deposit(1, "d1", THEM, ME, 300n),
      ev(2, { id: "t1", type: "transfer", topics: [THEM, ME], data: {} }),
      ev(3, { id: "m1", type: "merge", topics: [ME] }),
    ]);
    expect(entries.find((e) => e.id === "d1")!.amount).toBe("0.0000300");
    expect(entries.find((e) => e.id === "t1")!.amount).toBeNull();
    expect(entries.find((e) => e.id === "m1")!.amount).toBeNull();
  });

  it("shows registration as setup, with no amount", () => {
    const [entry] = run([ev(1, { id: "r1", type: "register", topics: [ME] })]);
    expect(entry).toMatchObject({ kind: "setup", direction: "self", amount: null });
  });

  it("ignores events that belong to other accounts", () => {
    expect(
      run([
        deposit(1, "d1", ME, THEM, 500n), // a deposit to someone else
        ev(2, { id: "r1", type: "register", topics: [THEM] }),
        ev(3, { id: "t1", type: "transfer", topics: [THEM, THEM], data: {} }),
      ]),
    ).toEqual([]);
  });

  it("ignores delegation config, which is not a payment", () => {
    expect(
      run([
        ev(1, { id: "s1", type: "set_spender", topics: [ME, THEM], data: checkpointBody(0n) }),
        ev(2, { id: "s2", type: "revoke_spender", topics: [ME, THEM], data: checkpointBody(0n) }),
      ]),
    ).toEqual([]);
  });

  it("returns entries newest first, carrying each event's own timestamp and hash", () => {
    const entries = run([
      deposit(5, "d5", THEM, ME, 100n),
      deposit(2, "d2", THEM, ME, 200n),
      deposit(9, "d9", THEM, ME, 300n),
    ]);
    expect(entries.map((e) => e.id)).toEqual(["d9", "d5", "d2"]);
    expect(entries.map((e) => e.at)).toEqual([9000, 5000, 2000]);
    expect(entries[0]!.hash).toBe("hash-d9");
  });
});
