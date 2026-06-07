import { describe, it, expect } from "vitest";
import { xdr } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";
import {
  structToScVal,
  encodeRegisterData,
  encodeWithdrawData,
  encodeTransferData,
  decodeEnvelope,
} from "./payload";
import { commit, scalarMul, H, encodePoint } from "../crypto/grumpkin";
import { EXPECTED_PROOF_BYTES } from "../prover/protocol";

const P = () => commit(1000n, 42n);
const proof = new Uint8Array(EXPECTED_PROOF_BYTES).fill(7);

describe("ScMap key ordering", () => {
  it("sorts keys, which Soroban requires", () => {
    // An unsorted ScMap is rejected with a conversion error that says nothing
    // about ordering, so this is worth pinning rather than relying on the
    // declaration order happening to be alphabetical.
    const v = structToScVal({ zebra: 1n, apple: 2n, mango: 3n });
    const keys = v.map()!.map((e) => e.key().sym().toString());
    expect(keys).toEqual(["apple", "mango", "zebra"]);
  });

  it("produces the same bytes regardless of insertion order", () => {
    const a = structToScVal({ b: 1n, a: 2n });
    const b = structToScVal({ a: 2n, b: 1n });
    expect(a.toXDR("base64")).toBe(b.toXDR("base64"));
  });
});

describe("register envelope", () => {
  const bytes = encodeRegisterData(P(), scalarMul(3n, H), proof);

  it("round-trips", () => {
    const { payload, proof: p } = decodeEnvelope(bytes);
    expect(Object.keys(payload).sort()).toEqual(["pvk", "y"]);
    expect(p).toHaveLength(EXPECTED_PROOF_BYTES);
  });

  it("encodes points as 64 raw bytes, x||y big-endian", () => {
    const { payload } = decodeEnvelope(bytes);
    expect(payload.y).toHaveLength(64);
    expect(Array.from(payload.y!)).toEqual(Array.from(encodePoint(P())));
  });

  it("carries the proof WITHOUT public inputs", () => {
    // bb.js returns publicInputs || proof; the contract takes them separately,
    // so an envelope carrying 15360 bytes here would be rejected.
    const { proof: p } = decodeEnvelope(bytes);
    expect(p).toHaveLength(14592);
  });

  it("is valid XDR that a Soroban host could parse", () => {
    expect(() => xdr.ScVal.fromXDR(Buffer.from(bytes))).not.toThrow();
  });
});

describe("withdraw envelope", () => {
  it("carries exactly the five WithdrawPayload fields", () => {
    const bytes = encodeWithdrawData(
      { cSpendNew: P(), bTilde: 0x11n, RE: scalarMul(5n, H), sigma: 0x22n, bTildeAudS: 0x33n },
      proof,
    );
    const { payload } = decodeEnvelope(bytes);
    expect(Object.keys(payload).sort()).toEqual([
      "b_tilde",
      "b_tilde_aud_s",
      "c_spend_new",
      "r_e_point",
      "sigma",
    ]);
    expect(payload.b_tilde).toHaveLength(32);
    expect(payload.c_spend_new).toHaveLength(64);
  });
});

describe("transfer envelope", () => {
  it("carries exactly the ten TransferPayload fields", () => {
    const bytes = encodeTransferData(
      {
        cSpendNew: P(),
        cTransfer: P(),
        RE: scalarMul(5n, H),
        vTilde: 1n,
        bTilde: 2n,
        sigma: 3n,
        vTildeAudR: 4n,
        rTildeAudR: 5n,
        vTildeAudS: 6n,
        bTildeAudS: 7n,
      },
      proof,
    );
    const { payload } = decodeEnvelope(bytes);
    expect(Object.keys(payload).sort()).toEqual([
      "b_tilde",
      "b_tilde_aud_s",
      "c_spend_new",
      "c_transfer",
      "r_e_point",
      "r_tilde_aud_r",
      "sigma",
      "v_tilde",
      "v_tilde_aud_r",
      "v_tilde_aud_s",
    ]);
    // Three points at 64 bytes, seven scalars at 32.
    expect(Object.values(payload).filter((v) => v.length === 64)).toHaveLength(3);
    expect(Object.values(payload).filter((v) => v.length === 32)).toHaveLength(7);
  });

  it("pads scalars to a full 32 bytes", () => {
    // A short scalar would decode to a different value on chain. BytesN<32> is
    // fixed width, so 1n must be 31 zero bytes then 0x01.
    const bytes = encodeTransferData(
      {
        cSpendNew: P(),
        cTransfer: P(),
        RE: scalarMul(5n, H),
        vTilde: 1n,
        bTilde: 1n,
        sigma: 1n,
        vTildeAudR: 1n,
        rTildeAudR: 1n,
        vTildeAudS: 1n,
        bTildeAudS: 1n,
      },
      proof,
    );
    const { payload } = decodeEnvelope(bytes);
    expect(payload.v_tilde).toHaveLength(32);
    expect(payload.v_tilde![31]).toBe(1);
    expect(payload.v_tilde![0]).toBe(0);
  });
});
