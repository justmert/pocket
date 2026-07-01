// XDR payload encoding for the `data: Bytes` argument.
//
// Every confidential entrypoint takes one opaque `Bytes` blob that decodes to a
// Soroban `#[contracttype]` struct: `{ payload, proof }`. A contracttype struct
// serialises as an ScVal map whose keys are Symbols, and Soroban requires those
// keys in sorted order, so the encoder sorts rather than relying on declaration
// order matching.
//
// Field types, from packages/tokens/src/confidential/storage.rs:
//   Point      = BytesN<64>   uncompressed affine x||y, big-endian
//   scalars    = BytesN<32>   canonical F_r, big-endian
//   proof      = Bytes        the 456-field proof, WITHOUT public inputs
import { xdr } from "@stellar/stellar-sdk/base";
import { encodePoint, type Point } from "../crypto/grumpkin";
import { toBytesBE } from "../crypto/field";

type FieldValue = Point | bigint | Uint8Array;

const isPoint = (v: FieldValue): v is Point =>
  typeof v === "object" && v !== null && "x" in v && "y" in v;

function toScVal(v: FieldValue): xdr.ScVal {
  if (isPoint(v)) return xdr.ScVal.scvBytes(Buffer.from(encodePoint(v)));
  if (typeof v === "bigint") return xdr.ScVal.scvBytes(Buffer.from(toBytesBE(v)));
  return xdr.ScVal.scvBytes(Buffer.from(v));
}

/**
 * Build an ScVal map from named fields. Keys are sorted, because Soroban
 * requires ScMap keys in ascending order and rejects anything else with a
 * conversion error that gives no hint about ordering.
 */
export function structToScVal(fields: Record<string, FieldValue | xdr.ScVal>): xdr.ScVal {
  const entries = Object.keys(fields)
    .sort()
    .map((k) => {
      const raw = fields[k] as FieldValue | xdr.ScVal;
      const val = raw instanceof xdr.ScVal ? raw : toScVal(raw);
      return new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val });
    });
  return xdr.ScVal.scvMap(entries);
}

/** Serialise a `{ payload, proof }` envelope to the bytes the entrypoint takes. */
export function encodeEnvelope(payload: Record<string, FieldValue>, proof: Uint8Array): Uint8Array {
  const env = structToScVal({
    payload: structToScVal(payload),
    proof: xdr.ScVal.scvBytes(Buffer.from(proof)),
  });
  return new Uint8Array(env.toXDR());
}

/** Register: { y, pvk }. */
export function encodeRegisterData(y: Point, pvk: Point, proof: Uint8Array): Uint8Array {
  return encodeEnvelope({ y, pvk }, proof);
}

/** Withdraw: { c_spend_new, b_tilde, r_e_point, sigma, b_tilde_aud_s }. */
export function encodeWithdrawData(
  p: {
    cSpendNew: Point;
    bTilde: bigint;
    RE: Point;
    sigma: bigint;
    bTildeAudS: bigint;
  },
  proof: Uint8Array,
): Uint8Array {
  return encodeEnvelope(
    {
      c_spend_new: p.cSpendNew,
      b_tilde: p.bTilde,
      r_e_point: p.RE,
      sigma: p.sigma,
      b_tilde_aud_s: p.bTildeAudS,
    },
    proof,
  );
}

/** Transfer: the ten fields of TransferPayload. */
export function encodeTransferData(
  p: {
    cSpendNew: Point;
    cTransfer: Point;
    RE: Point;
    vTilde: bigint;
    bTilde: bigint;
    sigma: bigint;
    vTildeAudR: bigint;
    rTildeAudR: bigint;
    vTildeAudS: bigint;
    bTildeAudS: bigint;
  },
  proof: Uint8Array,
): Uint8Array {
  return encodeEnvelope(
    {
      c_spend_new: p.cSpendNew,
      c_transfer: p.cTransfer,
      r_e_point: p.RE,
      v_tilde: p.vTilde,
      b_tilde: p.bTilde,
      sigma: p.sigma,
      v_tilde_aud_r: p.vTildeAudR,
      r_tilde_aud_r: p.rTildeAudR,
      v_tilde_aud_s: p.vTildeAudS,
      b_tilde_aud_s: p.bTildeAudS,
    },
    proof,
  );
}

/** Decode an envelope back, for round-trip testing and for reading events. */
export function decodeEnvelope(bytes: Uint8Array): {
  payload: Record<string, Uint8Array>;
  proof: Uint8Array;
} {
  const v = xdr.ScVal.fromXDR(Buffer.from(bytes));
  const entries = v.map();
  if (!entries) throw new Error("envelope is not an ScMap");
  const top = new Map(entries.map((e) => [e.key().sym().toString(), e.val()] as const));
  const payloadVal = top.get("payload");
  const proofVal = top.get("proof");
  if (!payloadVal || !proofVal) throw new Error("envelope is missing payload or proof");

  const payload: Record<string, Uint8Array> = {};
  for (const e of payloadVal.map() ?? []) {
    payload[e.key().sym().toString()] = new Uint8Array(e.val().bytes());
  }
  return { payload, proof: new Uint8Array(proofVal.bytes()) };
}
