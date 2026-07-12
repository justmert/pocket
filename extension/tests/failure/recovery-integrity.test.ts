// Recovery believes the CHAIN, never the archive.
//
// `recoverOpenings` replays an account's whole history out of the indexer and
// then re-commits the result and compares it against the commitments the
// contract holds. That last step is the entire security of the feature: an
// archive is a witness to history, not the authority on it, and one that is
// broken or hostile must be able to fail to help without being able to hand
// back a wrong balance.
//
// Written because a revert proved the check was UNPINNED: taking the comparison
// out entirely turned nothing red. Every component around it was tested and the
// one line that makes the feature safe was not.
import { describe, it, expect, afterEach } from "vitest";
import { xdr, nativeToScVal } from "@stellar/stellar-sdk/base";
import { recoverOpenings, RecoveryMismatchError, RecoveryUnavailableError } from "../../src/core/recover-openings";
import {
  commit,
  equals,
  IDENTITY,
  IDENTITY as IDENTITY_POINT,
  scalarMul,
  H,
} from "../../src/core/crypto/grumpkin";
import {
  ephemeralScalar,
  sharedScalar,
  transferBlinding,
  encryptAmount,
  publicViewingKey,
} from "../../src/core/crypto/derive";
import { toBytesBE, Q } from "../../src/core/crypto/field";
import { encodeTransferData } from "../../src/core/witness/payload";
import { describeError } from "../../src/core/dispatch";
import { FaultServer } from "./_harness/faults";

const ACCOUNT = "GBIQM4D2YEJEQ7HEDO62QJJEBHUZKXNEGTOXQGI6SGSG3T5N3X5YGRAF";
const FUNDER = "GAKQO2Y5RPBKAVG2PBMLCSG2TFGTED6ERGPOVTOIV54WWC5TRLCZEY6T";
const TOKEN = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
const VK = 0x1234n;

const open: FaultServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

/**
 * One deposit, in the wire form the archive actually stores.
 *
 * Base64 XDR, not a parsed object, because that is what the indexer keeps and
 * what `decodeStored` has to cope with. A fixture built from parsed values
 * would agree with our own decoder by construction and prove nothing about it.
 */
function depositEvent(to: string, amount: bigint, ledger: number) {
  // Concatenated with no envelope, byte for byte what `indexer/src/ingest.ts`
  // writes: `Buffer.concat(e.topic.map((t) => t.toXDR()))`. Encoding these as
  // an ScVec instead would agree with a decoder that reads them as one, and
  // that pair of matching mistakes is exactly what shipped.
  const topics = Buffer.concat(
    [
      nativeToScVal("deposit", { type: "symbol" }),
      nativeToScVal(FUNDER, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
    ].map((t) => t.toXDR()),
  );
  const data = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: nativeToScVal("amount", { type: "symbol" }),
      val: nativeToScVal(amount, { type: "i128" }),
    }),
  ]);
  return {
    id: `${ledger}-0-0`,
    event_type: "deposit",
    ledger_seq: ledger,
    tx_application_order: 0,
    event_index: 0,
    topics_xdr: topics.toString("base64"),
    data_xdr: data.toXDR("base64"),
  };
}

/** A transfer INTO this account, in the same stored wire form. */
function inboundTransferEvent(to: string, ledger: number, amount = 1_000_000n) {
  const topics = Buffer.concat(
    [
      nativeToScVal("transfer", { type: "symbol" }),
      nativeToScVal(FUNDER, { type: "address" }),
      nativeToScVal(to, { type: "address" }),
    ].map((t) => t.toXDR()),
  );

  // A genuine transfer, built with the sending wallet's own derivation, because
  // the recipient's path has to invert it. The event body carries every field
  // the contract publishes AND NOT c_transfer, which is the fact this whole
  // mechanism exists for.
  const SIGMA = 0x0f1e2d3c4b5a69788796a5b4c3d2e1f0n;
  const rE = ephemeralScalar(0xfeedfacen, SIGMA);
  const RE = scalarMul(rE, H);
  const shared = sharedScalar(rE, publicViewingKey(VK));
  const rTransfer = transferBlinding(shared, SIGMA);
  const cTransfer = commit(amount, rTransfer);
  const vTilde = encryptAmount(amount, shared, SIGMA);

  const bytes = (b: Uint8Array) => xdr.ScVal.scvBytes(Buffer.from(b));
  const point = (pt: { x: bigint; y: bigint }) =>
    bytes(Uint8Array.from([...toBytesBE(pt.x, Q), ...toBytesBE(pt.y, Q)]));
  const entry = (k: string, v: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: nativeToScVal(k, { type: "symbol" }), val: v });

  // Sorted: an ScMap's keys are ordered, and the contract emits them so.
  const data = xdr.ScVal.scvMap([
    entry("b_tilde", bytes(toBytesBE(0n))),
    entry("b_tilde_aud_s", bytes(toBytesBE(0n))),
    entry("r_e_point", point(RE)),
    entry("r_tilde_aud_r", bytes(toBytesBE(0n))),
    entry("sigma", bytes(toBytesBE(SIGMA))),
    entry("v_tilde", bytes(toBytesBE(vTilde))),
    entry("v_tilde_aud_r", bytes(toBytesBE(0n))),
    entry("v_tilde_aud_s", bytes(toBytesBE(0n))),
  ]);

  // The invocation payload, encoded exactly as the wallet sends it and as the
  // archive now stores it.
  const payload = encodeTransferData(
    {
      cSpendNew: IDENTITY_POINT,
      cTransfer,
      RE,
      vTilde,
      bTilde: 0n,
      sigma: SIGMA,
      vTildeAudR: 0n,
      rTildeAudR: 0n,
      vTildeAudS: 0n,
      bTildeAudS: 0n,
    },
    new Uint8Array([1, 2, 3]),
  );

  return {
    event: {
      id: `${ledger}-0-0`,
      event_type: "transfer",
      ledger_seq: ledger,
      tx_application_order: 0,
      event_index: 0,
      topics_xdr: topics.toString("base64"),
      data_xdr: data.toXDR("base64"),
      payload_xdr: Buffer.from(payload).toString("base64"),
    },
    // What the contract's receiving accumulator holds after this transfer, when
    // it started empty. NOT commit(amount, 0): a deposit commits with randomness
    // zero, a transfer commits under the blinding the two parties derive, so the
    // accumulator moves by exactly c_transfer.
    cTransfer,
  };
}

/** The same event with the archive's payload column empty, as an old archive serves it. */
function inboundTransferEventWithoutPayload(to: string, ledger: number) {
  const { payload_xdr: _dropped, ...rest } = inboundTransferEvent(to, ledger).event;
  return rest;
}

/** An archive that serves exactly these events and says its window is complete. */
async function archiveServing(events: unknown[], ingestedThrough = 5_000): Promise<string> {
  const server = await FaultServer.start({
    insecure: true,
    fallback: (req) => {
      if (req.path.startsWith("/v1/health")) {
        return {
          kind: "json",
          body: {
            contract_id: TOKEN,
            latest_ledger: ingestedThrough,
            ingested_through: ingestedThrough,
            lag_seconds: 0,
          },
        };
      }
      return {
        kind: "json",
        body: {
          events,
          complete: true,
          cursor: null,
          from_ledger: 1,
          to_ledger: ingestedThrough,
        },
      };
    },
  });
  open.push(server);
  return server.url;
}

/** A deposit credits the RECEIVING side, with randomness 0. That is the rule. */
const receivingCommitmentFor = (total: bigint) => commit(total, 0n);

describe("a rebuilt balance is checked against the contract, not trusted", () => {
  it("accepts a replay that reproduces exactly what the contract holds", async () => {
    // The control. Without it, a test that only ever asserts refusal would pass
    // just as well against a function that refuses everything.
    const url = await archiveServing([
      depositEvent(ACCOUNT, 40_000_000n, 100),
      depositEvent(ACCOUNT, 2_500_000n, 200),
    ]);
    const out = await recoverOpenings(url, TOKEN, ACCOUNT, VK, {
      spendableCommitment: IDENTITY,
      receivingCommitment: receivingCommitmentFor(42_500_000n),
    } as never);
    expect(out.receiving.value).toBe(42_500_000n);
    expect(out.spendable.value).toBe(0n);
    expect(out.syncedThrough).toBe(5_000);
  });

  it("refuses a history that is missing an event, however complete the archive claims to be", async () => {
    // The attack, and the accident, are the same shape: the archive serves a
    // history that is short by one deposit while reporting `complete: true`.
    // The replay is internally consistent and wrong. Only the chain can say so.
    const url = await archiveServing([depositEvent(ACCOUNT, 40_000_000n, 100)]);
    await expect(
      recoverOpenings(url, TOKEN, ACCOUNT, VK, {
        spendableCommitment: IDENTITY,
        receivingCommitment: receivingCommitmentFor(42_500_000n),
      } as never),
    ).rejects.toThrow(RecoveryMismatchError);
  });

  it("refuses a history with an event that never happened", async () => {
    // The other direction: an archive that INVENTS a deposit. A wallet that
    // accepted this would show money it cannot prove it owns, and every later
    // proof against that opening would fail with no explanation.
    const url = await archiveServing([
      depositEvent(ACCOUNT, 40_000_000n, 100),
      depositEvent(ACCOUNT, 999_000_000n, 150),
    ]);
    await expect(
      recoverOpenings(url, TOKEN, ACCOUNT, VK, {
        spendableCommitment: IDENTITY,
        receivingCommitment: receivingCommitmentFor(40_000_000n),
      } as never),
    ).rejects.toThrow(RecoveryMismatchError);
  });

  it("names the side that disagreed, and says the funds are safe", async () => {
    const url = await archiveServing([depositEvent(ACCOUNT, 1n, 100)]);
    const err = await recoverOpenings(url, TOKEN, ACCOUNT, VK, {
      spendableCommitment: IDENTITY,
      receivingCommitment: receivingCommitmentFor(2n),
    } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecoveryMismatchError);
    const shown = describeError(err);
    // The refusal reaches the user in our words. A "check your connection" here
    // would send someone to retry a thing that will never succeed.
    expect(shown).toMatch(/does not match/i);
    expect(shown).toMatch(/receiving/i);
    expect(shown).toMatch(/safe on chain/i);
    expect(shown).not.toMatch(/check your connection/i);
  });

  it("refuses before contacting anything when no archive is configured", async () => {
    // Distinct from a mismatch: nothing is wrong, there is simply no durable
    // history to replay, and pretending otherwise is what loses the openings.
    await expect(
      recoverOpenings(undefined, TOKEN, ACCOUNT, VK, {
        spendableCommitment: IDENTITY,
        receivingCommitment: IDENTITY,
      } as never),
    ).rejects.toThrow(RecoveryUnavailableError);
  });

  it("rebuilds a RECEIVED transfer when the archive supplies the invocation payload", async () => {
    // The whole point of storing payloads. Same event as the refusal test
    // below; the only difference is that the archive kept the invocation.
    //
    // This is end to end through `recoverOpenings`: the archive serves rows,
    // `decodeStored` decodes the payload into c_transfer, the replay verifies
    // the decryption against it, and the result is checked against the
    // commitments the contract holds. A wrong replay cannot reach the assertion.
    const t = inboundTransferEvent(ACCOUNT, 300, 7_500_000n);
    const url = await archiveServing([t.event]);
    const out = await recoverOpenings(url, TOKEN, ACCOUNT, VK, {
      spendableCommitment: IDENTITY,
      receivingCommitment: t.cTransfer,
    } as never);
    expect(out.receiving.value).toBe(7_500_000n);
    // And the rebuilt opening must OPEN that commitment, which is what makes it
    // spendable rather than merely a correct-looking number.
    expect(equals(commit(out.receiving.value, out.receiving.randomness), t.cTransfer)).toBe(true);
  });

  it("refuses a RECEIVED transfer when the archive has no payload for it, in words a person can act on", async () => {
    // The limit that matters most in practice, because any account that has been
    // paid confidentially hits it. The contract passes C_transfer in the
    // invocation payload and does not publish it in the event, so nothing in the
    // event stream can confirm a decrypted amount is the committed one. Refusing
    // is correct. Refusing with "check your connection" is not: it sends someone
    // to retry a network fault that does not exist.
    const url = await archiveServing([inboundTransferEventWithoutPayload(ACCOUNT, 300)]);
    const err = await recoverOpenings(url, TOKEN, ACCOUNT, VK, {
      spendableCommitment: IDENTITY,
      receivingCommitment: IDENTITY,
    } as never).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecoveryUnavailableError);
    const shown = describeError(err);
    expect(shown).toMatch(/missing the transaction details/i);
    expect(shown).toMatch(/received/i);
    expect(shown).toMatch(/safe on chain/i);
    expect(shown).not.toMatch(/check your connection/i);
    // And not the internal wording, which names circuit variables.
    expect(shown).not.toMatch(/r_e_point|v_tilde|sigma/);
  });

  it("refuses an event it cannot READ in words a person can act on, not a network excuse", async () => {
    // The sibling of the case above, and it escaped the same translation. A
    // `MalformedEventError` is an archive serving a shape the contract does not
    // emit, which no retry can affect, and it reached the screen as "Something
    // went wrong. Try again, and check your connection."
    //
    // Truncating the event body is the cheapest faithful way to produce one: the
    // field decoders in sync.ts throw exactly this when a value is the wrong
    // length.
    const t = inboundTransferEvent(ACCOUNT, 300);
    const url = await archiveServing([{ ...t.event, data_xdr: "AAAAAA==" }]);
    const err = await recoverOpenings(url, TOKEN, ACCOUNT, VK, {
      spendableCommitment: IDENTITY,
      receivingCommitment: IDENTITY,
    } as never).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(RecoveryUnavailableError);
    const shown = describeError(err);
    expect(shown).toMatch(/could not read/i);
    expect(shown).toMatch(/safe on chain/i);
    // The two failures this closes: the generic network excuse, and the raw
    // archive-authored detail (an event id, a field name, a byte length) that
    // the allowlist exists to keep off the screen.
    expect(shown).not.toMatch(/check your connection/i);
    expect(shown).not.toMatch(/\bbytes\b|b_tilde|event \d/i);
  });

  it("does not credit a deposit that was made TO someone else", async () => {
    // `deposit` carries [from, to] and the archive attributes it to both, so an
    // account that has funded other people's pockets appears in events that
    // credit nothing to it. Crediting on `from` would inflate every funder.
    const url = await archiveServing([depositEvent(FUNDER, 40_000_000n, 100)]);
    const out = await recoverOpenings(url, TOKEN, ACCOUNT, VK, {
      spendableCommitment: IDENTITY,
      receivingCommitment: IDENTITY,
    } as never);
    expect(out.receiving.value).toBe(0n);
  });
});
