import { describe, it, expect } from "vitest";
import {
  CCTP,
  STELLAR_DOMAIN,
  assertBurnParameters,
  buildForwarderHookData,
  parseForwarderHookData,
  toCctpAmount,
  fromCctpAmount,
  CctpParameterError,
  type BurnParams,
} from "./cctp";

const good = (): BurnParams => ({
  mintRecipient: CCTP.testnet.forwarder,
  destinationCaller: CCTP.testnet.forwarder,
  destinationDomain: STELLAR_DOMAIN,
  recipient: "GC6JCCFWYPYIHOR7SYXEBRJ5RD32ULVXCQS2P5TDDDCR3AYT6V56CDMN",
  amount: 1_000_000n,
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
