import { describe, it, expect } from "vitest";
import {
  attributionOf,
  ordinalFromEventId,
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
  it("takes the ordinal from the event id", () => {
    expect(ordinalFromEventId("0016751686714413056-0000000003")).toBe(3);
  });

  it("falls back to zero on an unfamiliar id rather than throwing", () => {
    expect(ordinalFromEventId("nonsense")).toBe(0);
  });
});
