import { describe, it, expect } from "vitest";
import { hasExpired, pollToTerminal, submitAndConfirm, describeOutcome } from "./submit";
import type { rpc } from "@stellar/stellar-sdk";
import { Account, Asset, Keypair, Operation, TransactionBuilder } from "@stellar/stellar-sdk/base";
import "../../lib/polyfill";

const PASSPHRASE = "Test SDF Network ; September 2015";

function tx(maxTime: number) {
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

describe("expiry decidability (audit M1)", () => {
  it("reports a past maxTime as expired", () => {
    expect(hasExpired(tx(Math.floor(Date.now() / 1000) - 60))).toBe(true);
  });

  it("does not report a future maxTime as expired", () => {
    expect(hasExpired(tx(Math.floor(Date.now() / 1000) + 600))).toBe(false);
  });

  it("treats an unbounded transaction as never decidably expired", () => {
    // maxTime 0 means no upper bound, so "still in flight" and "expired" can
    // never be told apart. That is why buildPayment always sets timeBounds.
    expect(hasExpired(tx(0))).toBe(false);
  });
});

const fakeServer = (impl: Partial<rpc.Server>): rpc.Server => impl as rpc.Server;

describe("a flaky RPC must not be mistaken for a flaky ledger", () => {
  it("keeps polling after a poll that never reached the RPC", async () => {
    // Observed before this: one thrown getTransaction aborted the whole poll,
    // the caller reported an opaque failure for a transaction that had ALREADY
    // LANDED, and the user's obvious next move is to send it again.
    let n = 0;
    const outcome = await pollToTerminal(
      fakeServer({
        getTransaction: async () => {
          n++;
          if (n <= 2) throw new Error("socket hang up");
          return { status: "SUCCESS", ledger: 99, applicationOrder: 1 } as never;
        },
      }),
      "abc",
      { attempts: 5, sleepMs: 1 },
    );
    expect(outcome).toMatchObject({ kind: "succeeded", ledger: 99 });
  });

  it("ends in pending, never in success or failure, when no poll ever answers", async () => {
    const outcome = await pollToTerminal(
      fakeServer({
        getTransaction: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
      "abc",
      { attempts: 3, sleepMs: 1 },
    );
    // "We do not know" is the only honest answer, and it is the one that tells
    // the caller not to resend.
    //
    // `answered: false` is the load-bearing half. The caller decides from it
    // whether maxTime passing means "expired, safe to discard the staged
    // consequence"; an outage that never reached the RPC is not evidence the
    // transaction failed to land, and treating it as evidence deleted openings.
    expect(outcome).toEqual({ kind: "pending", hash: "abc", answered: false });
  });

  it("reports pending as ANSWERED when the ledger really said it does not have it", async () => {
    const outcome = await pollToTerminal(
      fakeServer({ getTransaction: async () => ({ status: "NOT_FOUND" }) as never }),
      "abc",
      { attempts: 2, sleepMs: 1 },
    );
    expect(outcome).toEqual({ kind: "pending", hash: "abc", answered: true });
  });

  it("counts a single reply among failures as having been answered", async () => {
    // One good poll is enough evidence. The rest failing does not un-see it.
    let n = 0;
    const outcome = await pollToTerminal(
      fakeServer({
        getTransaction: async () => {
          if (++n === 2) return { status: "NOT_FOUND" } as never;
          throw new Error("ECONNREFUSED");
        },
      }),
      "abc",
      { attempts: 3, sleepMs: 1 },
    );
    expect(outcome).toEqual({ kind: "pending", hash: "abc", answered: true });
  });

  it("polls by hash rather than concluding anything when the submit itself fails in transit", async () => {
    // A send whose response was lost may or may not have reached the network.
    // Reporting "it did not go" is the expensive guess: the hash is computable
    // locally, so ask the ledger instead.
    let polled = 0;
    const outcome = await submitAndConfirm(
      fakeServer({
        sendTransaction: async () => {
          throw new Error("network error");
        },
        getTransaction: async () => {
          polled++;
          return { status: "SUCCESS", ledger: 7, applicationOrder: 1 } as never;
        },
      }),
      tx(Math.floor(Date.now() / 1000) + 600),
      { attempts: 2, sleepMs: 1 },
    );
    expect(polled).toBeGreaterThan(0);
    expect(outcome).toMatchObject({ kind: "succeeded", ledger: 7 });
  });

  it("keeps the in-flight record when the outcome is still unknown", async () => {
    const recorded: string[] = [];
    const cleared: string[] = [];
    const outcome = await submitAndConfirm(
      fakeServer({
        sendTransaction: async () => ({ status: "PENDING" }) as never,
        getTransaction: async () => ({ status: "NOT_FOUND" }) as never,
      }),
      tx(Math.floor(Date.now() / 1000) + 600),
      {
        attempts: 2,
        sleepMs: 1,
        inFlight: {
          record: async (e) => void recorded.push(e.hash),
          clear: async (h) => void cleared.push(h),
          answered: async () => undefined,
        },
      },
    );
    expect(outcome.kind).toBe("pending");
    expect(recorded).toHaveLength(1);
    // Clearing it here would lose the only handle on a transaction that may
    // still land, and the wallet would offer to build a second one.
    expect(cleared).toHaveLength(0);
  });
});

describe("what a user is told about a submission", () => {
  it("tells them not to resend while the outcome is unknown", () => {
    const said = describeOutcome({ kind: "pending", hash: "deadbeef", answered: true });
    expect(said).toMatch(/do not resend/i);
    expect(said).toContain("deadbeef");
  });

  it("says a failed inclusion cost a fee", () => {
    const said = describeOutcome({ kind: "failed", hash: "h", ledger: 1, reason: "txFailed" });
    expect(said).toMatch(/fee was charged/i);
  });

  it("does not tell them to retry immediately after TRY_AGAIN_LATER", () => {
    // Core returns this when it cannot process the submission now, commonly
    // because another transaction from the same source is still in its queue.
    // Stellar's guidance is to wait, so "try again now" is wrong advice.
    const said = describeOutcome({ kind: "notAccepted", hash: "h" });
    expect(said).toMatch(/in a few seconds/i);
    expect(said).not.toMatch(/try again now/i);
  });

  it("covers every outcome kind, so none can fall through to a generic string", () => {
    const kinds = [
      { kind: "succeeded", hash: "h", ledger: 1, applicationOrder: 0 },
      { kind: "failed", hash: "h", ledger: 1, reason: "r" },
      { kind: "rejected", hash: "h", reason: "r" },
      { kind: "notAccepted", hash: "h" },
      { kind: "expired", hash: "h" },
      { kind: "pending", hash: "h", answered: true },
      { kind: "pending", hash: "h", answered: false },
    ] as const;
    const said = kinds.map((k) => describeOutcome(k));
    // Every kind is a sentence, and the six distinct kinds say six different
    // things: a fall-through would collapse two of them onto one string.
    for (const s of said) expect(s).toMatch(/^[A-Z].*\.$/);
    expect(new Set(said).size, "two outcome kinds share a sentence").toBe(6);
  });
});
