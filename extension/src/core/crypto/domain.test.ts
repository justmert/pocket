import { describe, it, expect } from "vitest";
import { DOMAIN, TWO_MASK_TAGS, CIRCUIT_TYPE } from "./domain";

describe("domain separation tags", () => {
  it("matches DESIGN_cont.md 13 exactly, all sixteen", () => {
    expect(Object.values(DOMAIN)).toEqual([
      1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n, 11n, 12n, 13n, 14n, 15n, 16n,
    ]);
  });

  it("puts ECDH at 13, not DISCLOSURE", () => {
    // The reference demo assigns DISCLOSURE=13, DISCLOSURE_BIND=14,
    // EPHEMERAL_KEY=15. Porting that table, or shifting it by one, silently
    // maps DISCLOSURE onto EPHEMERAL_KEY.
    expect(DOMAIN.ECDH_SHARED_SECRET).toBe(13n);
    expect(DOMAIN.EPHEMERAL_KEY).toBe(14n);
    expect(DOMAIN.DISCLOSURE_BIND).toBe(15n);
    expect(DOMAIN.DISCLOSURE).toBe(16n);
  });

  it("keeps all sixteen distinct", () => {
    const vals = Object.values(DOMAIN);
    expect(new Set(vals).size).toBe(vals.length);
  });

  it("names exactly the two sponge tags that carry two lanes", () => {
    expect(TWO_MASK_TAGS).toEqual([11n, 12n]);
  });
});

describe("circuit type discriminants", () => {
  it("matches the on-chain enum ordering", () => {
    expect(CIRCUIT_TYPE).toEqual({
      Register: 0, Withdraw: 1, Transfer: 2,
      SpenderTransfer: 3, SetSpender: 4, RevokeSpender: 5,
    });
  });
});
