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
import { accountKey, accountEntry, entryFor, entriesResult } from "../failure/_harness/ledger";

const chrome = installChrome();

const { WalletController, PrivatePocketError } = await import("../../src/core/controller");
const { NETWORKS } = await import("../../src/core/config");
const { clearSession } = await import("../../src/core/session");
const { TransactionBuilder, Operation, Asset, Keypair, Account, BASE_FEE } = await import(
  "@stellar/stellar-sdk/base"
);

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
  server.heal({
    fallback: rpcOk(
      entriesResult([entryFor(accountKey(address), accountEntry(address, 1000_0000000n))]),
    ),
  });
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
        /no longer pending confirmation/i,
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
      /no longer pending confirmation/i,
    );
    await expect(controller.confirmPayment(evil.hash().toString("hex"))).rejects.toThrow(
      /no longer pending confirmation/i,
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
      /no longer pending confirmation/i,
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
        /no longer pending confirmation/i.test((r.reason as Error).message),
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
      /no longer pending confirmation/i,
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
    expect(err?.message ?? "").not.toMatch(/no longer pending confirmation/i);
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
      /no longer pending confirmation/i,
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
    const envelopeB64 = (
      JSON.parse(sent!.body) as { params: { transaction: string } }
    ).params.transaction;
    const decoded = TransactionBuilder.fromXDR(envelopeB64, NETWORKS.testnet.passphrase);
    if (!("operations" in decoded)) throw new Error("a fee-bump reached the wire");

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

    await expect(controller.confirmPayment(handle)).rejects.toThrow(
      /different source account/i,
    );
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
