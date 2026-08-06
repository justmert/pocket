// What gets signed, and on whose authority.
//
// The popup is a UI, not a source of truth about what the worker signs. It never
// hands over XDR: it gets an opaque HANDLE for an envelope the worker built and
// retained, and confirm takes only that handle. Without it the worker would sign
// any bytes handed to it, including an accountMerge or a setOptions that replaces
// the signers, and the approval screen would be decoration.
//
// So the authorisation question here is not "who is the user" but "is this the
// transaction the user actually reviewed". Four ways it can stop being that:
// forged, replayed, expired, or belonging to a different operation.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "../../src/lib/polyfill";
import { installChrome } from "./_harness/chrome";
import { FaultServer, rpcOk } from "../failure/_harness/faults";
import { entriesResult, entriesForRequest } from "../failure/_harness/ledger";

const chrome = installChrome();

const { WalletController, PrivatePocketError } = await import("../../src/core/controller");
const { describeError } = await import("../../src/core/dispatch");
const { NETWORKS } = await import("../../src/core/config");
const { clearSession } = await import("../../src/core/session");
const { TransactionBuilder, Operation, Asset, Keypair, Account, BASE_FEE, FeeBumpTransaction } =
  await import("@stellar/stellar-sdk/base");

const PASSWORD = "correct horse battery staple";
const RECIPIENT = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
const REAL_RPC = NETWORKS.testnet.rpcUrl;
const open: FaultServer[] = [];

beforeEach(() => {
  chrome.local.clear();
  chrome.session.clear();
  clearSession();
});

afterEach(async () => {
  vi.useRealTimers();
  NETWORKS.testnet.rpcUrl = REAL_RPC;
  await Promise.all(open.splice(0).map((s) => s.close()));
  clearSession();
});

/** An unlocked wallet whose ledger reads succeed, so build() can get that far. */
async function funded() {
  const server = await FaultServer.start({ fallback: rpcOk(entriesResult([])) });
  open.push(server);
  NETWORKS.testnet.rpcUrl = server.url;
  const c = new WalletController();
  await c.init();
  const { address } = await c.create(PASSWORD);
  // Every account asked about, not just the signer: the send path reads the
  // DESTINATION too, because a payment to an account that does not exist can
  // never succeed, and a one-address answerer is rejected as a key mismatch.
  server.heal({ fallback: (req) => rpcOk(entriesForRequest(req.body, 1000_0000000n)) });
  return { controller: c, server, address };
}

describe("a handle the worker did not issue is refused", () => {
  const forged = [
    ["an empty string", ""],
    ["a plausible hex hash", "a".repeat(64)],
    ["a different transaction's hash", "deadbeef".repeat(8)],
    ["an object pretending to be a handle", "[object Object]"],
    ["a prototype key", "__proto__"],
    ["a very long string", "f".repeat(4096)],
  ] as const;

  for (const [name, handle] of forged) {
    it(`refuses ${name} at confirmPayment`, async () => {
      const { controller } = await funded();
      await expect(controller.confirmPayment(handle)).rejects.toThrow(
        /no longer pending confirmation|still waiting on an earlier transaction/i,
      );
    });

    it(`refuses ${name} at confirmPrivateOp`, async () => {
      const { controller } = await funded();
      await expect(controller.confirmPrivateOp(handle)).rejects.toBeInstanceOf(PrivatePocketError);
    });
  }

  it("refuses raw XDR, so the popup cannot choose the bytes", async () => {
    // The whole point of the handle. A caller that could pass an envelope could
    // pass an accountMerge and the approval screen would never have seen it.
    const { controller, address } = await funded();
    const evil = new TransactionBuilder(new Account(address, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORKS.testnet.passphrase,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 600 },
    })
      .addOperation(Operation.accountMerge({ destination: RECIPIENT }))
      .build();

    await expect(controller.confirmPayment(evil.toXDR())).rejects.toThrow(
      /no longer pending confirmation|still waiting on an earlier transaction/i,
    );
    await expect(controller.confirmPayment(evil.hash().toString("hex"))).rejects.toThrow(
      /no longer pending confirmation|still waiting on an earlier transaction/i,
    );
  });
});

describe("a handle is single use", () => {
  it("refuses the same payment handle a second time", async () => {
    const { controller, server } = await funded();
    const built = await controller.buildPayment({
      to: RECIPIENT,
      amount: "1",
      assetId: "native",
    });

    // The first confirm consumes the handle. It fails at submission here,
    // because the fault server answers no transaction, and that is fine: the
    // question is whether the handle survives to be used again.
    server.heal({ fallback: { kind: "reset" } });
    await controller.confirmPayment(built.xdr).catch(() => undefined);

    await expect(controller.confirmPayment(built.xdr)).rejects.toThrow(
      /no longer pending confirmation|still waiting on an earlier transaction/i,
    );
  });

  it("does not let two confirms of one build both reach signing", async () => {
    const { controller, server } = await funded();
    const built = await controller.buildPayment({
      to: RECIPIENT,
      amount: "1",
      assetId: "native",
    });
    server.heal({ fallback: { kind: "reset" } });

    const results = await Promise.allSettled([
      controller.confirmPayment(built.xdr),
      controller.confirmPayment(built.xdr),
    ]);
    const refusedForHandle = results.filter(
      (r) =>
        r.status === "rejected" &&
        /no longer pending confirmation|still waiting on an earlier transaction/i.test(
          (r.reason as Error).message,
        ),
    );
    expect(refusedForHandle).toHaveLength(1);
  });
});

describe("a handle expires", () => {
  it("is refused once its ten-minute window has passed", async () => {
    const { controller } = await funded();
    const built = await controller.buildPayment({
      to: RECIPIENT,
      amount: "1",
      assetId: "native",
    });

    // A popup left open overnight must not be able to sign this morning's
    // envelope against tonight's sequence number.
    //
    // Only Date is faked. Faking timers wholesale freezes the request deadline
    // and the socket with them, so the test would hang rather than travel.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 11 * 60_000);
    await expect(controller.confirmPayment(built.xdr)).rejects.toThrow(
      /no longer pending confirmation|still waiting on an earlier transaction/i,
    );
  });

  it("is still valid comfortably inside the window", async () => {
    const { controller, server } = await funded();
    const built = await controller.buildPayment({
      to: RECIPIENT,
      amount: "1",
      assetId: "native",
    });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    server.heal({ fallback: { kind: "reset" } });

    // It must fail on the NETWORK, not on the handle.
    const err = await controller.confirmPayment(built.xdr).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message ?? "").not.toMatch(
      /no longer pending confirmation|still waiting on an earlier transaction/i,
    );
  });
});

describe("a handle belongs to one operation and cannot cross to another", () => {
  it("refuses a payment handle at confirmPrivateOp", async () => {
    const { controller } = await funded();
    const built = await controller.buildPayment({
      to: RECIPIENT,
      amount: "1",
      assetId: "native",
    });
    await expect(controller.confirmPrivateOp(built.xdr)).rejects.toBeInstanceOf(PrivatePocketError);
  });

  it("does not destroy the payment when a private confirm is misrouted to it", async () => {
    // The check has to happen BEFORE the handle is consumed. Refusing after
    // deleting the entry would throw away work the user waited on, and for a
    // private operation that means a proof they have to sit through again.
    const { controller, server } = await funded();
    const built = await controller.buildPayment({
      to: RECIPIENT,
      amount: "1",
      assetId: "native",
    });
    await controller.confirmPrivateOp(built.xdr).catch(() => undefined);

    server.heal({ fallback: { kind: "reset" } });
    const err = await controller.confirmPayment(built.xdr).then(
      () => null,
      (e: Error) => e,
    );
    expect(err?.message ?? "", "the misroute consumed the payment handle").not.toMatch(
      /no longer pending confirmation|still waiting on an earlier transaction/i,
    );
  });
});

describe("the bytes signed are the bytes summarised", () => {
  it("submits exactly the payment the summary described", async () => {
    const { controller, server, address } = await funded();
    const built = await controller.buildPayment({
      to: RECIPIENT,
      amount: "12.5",
      assetId: "native",
      memo: "invoice-42",
    });

    expect(built.summary).toMatchObject({
      decoded: true,
      to: RECIPIENT,
      amount: "12.5000000",
      assetCode: "XLM",
      memo: "invoice-42",
    });

    // Capture what actually goes on the wire.
    server.heal({
      byMethod: {
        sendTransaction: rpcOk({
          status: "TRY_AGAIN_LATER",
          hash: built.xdr,
          latestLedger: 100,
          latestLedgerCloseTime: "1",
        }),
      },
    });
    await controller.confirmPayment(built.xdr).catch(() => undefined);

    const sent = server.requests.find((r) => r.method === "sendTransaction");
    expect(sent, "nothing was submitted").toBeTruthy();
    const envelopeB64 = (JSON.parse(sent!.body) as { params: { transaction: string } }).params
      .transaction;
    const decoded = TransactionBuilder.fromXDR(envelopeB64, NETWORKS.testnet.passphrase);
    // `instanceof`, not `"operations" in`: the `in` check narrows nothing for
    // TypeScript across a class union, so every read below was unchecked.
    if (decoded instanceof FeeBumpTransaction) throw new Error("a fee-bump reached the wire");

    expect(decoded.source).toBe(address);
    expect(decoded.operations).toHaveLength(1);
    const op = decoded.operations[0] as { type: string; destination: string; amount: string };
    expect(op.type).toBe("payment");
    expect(op.destination).toBe(built.summary.to);
    expect(op.amount).toBe(built.summary.amount);
    expect((decoded.memo as { value: unknown }).value?.toString()).toBe("invoice-42");
    expect(decoded.fee).toBe(built.summary.fee);
    // Signed, and by this wallet.
    expect(decoded.signatures.length).toBeGreaterThan(0);
  });

  it("refuses to sign an envelope whose source is not this wallet", async () => {
    // Defence in depth on top of the handle: the retained entry is re-decoded
    // and re-checked at confirm, so a corrupted store cannot redirect a signature.
    const { controller } = await funded();
    const stranger = Keypair.random();
    const foreign = new TransactionBuilder(new Account(stranger.publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORKS.testnet.passphrase,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 600 },
    })
      .addOperation(
        Operation.payment({ destination: RECIPIENT, asset: Asset.native(), amount: "1" }),
      )
      .build();

    // Plant it as though the worker had built it.
    const pending = (controller as unknown as { pending: Map<string, unknown> }).pending;
    const handle = foreign.hash().toString("hex");
    pending.set(handle, { xdr: foreign.toXDR(), at: Date.now() });

    await expect(controller.confirmPayment(handle)).rejects.toThrow(/different source account/i);
  });

  it("refuses to sign a retained envelope that is not a single payment", async () => {
    const { controller, address } = await funded();
    const notAPayment = new TransactionBuilder(new Account(address, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORKS.testnet.passphrase,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 600 },
    })
      .addOperation(Operation.accountMerge({ destination: RECIPIENT }))
      .build();

    const pending = (controller as unknown as { pending: Map<string, unknown> }).pending;
    const handle = notAPayment.hash().toString("hex");
    pending.set(handle, { xdr: notAPayment.toXDR(), at: Date.now() });

    await expect(controller.confirmPayment(handle)).rejects.toThrow(
      /not the single payment that was reviewed/i,
    );
  });
});

describe("the three refusals a mutation pass found untested", () => {
  // Each of these exists because a mutation turned NOTHING red. They are the
  // answer to "was the mutation pass worth running", and none of them would
  // have been written from reading the suite.

  it("refuses a handle marked private, even though confirmPayment issued nothing else", async () => {
    // Mutation E3b relaxed `if (!entry || entry.private)` to `if (!entry)` and
    // no test noticed, because building a real private handle needs a proof and
    // nothing here can produce one. So the entry is planted in the shape the
    // prover would have left it. That is reaching past the front door, and it
    // is the only way to reach this branch at all; the branch matters because a
    // private envelope signed through the public path skips the staged-openings
    // write, and an opening that is never written is funds that are visible on
    // chain and permanently unspendable.
    const { controller, address } = await funded();
    const tx = new TransactionBuilder(new Account(address, "1"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORKS.testnet.passphrase,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 600 },
    })
      .addOperation(
        Operation.payment({ destination: RECIPIENT, asset: Asset.native(), amount: "1" }),
      )
      .build();

    const pending = (controller as unknown as { pending: Map<string, unknown> }).pending;
    const handle = tx.hash().toString("hex");
    pending.set(handle, {
      xdr: tx.toXDR(),
      at: Date.now(),
      private: { resolve: null, follow: false },
    });

    await expect(controller.confirmPayment(handle)).rejects.toThrow(
      /no longer pending confirmation|still waiting on an earlier transaction/i,
    );
    // And it survived, because the check happens before the handle is consumed.
    // Refusing after deleting would destroy a proof the user waited on.
    expect(pending.has(handle), "the misrouted private handle was consumed").toBe(true);
  });

  it("refuses raw XDR whose source and shape would otherwise pass every later check", async () => {
    // The existing raw-XDR test builds an accountMerge, which the operation
    // check catches on its own, so it stayed green when the handle lookup was
    // made to fall back to the caller's bytes. This one hands over a perfectly
    // well-formed payment from this very wallet: source check passes, operation
    // check passes, and the ONLY thing standing between it and a signature is
    // that the worker never built it.
    const { controller, address } = await funded();
    const theirs = new TransactionBuilder(new Account(address, "9999"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORKS.testnet.passphrase,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 600 },
    })
      .addOperation(
        Operation.payment({ destination: RECIPIENT, asset: Asset.native(), amount: "1000" }),
      )
      .build();

    await expect(controller.confirmPayment(theirs.toXDR())).rejects.toThrow(
      /no longer pending confirmation|still waiting on an earlier transaction/i,
    );
  });

  it("tells the user something generic when it refuses for an internal reason", async () => {
    // Mutation G1b made `describeError` pass every message through verbatim and
    // nothing in this slice noticed. The refusals in `confirmPayment` are plain
    // `Error`s carrying sentences written for a developer reading a stack, not
    // for a person holding a phone: "refusing to sign a transaction from a
    // different source account" tells a user nothing they can act on, and the
    // allowlist exists precisely so unnamed errors cannot reach a screen.
    const { controller } = await funded();
    const stranger = Keypair.random();
    const foreign = new TransactionBuilder(new Account(stranger.publicKey(), "1"), {
      fee: BASE_FEE,
      networkPassphrase: NETWORKS.testnet.passphrase,
      timebounds: { minTime: 0, maxTime: Math.floor(Date.now() / 1000) + 600 },
    })
      .addOperation(
        Operation.payment({ destination: RECIPIENT, asset: Asset.native(), amount: "1" }),
      )
      .build();

    const pending = (controller as unknown as { pending: Map<string, unknown> }).pending;
    const handle = foreign.hash().toString("hex");
    pending.set(handle, { xdr: foreign.toXDR(), at: Date.now() });

    const shown = await controller.confirmPayment(handle).then(
      () => "signed it",
      (e) => describeError(e),
    );
    expect(shown).toBe("Something went wrong. Try again.");
    expect(shown).not.toMatch(/source account|refusing to sign/i);
  });
});
