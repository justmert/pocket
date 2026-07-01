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
import { commit, IDENTITY } from "../../src/core/crypto/grumpkin";
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
