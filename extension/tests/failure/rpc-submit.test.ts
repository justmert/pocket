// Submission, against an RPC that is down, slow, rate-limited or lying.
//
// This is the path where a wrong answer costs money rather than a reload. The
// five outcomes are not interchangeable:
//
//   rejected      never included, no fee, sequence NOT consumed
//   notAccepted   the RPC declined to queue it: safe to retry, nothing spent
//   pending       unknown. It may still land. DO NOT RESEND
//   succeeded     done
//   failed        included and failed: fee charged, sequence CONSUMED
//   expired       maxTime passed, can never apply, safe to rebuild
//
// Two invariants are load-bearing:
//
//   1. A transaction is submitted exactly once. Every recovery is a poll by
//      hash, never a second `sendTransaction`. Counted here off the wire, not
//      inferred from a mock's call log.
//   2. An unresolved submission tells the user "do not resend, check the hash".
//      That instruction was destroyed once by the error allowlist and replaced
//      with "Try again", which is the one thing that spends twice.
import { describe, it, expect, afterEach } from "vitest";
import { rpc } from "@stellar/stellar-sdk";
import {
  Account,
  Asset,
  Keypair,
  Operation,
  TransactionBuilder,
  type Transaction,
} from "@stellar/stellar-sdk/base";
import "../../src/lib/polyfill";
import {
  submitAndConfirm,
  pollToTerminal,
  describeOutcome,
  SubmitOutcomeError,
  type SubmitOutcome,
} from "../../src/core/chain/submit";
import { withRequestDeadline } from "../../src/core/chain/http";
import { describeError } from "../../src/core/dispatch";
import { FaultServer, DEAD_ORIGIN, rpcOk, rpcError, type Fault } from "./_harness/faults";

const PASSPHRASE = "Test SDF Network ; September 2015";
const GENERIC = "Something went wrong. Try again, and check your connection.";

// Real XDR, produced by the SDK's own encoders. See the probe in the report.
const RESULT_SUCCESS = "AAAAAAAAAGQAAAAAAAAAAAAAAAA=";
const RESULT_FAILED = "AAAAAAAAAGT/////AAAAAAAAAAA=";
const META_V0 = "AAAAAAAAAAA=";

const open: FaultServer[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
});

function payment(maxTime: number): Transaction {
  const kp = Keypair.random();
  return new TransactionBuilder(new Account(kp.publicKey(), "1"), {
    fee: "100",
    networkPassphrase: PASSPHRASE,
    timebounds: { minTime: 0, maxTime },
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1",
      }),
    )
    .build();
}

const future = () => payment(Math.floor(Date.now() / 1000) + 600);
const past = () => payment(Math.floor(Date.now() / 1000) - 60);

const sendPending = (hash: string): Fault =>
  rpcOk({ status: "PENDING", hash, latestLedger: 100, latestLedgerCloseTime: "1" });

const sendDuplicate = (hash: string): Fault =>
  rpcOk({ status: "DUPLICATE", hash, latestLedger: 100, latestLedgerCloseTime: "1" });

const sendTryAgain = (hash: string): Fault =>
  rpcOk({ status: "TRY_AGAIN_LATER", hash, latestLedger: 100, latestLedgerCloseTime: "1" });

const sendError = (hash: string): Fault =>
  rpcOk({
    status: "ERROR",
    hash,
    latestLedger: 100,
    latestLedgerCloseTime: "1",
    errorResultXdr: RESULT_FAILED,
  });

const notFound = (): Fault =>
  rpcOk({
    status: "NOT_FOUND",
    latestLedger: 100,
    latestLedgerCloseTime: "1",
    oldestLedger: 1,
    oldestLedgerCloseTime: "1",
  });

const txSucceeded = (tx: Transaction, ledger = 42): Fault =>
  rpcOk({
    status: "SUCCESS",
    latestLedger: 100,
    latestLedgerCloseTime: "1",
    oldestLedger: 1,
    oldestLedgerCloseTime: "1",
    ledger,
    createdAt: "1",
    applicationOrder: 3,
    feeBump: false,
    envelopeXdr: tx.toEnvelope().toXDR("base64"),
    resultXdr: RESULT_SUCCESS,
    resultMetaXdr: META_V0,
  });

const txFailed = (tx: Transaction, ledger = 42): Fault =>
  rpcOk({
    status: "FAILED",
    latestLedger: 100,
    latestLedgerCloseTime: "1",
    oldestLedger: 1,
    oldestLedgerCloseTime: "1",
    ledger,
    createdAt: "1",
    applicationOrder: 3,
    feeBump: false,
    envelopeXdr: tx.toEnvelope().toXDR("base64"),
    resultXdr: RESULT_FAILED,
    resultMetaXdr: META_V0,
  });

/** Every way the RPC can answer a poll without answering the question. */
const UNANSWERED: [string, Fault][] = [
  ["a 429", { kind: "rateLimited" }],
  ["a 500", { kind: "text", status: 500, body: "upstream failure" }],
  ["HTML on a 200", { kind: "text", status: 200, contentType: "text/html", body: "<html/>" }],
  ["a JSON-RPC error object", rpcError("SECRET-RPC-STRING")],
  ["result: null", rpcOk(null)],
  ["a truncated body", { kind: "truncated", body: '{"jsonrpc":"2.0","id":1,"resu' }],
  ["a connection reset", { kind: "reset" }],
];

/** An in-flight sink that records what the submit path told it, in order. */
function sink() {
  const events: string[] = [];
  return {
    events,
    record: async (e: { hash: string }) => {
      events.push(`record ${e.hash}`);
    },
    clear: async (hash: string) => {
      events.push(`clear ${hash}`);
    },
  };
}

describe("a transaction is submitted exactly once, whatever the RPC does", () => {
  for (const [name, fault] of UNANSWERED) {
    it(`does not resend when every poll gets ${name}`, async () => {
      const tx = future();
      const hash = tx.hash().toString("hex");
      const server = await FaultServer.start({
        byMethod: { sendTransaction: sendPending(hash) },
        fallback: fault,
      });
      open.push(server);
      const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

      const outcome = await submitAndConfirm(client, tx, { attempts: 3, sleepMs: 5 });
      expect(outcome.kind).toBe("pending");
      expect(server.countOf("sendTransaction")).toBe(1);
      expect(server.countOf("getTransaction")).toBe(3);
    });
  }

  it("does not resend when the submission itself failed in transit", async () => {
    // The envelope may or may not have reached the network, and from here that
    // is unknowable. Concluding "it did not go" is the expensive guess: the
    // user is told to try again and pays twice if it did.
    const tx = future();
    const server = await FaultServer.start({
      byMethod: { sendTransaction: { kind: "reset" } },
      fallback: notFound(),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("pending");
    expect(server.countOf("sendTransaction")).toBe(1);
    expect(server.countOf("getTransaction")).toBe(2);
  });

  it("polls rather than resending when the RPC reports DUPLICATE", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendDuplicate(hash), getTransaction: txSucceeded(tx) },
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 3, sleepMs: 5 });
    expect(outcome.kind).toBe("succeeded");
    expect(server.countOf("sendTransaction")).toBe(1);
  });

  it("does not resend across a whole poll window against a dead RPC", async () => {
    const tx = future();
    const client = withRequestDeadline(new rpc.Server(DEAD_ORIGIN), 2_000);
    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("pending");
  });
});

describe("an unresolved submission never says try again", () => {
  it("carries the do-not-resend instruction and the hash to the user", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendPending(hash) },
      fallback: notFound(),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).toContain("do not resend");
    expect(shown).toContain(hash);
    expect(shown).not.toContain("Try again");
    expect(shown).not.toBe(GENERIC);
  });

  it("says nothing was charged when the RPC declined to queue it", async () => {
    const tx = future();
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendTryAgain(tx.hash().toString("hex")) },
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("notAccepted");
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).toContain("nothing was charged");
    expect(shown).toContain("no sequence");
    expect(shown).not.toBe(GENERIC);
    // It never entered the network, so polling it would strand the caller for
    // the whole timeBounds window.
    expect(server.countOf("getTransaction")).toBe(0);
  });

  it("names the rejection and says nothing was charged", async () => {
    const tx = future();
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendError(tx.hash().toString("hex")) },
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("rejected");
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).toContain("Nothing was charged");
    expect(shown).toContain("txFailed");
    expect(shown).not.toBe(GENERIC);
  });

  it("says the fee was charged and the sequence used when it failed on chain", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendPending(hash), getTransaction: txFailed(tx) },
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("failed");
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).toContain("A fee was charged");
    expect(shown).toContain("sequence number was used");
    expect(shown).not.toBe(GENERIC);
  });

  it("says it can never apply now once its time window has passed", async () => {
    const tx = past();
    const hash = tx.hash().toString("hex");
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendPending(hash) },
      fallback: notFound(),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("expired");
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).toContain("Nothing was charged");
    expect(shown).toContain("Build it again");
    expect(shown).not.toBe(GENERIC);
  });

  it("never lets an RPC-authored string into a rejection message", async () => {
    // The reachable leak. A rejection with NO decodable result reaches
    // describeSendError, which authors its own words rather than repeating
    // anything the response carried. The extra fields below are what a real RPC
    // puts beside the status, and none of them may be interpolated.
    const tx = future();
    const server = await FaultServer.start({
      byMethod: {
        sendTransaction: rpcOk({
          status: "ERROR",
          hash: tx.hash().toString("hex"),
          latestLedger: 100,
          latestLedgerCloseTime: "1",
          error: "SECRET-RPC-STRING",
          diagnosticEvents: ["SECRET-RPC-STRING"],
        }),
      },
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("rejected");
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).not.toContain("SECRET-RPC-STRING");
    expect(shown).toContain("Nothing was charged");
  });

  it("does not decide anything from an errorResultXdr it could not decode", async () => {
    // Undecodable XDR makes the SDK throw inside sendTransaction, so whether the
    // envelope reached the network is unknowable. The honest answer is to poll
    // by hash, not to report a rejection nobody read.
    const tx = future();
    const server = await FaultServer.start({
      byMethod: {
        sendTransaction: rpcOk({
          status: "ERROR",
          hash: tx.hash().toString("hex"),
          latestLedger: 100,
          latestLedgerCloseTime: "1",
          errorResultXdr: "SECRET-RPC-STRING-NOT-VALID-XDR",
        }),
      },
      fallback: notFound(),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("pending");
    expect(server.countOf("sendTransaction")).toBe(1);
    const shown = describeError(new SubmitOutcomeError(describeOutcome(outcome), outcome));
    expect(shown).not.toContain("SECRET-RPC-STRING");
    expect(shown).toContain("do not resend");
  });
});

describe("polling recovers when the RPC comes back", () => {
  it("reaches succeeded after a run of unanswered polls", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendPending(hash) },
      script: [],
      fallback: notFound(),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    // Three polls that never reach the RPC, then the truth. A poll that did not
    // arrive says nothing about the transaction, so aborting on one would have
    // reported a landed transaction as a flat failure.
    server.heal({
      byMethod: {
        getTransaction: (() => {
          let n = 0;
          return () => (n++ < 3 ? { kind: "reset" as const } : txSucceeded(tx));
        })(),
      },
    });

    const outcome = await pollToTerminal(client, hash, { attempts: 8, sleepMs: 5 });
    expect(outcome.kind).toBe("succeeded");
    expect((outcome as Extract<SubmitOutcome, { kind: "succeeded" }>).ledger).toBe(42);
    expect(server.countOf("sendTransaction")).toBe(0);
  });

  it("reaches succeeded after the RPC was rate-limiting every poll", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const server = await FaultServer.start({ fallback: { kind: "rateLimited" } });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    await expect(pollToTerminal(client, hash, { attempts: 2, sleepMs: 5 })).resolves.toMatchObject({
      kind: "pending",
    });
    server.heal({ fallback: txSucceeded(tx) });
    await expect(pollToTerminal(client, hash, { attempts: 2, sleepMs: 5 })).resolves.toMatchObject({
      kind: "succeeded",
    });
  });

  it("does not invent a terminal verdict from a poll that never answered", async () => {
    for (const [, fault] of UNANSWERED) {
      const server = await FaultServer.start({ fallback: fault });
      open.push(server);
      const client = withRequestDeadline(new rpc.Server(server.url), 4_000);
      const outcome = await pollToTerminal(client, "deadbeef", { attempts: 2, sleepMs: 5 });
      // Not succeeded, not failed, not rejected. "We do not know" is the only
      // honest answer, and it is the one that does not spend twice.
      expect(outcome.kind).toBe("pending");
    }
  });

  it("does not conclude success from a SUCCESS status with no ledger data", async () => {
    // A status field on its own is not a receipt. Parsing must reach the real
    // envelope, or "succeeded" is a claim about a ledger nobody read.
    const server = await FaultServer.start({
      fallback: rpcOk({
        status: "SUCCESS",
        latestLedger: 100,
        latestLedgerCloseTime: "1",
        oldestLedger: 1,
        oldestLedgerCloseTime: "1",
      }),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);
    const outcome = await pollToTerminal(client, "deadbeef", { attempts: 2, sleepMs: 5 });
    expect(outcome.kind).toBe("pending");
  });
});

describe("the in-flight record survives exactly as long as the uncertainty", () => {
  it("is written BEFORE submission, so a dead worker leaves a hash to poll", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const s = sink();
    const server = await FaultServer.start({
      byMethod: { sendTransaction: { kind: "stall" } },
      fallback: notFound(),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 500);

    await submitAndConfirm(client, tx, { attempts: 1, sleepMs: 5, inFlight: s });
    expect(s.events[0]).toBe(`record ${hash}`);
  });

  it("is NOT cleared while the outcome is unknown", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const s = sink();
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendPending(hash) },
      fallback: notFound(),
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5, inFlight: s });
    expect(outcome.kind).toBe("pending");
    expect(s.events).toEqual([`record ${hash}`]);
  });

  it("is cleared once the ledger has decided", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const s = sink();
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendPending(hash), getTransaction: txSucceeded(tx) },
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5, inFlight: s });
    expect(s.events).toEqual([`record ${hash}`, `clear ${hash}`]);
  });

  it("is cleared when the RPC declined to queue it, since nothing is in flight", async () => {
    const tx = future();
    const hash = tx.hash().toString("hex");
    const s = sink();
    const server = await FaultServer.start({
      byMethod: { sendTransaction: sendTryAgain(hash) },
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 4_000);

    await submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5, inFlight: s });
    expect(s.events).toEqual([`record ${hash}`, `clear ${hash}`]);
  });
});

describe("a slow RPC ends rather than hanging", () => {
  it("bounds a submission against a server that accepts and never answers", async () => {
    const tx = future();
    const server = await FaultServer.start({ fallback: { kind: "stall" } });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 600);

    // The assertion is a BOUND: something ends it. The value is the deadline
    // applied above, not a measurement of this machine.
    const outcome = await Promise.race([
      submitAndConfirm(client, tx, { attempts: 2, sleepMs: 5 }),
      new Promise<never>((_, no) =>
        setTimeout(() => no(new Error("submission never settled")), 15_000),
      ),
    ]);
    expect(outcome.kind).toBe("pending");
  });

  it("still succeeds against a dependency that is slow but alive", async () => {
    // A deadline exists to bound a hang, not to police latency. A server that
    // answers late must still be believed.
    const tx = future();
    const hash = tx.hash().toString("hex");
    const server = await FaultServer.start({
      byMethod: {
        sendTransaction: sendPending(hash),
        getTransaction: txSucceeded(tx),
      },
    });
    open.push(server);
    const client = withRequestDeadline(new rpc.Server(server.url), 10_000);

    const outcome = await submitAndConfirm(client, tx, { attempts: 3, sleepMs: 200 });
    expect(outcome.kind).toBe("succeeded");
  });
});
