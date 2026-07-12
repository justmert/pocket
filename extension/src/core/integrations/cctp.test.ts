import { describe, it, expect } from "vitest";
import {
  CCTP,
  STELLAR_DOMAIN,
  assertBurnParameters,
  buildForwarderHookData,
  evmAddressToBytes32,
  bytes32ToEvmAddress,
  parseForwarderHookData,
  toCctpAmount,
  toCctpFee,
  fromCctpAmount,
  CctpParameterError,
  type BurnParams,
} from "./cctp";

const good = (): BurnParams => ({
  mintRecipient: CCTP.testnet.forwarder,
  destinationCaller: CCTP.testnet.forwarder,
  destinationDomain: STELLAR_DOMAIN,
  recipient: "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN",
  // 1_000_000 stroops = 0.1 USDC at 7dp; the fee is 6dp, so a sane one is small.
  amount: 1_000_000n,
  maxFee: 1_000n,
  network: "testnet",
});

describe("the parameter rule that destroys funds when broken", () => {
  it("accepts a correctly parameterised burn", () => {
    expect(() => assertBurnParameters(good())).not.toThrow();
  });

  it("REFUSES a user account as mintRecipient", () => {
    // Circle: "If mintRecipient is set to a user account or muxed address,
    // USDC is not sent to the forwarder... funds become permanently stuck."
    expect(() => assertBurnParameters({ ...good(), mintRecipient: good().recipient })).toThrow(
      CctpParameterError,
    );
  });

  it("REFUSES a zero destinationCaller, which lets a third party strand the funds", () => {
    expect(() => assertBurnParameters({ ...good(), destinationCaller: "0".repeat(56) })).toThrow(
      /destinationCaller must be the CctpForwarder/,
    );
  });

  it("REFUSES a mismatched destinationCaller", () => {
    expect(() =>
      assertBurnParameters({ ...good(), destinationCaller: CCTP.mainnet.forwarder }),
    ).toThrow(CctpParameterError);
  });

  it("REFUSES the wrong destination domain", () => {
    expect(() => assertBurnParameters({ ...good(), destinationDomain: 0 })).toThrow(
      /destinationDomain must be 27/,
    );
  });

  it("REFUSES a malformed recipient", () => {
    expect(() => assertBurnParameters({ ...good(), recipient: "not-an-address" })).toThrow();
  });

  it("explains the consequence, not just the rule", () => {
    // A pre-flight that says "invalid parameter" teaches nobody. This one has
    // to say what happens.
    try {
      assertBurnParameters({ ...good(), mintRecipient: good().recipient });
    } catch (e) {
      expect((e as Error).message).toMatch(/cannot be recovered/i);
    }
  });

  it("uses different forwarders per network, and does not accept the other one", () => {
    expect(CCTP.testnet.forwarder).not.toBe(CCTP.mainnet.forwarder);
    expect(() => assertBurnParameters({ ...good(), network: "mainnet" })).toThrow(
      CctpParameterError,
    );
  });
});

describe("hook data layout", () => {
  const R = "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN";

  it("round-trips the recipient", () => {
    const parsed = parseForwarderHookData(buildForwarderHookData(R));
    expect(parsed.recipient).toBe(R);
    expect(parsed.version).toBe(0);
  });

  it("writes 24 zero magic bytes then a zero version", () => {
    const d = buildForwarderHookData(R);
    expect(Array.from(d.subarray(0, 24))).toEqual(new Array(24).fill(0));
    expect(new DataView(d.buffer).getUint32(24, false)).toBe(0);
  });

  it("writes the strkey length big-endian at bytes 28-31", () => {
    const d = buildForwarderHookData(R);
    expect(new DataView(d.buffer).getUint32(28, false)).toBe(56);
  });

  it("carries an optional integrator payload after the recipient", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const parsed = parseForwarderHookData(buildForwarderHookData(R, payload));
    expect(Array.from(parsed.payload)).toEqual([1, 2, 3]);
  });

  it("rejects truncated hook data rather than reading past the end", () => {
    expect(() => parseForwarderHookData(new Uint8Array(10))).toThrow(/shorter than/);
    const d = buildForwarderHookData(R);
    expect(() => parseForwarderHookData(d.subarray(0, 40))).toThrow(/overruns/);
  });
});

describe("the decimal mismatch", () => {
  it("reports the dust rather than silently dropping it", () => {
    // Stellar USDC has 7 decimals; CCTP's amount field has 6. Bridging
    // 0.1234567 burns 0.1234560 and leaves 0.0000007 behind. Users report this
    // as a bug unless it is shown.
    const { cctpAmount, dust } = toCctpAmount(1_234_567n);
    expect(cctpAmount).toBe(123_456n);
    expect(dust).toBe(7n);
  });

  it("leaves no dust for an exactly-representable amount", () => {
    expect(toCctpAmount(1_234_560n)).toEqual({ cctpAmount: 123_456n, dust: 0n });
  });

  it("scales back up by ten on the way in", () => {
    expect(fromCctpAmount(123_456n)).toBe(1_234_560n);
  });

  it("round-trips only when the amount was already representable", () => {
    expect(fromCctpAmount(toCctpAmount(1_234_560n).cctpAmount)).toBe(1_234_560n);
    expect(fromCctpAmount(toCctpAmount(1_234_567n).cctpAmount)).not.toBe(1_234_567n);
  });
});

describe("the decimal trap on max_fee", () => {
  it("accepts a fee correctly scaled to six decimals", () => {
    expect(() => assertBurnParameters({ ...good(), maxFee: 1_000n })).not.toThrow();
  });

  it("rejects a fee passed at the amount's seven-decimal scale", () => {
    // The exact mistake: reaching for the 7dp amount to fill a 6dp field.
    expect(() => assertBurnParameters({ ...good(), maxFee: 1_000_000n })).toThrow(
      CctpParameterError,
    );
  });

  it("rejects a negative fee", () => {
    expect(() => assertBurnParameters({ ...good(), maxFee: -1n })).toThrow(CctpParameterError);
  });

  it("scales a fee with a function named apart from the amount's", () => {
    // Both divide by ten. Two names is the point: one function for both scales
    // is how the two get confused in the first place.
    expect(toCctpFee(1_000_000n)).toBe(100_000n);
    expect(toCctpAmount(1_000_000n).cctpAmount).toBe(100_000n);
  });

  it("fails with a typed error on an unknown network, not a TypeError", () => {
    const p = { ...good(), network: "futurenet" as unknown as BurnParams["network"] };
    expect(() => assertBurnParameters(p)).toThrow(CctpParameterError);
  });
});

describe("EVM recipient checksums", () => {
  // The four canonical vectors from EIP-55 itself.
  const VALID = [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];

  it("accepts every checksummed address in the EIP-55 spec", () => {
    for (const a of VALID) {
      expect(() => evmAddressToBytes32(a), a).not.toThrow();
    }
  });

  it("accepts the case-insensitive forms, which carry no checksum", () => {
    // Every EVM tool emits all-lowercase at some point. Refusing it would reject
    // a legitimate address, so the guard only fires where a checksum exists.
    for (const a of VALID) {
      expect(() => evmAddressToBytes32(a.toLowerCase()), a).not.toThrow();
      expect(() => evmAddressToBytes32("0x" + a.slice(2).toUpperCase()), a).not.toThrow();
    }
  });

  it("refuses a checksummed address with one character transposed", () => {
    // The realistic failure: an address copied correctly and then corrupted.
    // Nothing downstream can catch it. The USDC burns on Stellar and mints to
    // whatever the message names on the far chain.
    const broken = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD"; // final d -> D
    expect(() => evmAddressToBytes32(broken)).toThrow(CctpParameterError);
    expect(() => evmAddressToBytes32(broken)).toThrow(/checksum/i);
  });

  it("still refuses anything that is not 20 bytes of hex", () => {
    // The control: the length check must survive the new one.
    expect(() => evmAddressToBytes32("0xdeadbeef")).toThrow(CctpParameterError);
    expect(() => evmAddressToBytes32("not an address")).toThrow(CctpParameterError);
  });

  it("puts the 20 bytes right-aligned in the 32-byte field", () => {
    // CCTP's field has no chain encoding, so the alignment is the meaning.
    const out = evmAddressToBytes32(VALID[0]!);
    expect(out).toHaveLength(32);
    expect([...out.slice(0, 12)]).toEqual(new Array(12).fill(0));
    expect(Buffer.from(out.slice(12)).toString("hex")).toBe(VALID[0]!.slice(2).toLowerCase());
  });
});

describe("a mint recipient can be read back out of the bytes that get signed", () => {
  // The four EIP-55 spec vectors, again, from the other direction. The encoder
  // only has to ACCEPT these capitalisations; the decoder has to PRODUCE them,
  // which is a strictly stronger statement about the same table.
  const VECTORS = [
    "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed",
    "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359",
    "0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB",
    "0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb",
  ];

  it("round-trips every spec vector, capitalisation included", () => {
    for (const addr of VECTORS) {
      expect(bytes32ToEvmAddress(evmAddressToBytes32(addr)), addr).toBe(addr);
    }
  });

  it("recovers the checksummed form from a lowercase input", () => {
    // The case a user is most likely to paste. The sheet must show the form
    // they can compare against an explorer, not the one they typed.
    const lower = VECTORS[0]!.toLowerCase();
    expect(bytes32ToEvmAddress(evmAddressToBytes32(lower))).toBe(VECTORS[0]);
  });

  it("refuses 32 bytes that are not a left-padded EVM address", () => {
    // CCTP left-pads 20 bytes into 32. Something in the top twelve means this is
    // not an EVM address, and printing its bottom twenty as one would name a
    // destination that is not where the money goes.
    const dirty = evmAddressToBytes32(VECTORS[0]!);
    dirty[3] = 0x01;
    expect(() => bytes32ToEvmAddress(dirty)).toThrow(CctpParameterError);
  });

  it("refuses a value that is not 32 bytes at all", () => {
    expect(() => bytes32ToEvmAddress(new Uint8Array(20))).toThrow(CctpParameterError);
    expect(() => bytes32ToEvmAddress(new Uint8Array(33))).toThrow(CctpParameterError);
  });

  it("does not quietly agree with a different address", () => {
    // The control. Without it the round-trip above passes for a decoder that
    // returns its input.
    expect(bytes32ToEvmAddress(evmAddressToBytes32(VECTORS[0]!))).not.toBe(VECTORS[1]);
  });
});
