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

/** Keys in the order they were EMITTED, which is what Soroban validates. */
function wireKeys(bytes: Uint8Array): string[] {
  const top = xdr.ScVal.fromXDR(Buffer.from(bytes)).map()!;
  const payload = top.find((e) => e.key().sym().toString() === "payload")!;
  return payload
    .val()
    .map()!
    .map((e) => e.key().sym().toString());
}

describe("the wire order of the real payloads", () => {
  // Every other assertion in this file sorts the decoded keys before comparing,
  // which throws away the one property Soroban actually enforces. These read
  // the order off the encoded bytes instead.
  const withdraw = encodeWithdrawData(
    { cSpendNew: P(), bTilde: 0x11n, RE: scalarMul(5n, H), sigma: 0x22n, bTildeAudS: 0x33n },
    proof,
  );
  const transfer = encodeTransferData(
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

  it("emits the transfer payload in ascending key order", () => {
    // This exact ordering is the one a real testnet transfer was accepted
    // under, so it is the reference the others are checked against. It also
    // spans the cases that could plausibly differ: a key that is a prefix of
    // another (b_tilde / b_tilde_aud_s) and keys either side of the nine-
    // character boundary where a Soroban Symbol stops being packed inline.
    expect(wireKeys(transfer)).toEqual([
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
  });

  it("orders withdraw's keys consistently with the transfer that landed", () => {
    // Unshield has not been accepted on chain yet, so its ordering cannot be
    // cited as proven. What CAN be shown is that every pairwise ordering it
    // relies on already appears in the transfer ordering above: its keys are a
    // subsequence of them, so no untested comparison is involved.
    const order = wireKeys(withdraw);
    expect(order).toEqual(["b_tilde", "b_tilde_aud_s", "c_spend_new", "r_e_point", "sigma"]);
    const reference = wireKeys(transfer);
    expect(order.every((k) => reference.includes(k))).toBe(true);
    expect(order.map((k) => reference.indexOf(k))).toEqual(
      [...order.map((k) => reference.indexOf(k))].sort((a, b) => a - b),
    );
  });

  it("emits the register payload in ascending key order", () => {
    expect(wireKeys(encodeRegisterData(P(), scalarMul(3n, H), proof))).toEqual(["pvk", "y"]);
  });

  it("puts payload before proof at the top level", () => {
    const top = xdr.ScVal.fromXDR(Buffer.from(transfer))
      .map()!
      .map((e) => e.key().sym().toString());
    expect(top).toEqual(["payload", "proof"]);
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
