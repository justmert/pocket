import { describe, it, expect } from "vitest";
import {
  orderAndDedupe,
  comparePosition,
  applyEvent,
  replay,
  openCheckpoint,
  INITIAL_STATE,
  type ConfidentialEvent,
} from "./sync";
import { encryptBalance, spendRandomness, vkFromSk } from "./crypto/derive";

const VK = vkFromSk(0xdeadn, 0xbeefn);
const ME = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";
const KEYS = { vk: VK, address: ME };

const ev = (
  p: Partial<ConfidentialEvent> & Pick<ConfidentialEvent, "type" | "id">,
): ConfidentialEvent => ({
  ledger: 1,
  txApplicationOrder: 1,
  eventIndex: 0,
  account: ME,
  data: {},
  ...p,
});

describe("canonical ordering", () => {
  it("orders by ledger, then application order, then event index", () => {
    // tx_hash conveys no ordering, so it must not be used for it.
    const a = { ledger: 1, txApplicationOrder: 2, eventIndex: 0 };
    const b = { ledger: 1, txApplicationOrder: 1, eventIndex: 5 };
    const c = { ledger: 2, txApplicationOrder: 0, eventIndex: 0 };
    expect(comparePosition(b, a)).toBeLessThan(0);
    expect(comparePosition(a, c)).toBeLessThan(0);
  });

  it("sorts an out-of-order batch into emission order", () => {
    const out = orderAndDedupe([
      ev({ id: "c", type: "Merge", ledger: 3 }),
      ev({ id: "a", type: "Deposit", ledger: 1 }),
      ev({ id: "b", type: "Deposit", ledger: 2 }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("drops duplicates, which a hybrid source delivers at its seam", () => {
    // Crediting rules accumulate, so a duplicate inflates a balance.
    const out = orderAndDedupe([
      ev({ id: "x", type: "Deposit", data: { amount: "100" } }),
      ev({ id: "x", type: "Deposit", data: { amount: "100" } }),
    ]);
    expect(out).toHaveLength(1);
  });

  it("keeps order and dedup strictly before application", () => {
    const dup = ev({ id: "d", type: "Deposit", data: { amount: "500" } });
    const state = replay(INITIAL_STATE, [dup, dup, dup], KEYS);
    expect(state.receiving.value).toBe(500n);
  });
});

describe("event application", () => {
  it("credits a deposit to RECEIVING, not spendable", () => {
    // This is the property that makes shielding two transactions. A user who
    // deposits and immediately tries to send finds zero spendable.
    const s = applyEvent(
      INITIAL_STATE,
      ev({ id: "1", type: "Deposit", data: { amount: "500" } }),
      KEYS,
    );
    expect(s.receiving.value).toBe(500n);
    expect(s.spendable.value).toBe(0n);
  });

  it("commits a deposit with randomness zero", () => {
    const s = applyEvent(
      INITIAL_STATE,
      ev({ id: "1", type: "Deposit", data: { amount: "500" } }),
      KEYS,
    );
    expect(s.receiving.randomness).toBe(0n);
  });

  it("moves receiving into spendable on merge", () => {
    let s = applyEvent(
      INITIAL_STATE,
      ev({ id: "1", type: "Deposit", data: { amount: "500" } }),
      KEYS,
    );
    s = applyEvent(s, ev({ id: "2", type: "Merge", ledger: 2 }), KEYS);
    expect(s.spendable.value).toBe(500n);
    expect(s.receiving.value).toBe(0n);
  });

  it("produces different state for merge-then-deposit vs deposit-then-merge", () => {
    // Which is exactly why emission order is not negotiable.
    const d = ev({ id: "d", type: "Deposit", ledger: 1, data: { amount: "500" } });
    const m = ev({ id: "m", type: "Merge", ledger: 1, txApplicationOrder: 2 });
    const depositFirst = replay(INITIAL_STATE, [d, m], KEYS);
    const mergeFirst = replay(INITIAL_STATE, [{ ...m, ledger: 1, txApplicationOrder: 0 }, d], KEYS);
    expect(depositFirst.spendable.value).toBe(500n);
    expect(mergeFirst.spendable.value).toBe(0n);
    expect(mergeFirst.receiving.value).toBe(500n);
  });

  it("resets everything on Register", () => {
    let s = applyEvent(
      INITIAL_STATE,
      ev({ id: "1", type: "Deposit", data: { amount: "500" } }),
      KEYS,
    );
    s = applyEvent(s, ev({ id: "2", type: "Register", ledger: 2 }), KEYS);
    expect(s.spendable.value).toBe(0n);
    expect(s.receiving.value).toBe(0n);
  });
});

describe("checkpoints", () => {
  const sigma = 0x1234n;
  const vNew = 777n;
  const checkpoint = ev({
    id: "w",
    type: "Withdraw",
    data: {
      b_tilde: encryptBalance(vNew, VK, sigma).toString(16).padStart(64, "0"),
      sigma: sigma.toString(16).padStart(64, "0"),
    },
  });

  it("re-derives the spendable opening from one event", () => {
    const opening = openCheckpoint(checkpoint, VK);
    expect(opening.value).toBe(vNew);
    expect(opening.randomness).toBe(spendRandomness(VK, sigma));
  });

  it("OVERWRITES spendable rather than adjusting it", () => {
    // So a wallet that missed intervening events still converges on the
    // spendable side. The receiving side has no such self-healing.
    const stale = { ...INITIAL_STATE, spendable: { value: 999999n, randomness: 5n } };
    const s = applyEvent(stale, checkpoint, KEYS);
    expect(s.spendable.value).toBe(vNew);
  });

  it("leaves the receiving side untouched", () => {
    const s = applyEvent(
      { ...INITIAL_STATE, receiving: { value: 42n, randomness: 3n } },
      checkpoint,
      KEYS,
    );
    expect(s.receiving.value).toBe(42n);
  });
});

describe("cursor", () => {
  it("advances to the last applied event", () => {
    const s = replay(
      INITIAL_STATE,
      [
        ev({ id: "a", type: "Deposit", ledger: 1, data: { amount: "1" } }),
        ev({ id: "b", type: "Deposit", ledger: 9, data: { amount: "1" } }),
      ],
      KEYS,
    );
    expect(s.cursor?.ledger).toBe(9);
  });

  it("starts null on a fresh wallet", () => {
    expect(INITIAL_STATE.cursor).toBeNull();
  });
});
