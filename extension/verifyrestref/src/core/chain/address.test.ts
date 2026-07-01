import { describe, it, expect } from "vitest";
import { Keypair } from "@stellar/stellar-sdk/base";
import {
  parseAddress,
  isValidAddress,
  chunkAddress,
  shortenForList,
  isLookalike,
  InvalidAddressError,
} from "./address";

const G = "GB43MNLS6IL77FIZHOBLYILQIQP5MPQVF77O5JOAYCSWX3TUHAL6Z3F7";
const C = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

describe("address parsing", () => {
  it("recognises accounts and contracts", () => {
    expect(parseAddress(G).kind).toBe("account");
    expect(parseAddress(C).kind).toBe("contract");
  });

  it("tolerates surrounding whitespace from a paste", () => {
    expect(parseAddress(`  ${G}\n`).value).toBe(G);
  });

  it("separates a checksum failure from junk", () => {
    // A single-character typo keeps the shape but breaks the CRC16.
    const typo = G.slice(0, 40) + (G[40] === "A" ? "B" : "A") + G.slice(41);
    expect(() => parseAddress(typo)).toThrow(InvalidAddressError);
    try {
      parseAddress(typo);
    } catch (e) {
      expect((e as InvalidAddressError).reason).toBe("checksum");
    }
    try {
      parseAddress("hello");
    } catch (e) {
      expect((e as InvalidAddressError).reason).toBe("malformed");
    }
  });

  it("rejects an empty string rather than treating it as valid", () => {
    expect(isValidAddress("")).toBe(false);
  });
});

describe("confirm-step display", () => {
  it("never truncates: every character survives chunking", () => {
    // 4+4 truncation is breakable in about an hour on a laptop, so a confirm
    // screen must show the whole address.
    const chunks = chunkAddress(G);
    expect(chunks.join("")).toBe(G);
    expect(chunks.join("").length).toBe(56);
  });

  it("groups in fours", () => {
    expect(chunkAddress(G)).toHaveLength(14);
    expect(chunkAddress(G)[0]).toHaveLength(4);
  });

  it("keeps the list form clearly distinct from the confirm form", () => {
    expect(shortenForList(G)).toContain("…");
    expect(shortenForList(G).length).toBeLessThan(G.length);
    expect(chunkAddress(G).join("")).not.toContain("…");
  });
});

describe("lookalike detection", () => {
  it("flags an address matching on first-4 and last-4", () => {
    const fake = G.slice(0, 4) + Keypair.random().publicKey().slice(4, 52) + G.slice(-4);
    expect(isLookalike(G, fake)).toBe(true);
  });

  it("does not flag an address against itself", () => {
    expect(isLookalike(G, G)).toBe(false);
  });

  it("does not flag an unrelated address", () => {
    expect(isLookalike(G, C)).toBe(false);
  });
});
