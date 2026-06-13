import { describe, it, expect } from "vitest";
import {
  orderAndDedupe,
  comparePosition,
  applyEvent,
  replay,
  openCheckpoint,
  isReplayEvent,
  MalformedEventError,
  UnreplayableEventError,
  INITIAL_STATE,
  REPLAY_EVENTS,
  type ConfidentialEvent,
} from "./sync";
import { encryptBalance, spendRandomness, vkFromSk } from "./crypto/derive";
import { toBytesBE } from "./crypto/field";

const VK = vkFromSk(0xdeadn, 0xbeefn);
const ME = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";
const THEM = "GB43MNLS6IL7GZDPTLXKKMFSPHDGSVCUEHBIMLZR6EXPKLXLQCT3HXQD";
const KEYS = { vk: VK, address: ME };

const ev = (
  p: Partial<ConfidentialEvent> & Pick<ConfidentialEvent, "type" | "id">,
): ConfidentialEvent => ({
  ledger: 1,
  txApplicationOrder: 1,
  eventIndex: 0,
  topics: [ME],
  data: {},
  ...p,
});

/** A deposit as the contract publishes it: topics [from, to], body {amount: i128}. */
const deposit = (id: string, amount: bigint, rest: Partial<ConfidentialEvent> = {}) =>
  ev({ id, type: "deposit", topics: [ME, ME], data: { amount }, ...rest });

describe("the event vocabulary matches the contract", () => {
  it("names events exactly as topic[0] spells them", () => {
    // soroban-sdk derives topic[0] as the snake_case of the event struct name
    // (soroban-sdk-macros 27.0.2 derive_event.rs:106). sync.live.test.ts pins
    // the same four names against the live deployment.
    expect([...REPLAY_EVENTS]).toEqual([
      "register",
      "deposit",
      "merge",
      "withdraw",
      "transfer",
      "spender_transfer",
      "set_spender",
      "revoke_spender",
    ]);
    expect(isReplayEvent("Deposit")).toBe(false);
    expect(isReplayEvent("deposit")).toBe(true);
  });

  it("refuses an event type it does not understand rather than returning nothing", () => {
    // `type` comes off the wire, so the switch is reachable with anything.
    const rogue = {
      ...ev({ id: "x", type: "deposit" }),
      type: "Deposit",
    } as unknown as ConfidentialEvent;
    expect(() => applyEvent(INITIAL_STATE, rogue, KEYS)).toThrow(MalformedEventError);
  });
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
      ev({ id: "c", type: "merge", ledger: 3 }),
      deposit("a", 1n, { ledger: 1 }),
      deposit("b", 1n, { ledger: 2 }),
    ]);
    expect(out.map((e) => e.id)).toEqual(["a", "b", "c"]);
  });

  it("drops duplicates, which a hybrid source delivers at its seam", () => {
    // Crediting rules accumulate, so a duplicate inflates a balance.
    const out = orderAndDedupe([deposit("x", 100n), deposit("x", 100n)]);
    expect(out).toHaveLength(1);
  });

  it("keeps order and dedup strictly before application", () => {
    const dup = deposit("d", 500n);
    const state = replay(INITIAL_STATE, [dup, dup, dup], KEYS);
    expect(state.receiving.value).toBe(500n);
  });
});

describe("event application", () => {
  it("credits a deposit to RECEIVING, not spendable", () => {
    // This is the property that makes shielding two transactions. A user who
    // deposits and immediately tries to send finds zero spendable.
    const s = applyEvent(INITIAL_STATE, deposit("1", 500n), KEYS);
    expect(s.receiving.value).toBe(500n);
    expect(s.spendable.value).toBe(0n);
  });

  it("commits a deposit with randomness zero", () => {
    const s = applyEvent(INITIAL_STATE, deposit("1", 500n), KEYS);
    expect(s.receiving.randomness).toBe(0n);
  });

  it("credits by the `to` topic, never by attribution", () => {
    // The archive attributes a deposit to BOTH parties. Funding someone else's
    // pocket must not credit ours.
    const outbound = ev({ id: "o", type: "deposit", topics: [ME, THEM], data: { amount: 500n } });
    const s = applyEvent(INITIAL_STATE, outbound, KEYS);
    expect(s.receiving.value).toBe(0n);
    expect(s.cursor?.ledger).toBe(1);
  });

  it("moves receiving into spendable on merge", () => {
    let s = applyEvent(INITIAL_STATE, deposit("1", 500n), KEYS);
    s = applyEvent(s, ev({ id: "2", type: "merge", ledger: 2 }), KEYS);
    expect(s.spendable.value).toBe(500n);
    expect(s.receiving.value).toBe(0n);
  });

  it("ignores somebody else's merge", () => {
    const s0 = applyEvent(INITIAL_STATE, deposit("1", 500n), KEYS);
    const s = applyEvent(s0, ev({ id: "2", type: "merge", ledger: 2, topics: [THEM] }), KEYS);
    expect(s.receiving.value).toBe(500n);
    expect(s.spendable.value).toBe(0n);
  });

  it("produces different state for merge-then-deposit vs deposit-then-merge", () => {
    // Which is exactly why emission order is not negotiable.
    const d = deposit("d", 500n, { ledger: 1 });
    const m = ev({ id: "m", type: "merge", ledger: 1, txApplicationOrder: 2 });
    const depositFirst = replay(INITIAL_STATE, [d, m], KEYS);
    const mergeFirst = replay(INITIAL_STATE, [{ ...m, ledger: 1, txApplicationOrder: 0 }, d], KEYS);
    expect(depositFirst.spendable.value).toBe(500n);
    expect(mergeFirst.spendable.value).toBe(0n);
    expect(mergeFirst.receiving.value).toBe(500n);
  });

  it("resets everything on register", () => {
    let s = applyEvent(INITIAL_STATE, deposit("1", 500n), KEYS);
    s = applyEvent(s, ev({ id: "2", type: "register", ledger: 2 }), KEYS);
    expect(s.spendable.value).toBe(0n);
    expect(s.receiving.value).toBe(0n);
  });
});

describe("nothing is defaulted", () => {
  it("refuses a deposit with no amount rather than crediting zero", () => {
    // A zero credit is the worst available answer: it replays cleanly and only
    // surfaces as an unspendable balance much later.
    const missing = ev({ id: "1", type: "deposit", topics: [ME, ME], data: {} });
    expect(() => applyEvent(INITIAL_STATE, missing, KEYS)).toThrow(MalformedEventError);
  });

  it("refuses an amount that is not an i128", () => {
    // The body decodes i128 to bigint. A decimal string means the decoder and
    // the contract disagree, and guessing which is right loses money.
    const stringy = ev({ id: "1", type: "deposit", topics: [ME, ME], data: { amount: "500" } });
    expect(() => applyEvent(INITIAL_STATE, stringy, KEYS)).toThrow(MalformedEventError);
  });

  it("refuses a negative amount", () => {
    const negative = ev({ id: "1", type: "deposit", topics: [ME, ME], data: { amount: -1n } });
    expect(() => applyEvent(INITIAL_STATE, negative, KEYS)).toThrow(MalformedEventError);
  });

  it("refuses an event with no party topic", () => {
    const headless = ev({ id: "1", type: "merge", topics: [] });
    expect(() => applyEvent(INITIAL_STATE, headless, KEYS)).toThrow(MalformedEventError);
  });

  it("refuses a checkpoint with no b_tilde rather than deriving one from zero", () => {
    // (0 - mask) mod r is a plausible 254-bit balance. It would overwrite the
    // spendable side with a number that never existed.
    const truncated = ev({
      id: "w",
      type: "withdraw",
      topics: [ME, ME],
      data: { sigma: toBytesBE(0x1234n) },
    });
    expect(() => openCheckpoint(truncated, VK)).toThrow(MalformedEventError);
  });

  it("refuses a non-canonical field element", () => {
    // The host's bn254_fr deserialiser silently reduces out-of-range bytes, so
    // two encodings would denote one value. The contract rejects that (3514).
    const overflowing = new Uint8Array(32).fill(0xff);
    const bad = ev({
      id: "w",
      type: "withdraw",
      topics: [ME, ME],
      data: { b_tilde: overflowing, sigma: toBytesBE(0x1234n) },
    });
    expect(() => openCheckpoint(bad, VK)).toThrow(MalformedEventError);
  });

  it("refuses a field element of the wrong width", () => {
    const short = ev({
      id: "w",
      type: "withdraw",
      topics: [ME, ME],
      data: { b_tilde: new Uint8Array(31), sigma: toBytesBE(0x1234n) },
    });
    expect(() => openCheckpoint(short, VK)).toThrow(MalformedEventError);
  });
});

describe("checkpoints", () => {
  const sigma = 0x1234n;
  const vNew = 777n;
  const body = {
    b_tilde: toBytesBE(encryptBalance(vNew, VK, sigma)),
    sigma: toBytesBE(sigma),
  };
  const checkpoint = ev({ id: "w", type: "withdraw", topics: [ME, THEM], data: body });

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

  it("checkpoints the sender side of a transfer", () => {
    const sent = ev({ id: "t", type: "transfer", topics: [ME, THEM], data: body });
    expect(applyEvent(INITIAL_STATE, sent, KEYS).spendable.value).toBe(vNew);
  });

  it("checkpoints on set_spender and revoke_spender", () => {
    // Both call set_spendable: one escrows part of the balance into an
    // allowance, the other folds what is left of it back.
    for (const type of ["set_spender", "revoke_spender"] as const) {
      const e = ev({ id: type, type, topics: [ME, THEM], data: body });
      expect(applyEvent(INITIAL_STATE, e, KEYS).spendable.value).toBe(vNew);
    }
  });

  it("ignores a checkpoint belonging to someone else", () => {
    const theirs = ev({ id: "t", type: "transfer", topics: [THEM, "GA".padEnd(56, "X")], data: body });
    const stale = { ...INITIAL_STATE, spendable: { value: 999999n, randomness: 5n } };
    expect(applyEvent(stale, theirs, KEYS).spendable.value).toBe(999999n);
  });

  it("ignores a spender_transfer that spends someone else's allowance", () => {
    // confidential_transfer_from debits the delegation, not the owner's
    // spendable, so the owner has nothing to replay.
    const e = ev({ id: "s", type: "spender_transfer", topics: [THEM, ME, THEM], data: {} });
    const stale = { ...INITIAL_STATE, spendable: { value: 4n, randomness: 5n } };
    expect(applyEvent(stale, e, KEYS).spendable.value).toBe(4n);
  });
});

describe("inbound credits this build cannot verify", () => {
  // C_transfer travels in the invocation payload, not the event, so an event
  // stream alone cannot prove a decrypted amount is really ours.
  it("refuses an inbound transfer rather than crediting an unverifiable amount", () => {
    const inbound = ev({ id: "t", type: "transfer", topics: [THEM, ME], data: {} });
    expect(() => applyEvent(INITIAL_STATE, inbound, KEYS)).toThrow(UnreplayableEventError);
  });

  it("refuses an inbound spender_transfer for the same reason", () => {
    const inbound = ev({ id: "s", type: "spender_transfer", topics: [THEM, THEM, ME], data: {} });
    expect(() => applyEvent(INITIAL_STATE, inbound, KEYS)).toThrow(UnreplayableEventError);
  });

  it("refuses a self-transfer whole, never half-applied", () => {
    const body = {
      b_tilde: toBytesBE(encryptBalance(1n, VK, 9n)),
      sigma: toBytesBE(9n),
    };
    const self = ev({ id: "t", type: "transfer", topics: [ME, ME], data: body });
    expect(() => applyEvent(INITIAL_STATE, self, KEYS)).toThrow(UnreplayableEventError);
  });
});

describe("cursor", () => {
  it("advances to the last applied event", () => {
    const s = replay(
      INITIAL_STATE,
      [deposit("a", 1n, { ledger: 1 }), deposit("b", 1n, { ledger: 9 })],
      KEYS,
    );
    expect(s.cursor?.ledger).toBe(9);
  });

  it("starts null on a fresh wallet", () => {
    expect(INITIAL_STATE.cursor).toBeNull();
  });
});
