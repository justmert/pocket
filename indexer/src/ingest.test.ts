import { describe, it, expect } from "vitest";
import {
  attributionOf,
  eventPosition,
  ATTRIBUTED_TOPICS,
  IN_SCOPE,
  EventShapeError,
} from "./ingest.ts";

const ALICE = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";
const BOB = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7";
const CAROL = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";

describe("attribution follows the event TYPE, not the topic shape", () => {
  it("attributes each in-scope type to exactly its parties", () => {
    // Layouts verified against real testnet events, see resources/testnet-evidence.md.
    expect(attributionOf("register", ["register", ALICE])).toEqual([ALICE]);
    expect(attributionOf("merge", ["merge", ALICE])).toEqual([ALICE]);
    expect(attributionOf("deposit", ["deposit", ALICE, BOB])).toEqual([ALICE, BOB]);
    expect(attributionOf("withdraw", ["withdraw", ALICE, BOB])).toEqual([ALICE, BOB]);
    expect(attributionOf("transfer", ["transfer", ALICE, BOB])).toEqual([ALICE, BOB]);
    expect(attributionOf("set_spender", ["set_spender", ALICE, BOB])).toEqual([ALICE, BOB]);
    expect(attributionOf("revoke_spender", ["revoke_spender", ALICE, BOB])).toEqual([ALICE, BOB]);
    expect(attributionOf("spender_transfer", ["spender_transfer", CAROL, ALICE, BOB])).toEqual([
      CAROL,
      ALICE,
      BOB,
    ]);
  });

  it("covers every in-scope type, so none can be ingested unattributed", () => {
    for (const type of IN_SCOPE) expect(ATTRIBUTED_TOPICS[type]).toBeGreaterThan(0);
  });

  it("names one account once when a party appears twice", () => {
    // A self-deposit is the normal shield flow: from and to are the same.
    expect(attributionOf("deposit", ["deposit", ALICE, ALICE])).toEqual([ALICE]);
  });

  it("refuses an EXTRA address topic rather than absorbing it", () => {
    // The leak this guards. Matching on shape alone would write CAROL into
    // ALICE's and BOB's history the day upstream adds a non-party topic, and
    // nothing would report it.
    expect(() => attributionOf("transfer", ["transfer", ALICE, BOB, CAROL])).toThrow(
      EventShapeError,
    );
  });

  it("refuses a MISSING address topic rather than dropping a party", () => {
    // The mirror failure: a party silently lost from their own history
    // replays to a wrong balance just as surely.
    expect(() => attributionOf("transfer", ["transfer", ALICE])).toThrow(EventShapeError);
  });

  it("refuses a topic that is not an address", () => {
    expect(() => attributionOf("transfer", ["transfer", ALICE, null])).toThrow(EventShapeError);
    expect(() => attributionOf("transfer", ["transfer", ALICE, "not-an-address"])).toThrow(
      EventShapeError,
    );
  });

  it("refuses a type it was not written against", () => {
    expect(() => attributionOf("some_new_event", ["some_new_event", ALICE])).toThrow(
      EventShapeError,
    );
  });
});

describe("event ordering key", () => {
  // Every id below was read from soroban-testnet, not constructed. Ledger
  // 4021819 is the one that exposed the defect: seven distinct TOIDs whose
  // trailing number all began at 0.
  it("separates the operation's position from the event's index within it", () => {
    expect(eventPosition("0017273581075431424-0000000000")).toEqual({ operation: 0, index: 0 });
    // Same ledger, transaction application order 1: 1 << 12 === 4096.
    expect(eventPosition("0017273581075435520-0000000000")).toEqual({ operation: 4096, index: 0 });
    // Same ledger and transaction, operation index 2.
    expect(eventPosition("0017273581075435522-0000000000")).toEqual({ operation: 4098, index: 0 });
    // Transaction application order 8: 8 << 12 === 32768.
    expect(eventPosition("0017273581075464192-0000000000")).toEqual({ operation: 32768, index: 0 });
  });

  it("keeps events of one operation apart by their own index", () => {
    const a = eventPosition("0017274427183988736-0000000000");
    const b = eventPosition("0017274427183988736-0000000011");
    expect(a.operation).toBe(b.operation);
    expect(a.index).toBe(0);
    expect(b.index).toBe(11);
  });

  // The regression the old implementation shipped: it returned the trailing
  // number alone, so these three events from three different transactions in
  // one ledger all keyed as 0 and the keyset pagination read them as one row.
  it("gives three events from three transactions in one ledger three keys", () => {
    const keys = [
      "0017273581075431424-0000000000",
      "0017273581075435520-0000000000",
      "0017273581075439616-0000000000",
    ].map((id) => {
      const p = eventPosition(id);
      return `${p.operation}:${p.index}`;
    });
    expect(new Set(keys).size).toBe(3);
  });

  // 0xFFFFF000 in the low 32 bits. `Number(toid) >> 12` is a SIGNED 32-bit
  // shift and reads this back as -1, which would sort the marker before every
  // real event in its ledger.
  it("reads the ledger-scoped marker as a large positive position", () => {
    const p = eventPosition("0017273585370394624-0000000000");
    expect(p.operation).toBe(0xfffff000);
    expect(p.operation).toBeGreaterThan(0);
  });

  it("falls back to zero on an unfamiliar id rather than throwing", () => {
    expect(eventPosition("nonsense")).toEqual({ operation: 0, index: 0 });
    expect(eventPosition("")).toEqual({ operation: 0, index: 0 });
    expect(eventPosition("12345-notanumber")).toEqual({ operation: 0, index: 0 });
  });
});
