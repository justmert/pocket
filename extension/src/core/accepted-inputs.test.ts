// What a screen accepts has to match what the worker accepts.
//
// Two places where a screen was stricter than the code behind it, and in both
// the screen's extra strictness was the whole defect.
import { describe, it, expect } from "vitest";
import "../lib/polyfill";

describe("recovery phrase lengths", () => {
  // Recover.tsx gated the only forgotten-password route on
  // `words === 12 || words === 24`, disabled the button when it failed, and
  // said "A recovery phrase is 12 or 24 words." The worker accepts every BIP-39
  // length: doImport and doRecoverFromMnemonic both gate on validateMnemonic,
  // which passes 128, 160, 192, 224 and 256 bits of entropy.
  //
  // So a 15-word holder was told their own recovery phrase was not a recovery
  // phrase, on the one screen that exists to let them back in.

  it("the screen's list is exactly what BIP-39 defines", async () => {
    const { PHRASE_LENGTHS } = await import("../entrypoints/popup/ui/copy");
    expect([...PHRASE_LENGTHS].sort((a, b) => a - b)).toEqual([12, 15, 18, 21, 24]);
  });

  it("every length the screen accepts really does validate", async () => {
    // Against the same validator the worker gates on, not a restatement of it.
    const { generateMnemonic, validateMnemonic } = await import("@scure/bip39");
    const { wordlist } = await import("@scure/bip39/wordlists/english.js");
    const { PHRASE_LENGTHS } = await import("../entrypoints/popup/ui/copy");

    // 12 words is 128 bits and each further three words adds 32.
    for (const words of PHRASE_LENGTHS) {
      const bits = 128 + ((words - 12) / 3) * 32;
      const phrase = generateMnemonic(wordlist, bits);
      expect(phrase.trim().split(/\s+/).length, `${bits} bits`).toBe(words);
      expect(validateMnemonic(phrase, wordlist), `${words} words rejected`).toBe(true);
    }
  });

  it("does not accept a length BIP-39 has no entropy size for", async () => {
    // The control. A gate that accepts everything is not a gate, and a 13-word
    // phrase is a typo rather than a wallet.
    const { PHRASE_LENGTHS } = await import("../entrypoints/popup/ui/copy");
    for (const words of [0, 1, 11, 13, 23, 25, 48]) {
      expect(PHRASE_LENGTHS.includes(words), `${words} accepted`).toBe(false);
    }
  });

  it("names every accepted length in the sentence it shows", async () => {
    const { phraseLengthList, PHRASE_LENGTHS } = await import("../entrypoints/popup/ui/copy");
    const said = phraseLengthList();
    for (const n of PHRASE_LENGTHS) expect(said).toContain(String(n));
    // And reads as a list rather than repeating its last item.
    expect(said).toBe("12, 15, 18, 21 or 24");
  });
});

describe("CCTP destination chains", () => {
  // CCTP_DOMAIN_NAMES named BNB Smart Chain and the picker offered it. No route
  // exists: the user picked it, paid for the approve, and the burn trapped at
  // Error(Contract, #7106), deterministically. Three live oracles agreed on
  // 2026-08-08: get_remote_token_messenger(17) returns None on the deployed
  // TokenMessengerMinter, Iris answers "Invalid source/destination domain id"
  // for 27 -> 17 on sandbox AND mainnet, and a real deposit_for_burn to 17
  // simulated to #7106.

  it("does not offer a chain the burn cannot reach", async () => {
    const { cctpCanBurnTo, CCTP_DOMAIN_NAMES } = await import("./integrations/cctp");
    expect(CCTP_DOMAIN_NAMES[17], "the premise moved").toBe("BNB Smart Chain");
    expect(cctpCanBurnTo(17), "BNB Smart Chain is named and unreachable").toBe(false);
  });

  it("still offers the ones measured as reachable", async () => {
    // The control, and the list is the measurement:
    // get_remote_token_messenger returned a value for each of these.
    const { cctpCanBurnTo } = await import("./integrations/cctp");
    for (const d of [0, 1, 2, 3, 5, 6, 7, 10, 11, 16]) {
      expect(cctpCanBurnTo(d), `domain ${d} was measured reachable`).toBe(true);
    }
  });

  it("treats a domain nobody has ever named as unreachable", async () => {
    const { cctpCanBurnTo } = await import("./integrations/cctp");
    expect(cctpCanBurnTo(999)).toBe(false);
  });

  it("keeps the picker and the worker on ONE list", async () => {
    // They read two, which is how a chain nobody can bridge to came to be
    // offered by name on the screen that charges for trying.
    const { SEND_DOMAINS } = await import("../entrypoints/popup/ui/screens/CctpSend");
    const { cctpCanBurnTo, STELLAR_DOMAIN } = await import("./integrations/cctp");
    for (const c of SEND_DOMAINS) {
      expect(cctpCanBurnTo(c.domain), `${c.name} is offered and unreachable`).toBe(true);
      expect(c.domain).not.toBe(STELLAR_DOMAIN);
    }
    expect(SEND_DOMAINS.map((c) => c.name)).not.toContain("BNB Smart Chain");
    // And the picker is not empty, which would satisfy every line above.
    expect(SEND_DOMAINS.length).toBeGreaterThan(4);
  });
});
