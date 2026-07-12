// R10 and R15: a dependency that is not merely down but LYING, and a dependency
// that is down being told apart from a wallet that is broken.
//
// The question this file exists to answer, per response field: what does the
// wallet trust remotely, and what does it verify independently? Every test name
// below is the answer for one field, and every assertion is about what a USER
// SEES. "The code did not throw" is not an outcome; a number on a screen is.
//
// The lie is injected at the NETWORK boundary and nowhere else. Nothing here
// mocks wallet code and nothing reaches into `core/`. MV3 puts every chain call
// in the service worker, so `tests/support/stub.ts` plus
// PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS -- set by the config -- is the
// only mechanism that can make a lie reach the code under test. A stub that saw
// page traffic only would inject nothing and every test here would pass while
// proving nothing, which is why `speak()` counts what it answered and several
// tests assert that count.
//
// Two verdicts are recorded, and they are not the same thing:
//
//   VERIFIED  the wallet checks the field against something it already holds and
//             refuses when the check fails. The test asserts the refusal AND
//             that no figure is rendered.
//   TRUSTED   the wallet has no independent handle on the field and renders or
//             acts on whatever arrives. The test asserts precisely what a
//             malicious provider achieves, so the consequence is on record
//             rather than assumed. These are findings, not accidental passes.
import { expect, test, askWorker } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { intercept, offline, RPC_HOST } from "../support/stub";
import {
  accountEntry,
  accountKey,
  entriesResult,
  entryFor,
  fundedAccountResult,
} from "../failure/_harness/ledger";
import type { BrowserContext, Locator, Page, Route } from "@playwright/test";
import {
  Keypair,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk/base";
import type { Wallet } from "../support/wallet";

const PASSWORD = "a-strong-test-password";
const TESTNET = "Test SDF Network ; September 2015";
const MAINNET = "Public Global Stellar Network ; September 2015";
const STROOPS = 10_000_000n;

/** A real, well-formed G-address that is not the wallet's. */
const STRANGER = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7";
/** Exists on testnet, so a payment to it is included rather than failing. */
const RECIPIENT = "GBHEDQ5XUXCWK5I32NVDSGAL6BIX2X7DUWQYC2MLXV27N44JLDQFGT73";

// Built with the SDK's own encoders rather than pasted as blobs, so an XDR
// change breaks this loudly instead of producing a body the real parser quietly
// rejects. Byte-identical to the constants `tests/failure/rpc-submit.test.ts`
// validated against that parser.
const RESULT_SUCCESS = new xdr.TransactionResult({
  feeCharged: xdr.Int64.fromString("100"),
  result: xdr.TransactionResultResult.txSuccess([]),
  ext: new xdr.TransactionResultExt(0),
}).toXDR("base64");
const RESULT_FAILED = new xdr.TransactionResult({
  feeCharged: xdr.Int64.fromString("100"),
  result: xdr.TransactionResultResult.txFailed([]),
  ext: new xdr.TransactionResultExt(0),
}).toXDR("base64");
const RESULT_BAD_SEQ = new xdr.TransactionResult({
  feeCharged: xdr.Int64.fromString("0"),
  result: xdr.TransactionResultResult.txBadSeq(),
  ext: new xdr.TransactionResultExt(0),
}).toXDR("base64");
const META_V0 = "AAAAAAAAAAA=";
const EMPTY_SOROBAN_DATA = new SorobanDataBuilder().build().toXDR("base64");

// ---------------------------------------------------------------- the mouthpiece

interface JsonRpcCall {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * One way the RPC can answer a single call.
 *
 * `"forward"` is load-bearing rather than a convenience: almost every test here
 * lies about ONE field and needs every other call answered truthfully, because a
 * wallet that fails for an unrelated reason proves nothing about the field under
 * test.
 */
type Answer =
  | { result: unknown }
  | { error: { code: number; message: string } }
  /** Anything that is not a JSON-RPC envelope at all: HTML, truncation, a 500. */
  | { raw: { status?: number; contentType?: string; body: string } }
  | "forward";

type Mouth = (call: JsonRpcCall, route: Route) => Answer | Promise<Answer>;

interface Heard {
  /** Every JSON-RPC method this stub answered, in order. */
  methods: string[];
  /** How many of those arrived from the service worker rather than a page. */
  fromServiceWorker: number;
  countOf(method: string): number;
}

/**
 * Put words in the RPC's mouth, per JSON-RPC method.
 *
 * The returned record is asserted on in several tests, and that is not
 * bookkeeping: a lie nobody heard is not a lie, and an injection test whose stub
 * was never reached passes for the wrong reason. `fromServiceWorker` is the half
 * that proves it, because the popup makes requests of its own and "the stub was
 * hit" would be satisfied by those alone.
 */
async function speak(context: BrowserContext, answer: Mouth): Promise<Heard> {
  const heard: Heard = {
    methods: [],
    fromServiceWorker: 0,
    countOf(method: string) {
      return this.methods.filter((m) => m === method).length;
    },
  };
  await intercept(context, RPC_HOST, async (route) => {
    let call: JsonRpcCall | null = null;
    try {
      call = route.request().postDataJSON() as JsonRpcCall;
    } catch {
      call = null;
    }
    if (!call || typeof call.method !== "string") {
      await route.continue();
      return;
    }
    heard.methods.push(call.method);
    if (route.request().serviceWorker()) heard.fromServiceWorker++;

    const said = await answer(call, route);
    if (said === "forward") {
      await route.continue();
      return;
    }
    if ("raw" in said) {
      await route.fulfill({
        status: said.raw.status ?? 200,
        contentType: said.raw.contentType ?? "application/json",
        body: said.raw.body,
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ jsonrpc: "2.0", id: call.id, ...said }),
    });
  });
  return heard;
}

/** Answer one method and tell the truth about everything else. */
function only(method: string, answer: Mouth): Mouth {
  return (call, route) => (call.method === method ? answer(call, route) : "forward");
}

/** Which ledger keys a `getLedgerEntries` call is asking about. */
function askedKeys(call: JsonRpcCall): string[] {
  const keys = (call.params as { keys?: unknown } | undefined)?.keys;
  return Array.isArray(keys) ? (keys as string[]) : [];
}

/** True when this `getLedgerEntries` call is the account-balance question. */
function asksAccount(call: JsonRpcCall, address: string): boolean {
  return askedKeys(call).includes(accountKey(address).toXDR("base64"));
}

/** The envelope a `sendTransaction` call is carrying, decoded. */
function envelopeOf(call: JsonRpcCall, passphrase = TESTNET): Transaction {
  const raw = (call.params as { transaction?: string } | undefined)?.transaction;
  if (typeof raw !== "string") throw new Error("sendTransaction carried no transaction");
  const tx = TransactionBuilder.fromXDR(raw, passphrase);
  if (!(tx instanceof Transaction)) throw new Error("expected a plain transaction envelope");
  return tx;
}

const pendingSend = (hash: string): Answer => ({
  result: { status: "PENDING", hash, latestLedger: 100, latestLedgerCloseTime: "1" },
});

const included = (tx: Transaction, ledgerSeq: number, ok: boolean): Answer => ({
  result: {
    status: ok ? "SUCCESS" : "FAILED",
    latestLedger: ledgerSeq + 1,
    latestLedgerCloseTime: "1",
    oldestLedger: 1,
    oldestLedgerCloseTime: "1",
    ledger: ledgerSeq,
    createdAt: "1",
    applicationOrder: 1,
    feeBump: false,
    envelopeXdr: tx.toEnvelope().toXDR("base64"),
    resultXdr: ok ? RESULT_SUCCESS : RESULT_FAILED,
    resultMetaXdr: META_V0,
  },
});

const neverIncluded = (): Answer => ({
  result: {
    status: "NOT_FOUND",
    latestLedger: 100,
    latestLedgerCloseTime: "1",
    oldestLedger: 1,
    oldestLedgerCloseTime: "1",
  },
});

/** A successful simulation carrying `retval`, or carrying nothing at all. */
function simulated(retval?: string): Answer {
  return {
    result: {
      latestLedger: 100,
      minResourceFee: "1000",
      transactionData: EMPTY_SOROBAN_DATA,
      events: [],
      ...(retval ? { results: [{ xdr: retval, auth: [] }] } : {}),
    },
  };
}

/**
 * A `confidential_balance` return value, invented whole.
 *
 * The points are the IDENTITY, 64 zero bytes, which is both on the curve and
 * exactly what a freshly registered account's commitments really are. An
 * off-curve blob would be refused by `decodePoint` and the test would then be
 * about point validation rather than about what the wallet does with a
 * well-formed account it has no openings for.
 */
function inventedConfidentialAccount(auditorId = 7): string {
  const identity = Buffer.alloc(64);
  const field = (name: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
  // Keys sorted, as the host renders a `#[contracttype]` struct.
  return xdr.ScVal.scvMap([
    field("auditor_id", xdr.ScVal.scvU32(auditorId)),
    field("receiving_commitment", xdr.ScVal.scvBytes(identity)),
    field("spendable_commitment", xdr.ScVal.scvBytes(identity)),
    field("spending_public_key", xdr.ScVal.scvBytes(identity)),
    field("viewing_public_key", xdr.ScVal.scvBytes(identity)),
  ]).toXDR("base64");
}

/**
 * Whatever the wallet says when it will not say more.
 *
 * Two spellings, and which one appears is not the wallet's choice: the SDK's
 * JSON-RPC client THROWS THE `error` OBJECT ITSELF rather than an Error, so
 * `describeError`'s `instanceof Error` branch is skipped and the shorter
 * sentence is produced. Both are the generic refusal and neither carries a word
 * the provider wrote, which is the property under test.
 */
function refusal(page: Page): Locator {
  return page.getByText(/Something went wrong/).first();
}

/** A funded wallet, plus the truth to compare the lies against. */
async function fundedWallet(wallet: Wallet): Promise<{ address: string; xlm: number }> {
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  return { address, xlm: await ledger.fund(address) };
}

// ------------------------------------------------------- what a balance trusts

test.describe("the public balance", () => {
  test("TRUSTED: an inflated figure is rendered verbatim, and the send ceiling moves with it", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const { address } = await fundedWallet(wallet);

    // A thousandfold inflation, answered with a byte-perfect key echo and the
    // right account id inside the entry, so every check the wallet does make
    // passes. There is nothing left to catch it.
    const lie = 9_999_999n * STROOPS;
    const heard = await speak(
      harness.context,
      only("getLedgerEntries", (call) =>
        asksAccount(call, address) ? { result: fundedAccountResult(address, lie) } : "forward",
      ),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // The base reserve for an account with no subentries is 1 XLM, so the hero
    // is the lie less one.
    await expect(wallet.money().first()).toHaveText(/^9999998\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });
    expect(heard.fromServiceWorker).toBeGreaterThan(0);

    // And the consequence, which is the part that costs money: the spend guard
    // in the worker is computed from this same trusted figure, so an amount the
    // account cannot cover walks through to the review screen, where it would be
    // signed and submitted and fail on chain having charged its fee.
    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "50000" });
    const sheet = wallet.page.getByRole("dialog", { name: "Send" });
    await expect(sheet.getByText("Sending", { exact: true })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(sheet.getByText(/^50000\.0000000\s*XLM$/)).toBeVisible();
    await expect(sheet.getByRole("button", { name: "Confirm" })).toBeEnabled();
  });

  test("TRUSTED: a deflated figure refuses a payment the account can afford", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const { address, xlm } = await fundedWallet(wallet);
    expect(xlm).toBeGreaterThan(1000);

    await speak(
      harness.context,
      only("getLedgerEntries", (call) =>
        asksAccount(call, address)
          ? { result: fundedAccountResult(address, 15n * STROOPS) }
          : "forward",
      ),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await expect(wallet.money().first()).toHaveText(/^14\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });

    // The other direction of the same trust, and the cheaper half to reach: the
    // account holds ten thousand XLM and the wallet will not send a hundred,
    // giving a balance that is not the ledger's as its reason.
    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "100" });
    const sheet = wallet.page.getByRole("dialog", { name: "Send" });
    await expect(sheet.getByText(/That is more than you can send/)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(sheet.getByText(/Your balance is 15\.0000000 XLM/)).toBeVisible();
  });

  test("VERIFIED: an entry that belongs to a stranger renders no figure at all", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const { address } = await fundedWallet(wallet);

    // The key echo is correct -- it is the key the wallet asked about -- and the
    // AccountEntry inside is somebody else's. Only the second, belt-and-braces
    // check in `readNative` can see this.
    await speak(
      harness.context,
      only("getLedgerEntries", (call) =>
        asksAccount(call, address)
          ? {
              result: entriesResult([
                entryFor(accountKey(address), accountEntry(STRANGER, 12345n * STROOPS)),
              ]),
            }
          : "forward",
      ),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await expect(refusal(wallet.page)).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money()).toHaveCount(0);
    // The stranger's figure must not appear anywhere, in any rendering.
    await expect(wallet.page.getByText(/12,?345/)).toHaveCount(0);
    // And the reason must not name what the provider chose: allowlisting
    // `LedgerEntryMismatchError` would put an RPC-authored address on screen,
    // and `balances.ts` records that it is deliberately off that list.
    await expect(wallet.page.getByText(STRANGER)).toHaveCount(0);
  });

  test("VERIFIED: an entry answering a different question renders no figure", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const { address } = await fundedWallet(wallet);

    // The body is the right account; the KEY is the stranger's. This is what a
    // provider serving a cached answer to the wrong question looks like.
    await speak(
      harness.context,
      only("getLedgerEntries", (call) =>
        asksAccount(call, address)
          ? {
              result: entriesResult([
                entryFor(accountKey(STRANGER), accountEntry(address, 77n * STROOPS)),
              ]),
            }
          : "forward",
      ),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await expect(refusal(wallet.page)).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money()).toHaveCount(0);
  });

  test("VERIFIED: an injected first entry cannot displace the answer", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const { address } = await fundedWallet(wallet);

    // Two entries, the real one second. A client that SCANNED the array for a
    // matching key would find it here and render a truthful balance -- and would
    // therefore also prefer an injected entry in any reply where the honest one
    // came first. `readEntry` reads position 0 and demands that IT be the
    // answer, so an injected row is fatal rather than merely ignored.
    await speak(
      harness.context,
      only("getLedgerEntries", (call) =>
        asksAccount(call, address)
          ? {
              result: entriesResult([
                entryFor(accountKey(STRANGER), accountEntry(STRANGER, 1n * STROOPS)),
                entryFor(accountKey(address), accountEntry(address, 500n * STROOPS)),
              ]),
            }
          : "forward",
      ),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await expect(refusal(wallet.page)).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money()).toHaveCount(0);
  });

  test("VERIFIED: a reply carrying no entries field renders no figure", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const { address } = await fundedWallet(wallet);

    // The calibration case. `parseRawLedgerEntries` does `(raw.entries ?? [])`,
    // so after the SDK's parse this shape is byte-identical to "this account
    // does not exist", and it reached the screen as a confident 0.0000000 on a
    // funded wallet before `readEntry` started reading the raw response.
    await speak(
      harness.context,
      only("getLedgerEntries", (call) =>
        asksAccount(call, address) ? { result: { latestLedger: 100 } } : "forward",
      ),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await expect(refusal(wallet.page)).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money()).toHaveCount(0);
  });

  test("TRUSTED: an empty entries array on a funded account renders a confident zero", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const { address, xlm } = await fundedWallet(wallet);
    expect(xlm).toBeGreaterThan(0);

    // `entries: []` is the ONE response shape the wallet is entitled to turn
    // into a zero, because on a healthy ledger it means the account was never
    // created. A provider that wants to hide a balance says exactly this, and
    // nothing distinguishes it from the honest case: the reply is well formed,
    // correctly keyed and complete.
    await speak(
      harness.context,
      only("getLedgerEntries", (call) =>
        asksAccount(call, address) ? { result: entriesResult([]) } : "forward",
      ),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await expect(wallet.money().first()).toHaveText(/^0\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });
    await expect(wallet.page.getByText(/Something went wrong/)).toHaveCount(0);
    // Stated without a reserve line, which is the same rendering the honest "no
    // such account" produces. The two are indistinguishable on screen.
    await expect(wallet.page.getByText(/by the network as a reserve/)).toHaveCount(0);
  });

  test("VERIFIED: malformed, truncated and unexpected-schema replies never become a figure", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(8 * 60_000);
    const { address } = await fundedWallet(wallet);

    // Every shape a broken or hostile provider actually produces, driven one
    // after another against the SAME wallet, so the recovery at the end also
    // proves the wallet was not wedged by any of them.
    const shapes: [string, Answer][] = [
      ["a proxy's HTML on a 200", { raw: { contentType: "text/html", body: "<html><body/></html>" } }],
      ["a body that stops halfway", { raw: { body: '{"jsonrpc":"2.0","id":1,"result":{"entr' } }],
      ["a 500", { raw: { status: 500, body: "upstream failure" } }],
      ["a JSON-RPC error object", { error: { code: -32000, message: "SECRET-RPC-STRING" } }],
      ["entries: null", { result: { entries: null, latestLedger: 100 } }],
      ["entries as an object", { result: { entries: { 0: {} }, latestLedger: 100 } }],
      [
        "an entry whose xdr is not a string",
        { result: { entries: [{ key: "x", xdr: 42 }], latestLedger: 100 } },
      ],
      ["a reply that is a bare number", { raw: { body: "7" } }],
    ];

    let shape: Answer = "forward";
    await speak(
      harness.context,
      only("getLedgerEntries", (call) => (asksAccount(call, address) ? shape : "forward")),
    );

    for (const [name, answer] of shapes) {
      shape = answer;
      await wallet.reopen();
      await wallet.waitForHome(WAITS.ledgerRead);
      // The name goes into the failure, so a red here says WHICH shape broke it.
      await expect(refusal(wallet.page), name).toBeVisible({ timeout: WAITS.ledgerRead });
      await expect(wallet.money(), name).toHaveCount(0);
      // Nothing the provider wrote may reach the screen.
      await expect(
        wallet.page.getByText(/SECRET-RPC-STRING|upstream failure/),
        name,
      ).toHaveCount(0);
    }

    // And it recovers on its own once the provider stops lying, which is the
    // half of a failure test that proves the failure was injected at all.
    shape = "forward";
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    expect(await wallet.publicBalance()).toBeGreaterThan(9000);
  });

  test("int64 boundaries survive the wire exactly, and an impossible sign shows no figure", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(6 * 60_000);
    const { address } = await fundedWallet(wallet);

    let raw = 0n;
    await speak(
      harness.context,
      only("getLedgerEntries", (call) =>
        asksAccount(call, address) ? { result: fundedAccountResult(address, raw) } : "forward",
      ),
    );

    // The largest balance an int64 ledger can hold. Anything in the value path
    // that touched a JS Number would round the last digits away, and nothing on
    // screen would say so.
    raw = 9_223_372_036_854_775_807n;
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await expect(wallet.money().first()).toHaveText(/^922337203684\.4775807\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });

    // A negative AccountEntry balance is a ledger invariant violation: it cannot
    // arrive from a healthy network by any route. Nothing in the read path
    // rejects it, but the reserve subtraction clamps at zero, so what reaches
    // the screen is a zero rather than a negative claim about money.
    raw = -42n * STROOPS;
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await expect(wallet.money().first()).toHaveText(/^0\.0000000\s*XLM$/, {
      timeout: WAITS.ledgerRead,
    });
    await expect(wallet.page.getByText(/-\d+\.\d{7}/)).toHaveCount(0);
  });
});

// ------------------------------------------------------ what a submission trusts

test.describe("submission", () => {
  test("TRUSTED: a fabricated confirmation is shown as a receipt for a transaction that never happened", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(6 * 60_000);
    await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // Neither call is forwarded, so no envelope ever leaves this machine. The
    // wallet is simply told it landed, in a ledger of the provider's choosing.
    const FABRICATED_LEDGER = 4_242_424;
    const sent: { tx: Transaction | null } = { tx: null };
    await speak(harness.context, (call) => {
      if (call.method === "sendTransaction") {
        sent.tx = envelopeOf(call);
        return pendingSend(sent.tx.hash().toString("hex"));
      }
      if (call.method === "getTransaction" && sent.tx) {
        return included(sent.tx, FABRICATED_LEDGER, true);
      }
      return "forward";
    });

    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "1.5", memo: "never-happened" });
    const hash = await wallet.confirmPayment();

    // A receipt for a confirmation the wallet did not verify and cannot: confirm*
    // resolves on the provider's "included" verdict, so "Transaction successful"
    // is shown for a transaction that only the provider claims happened. (The
    // ledger number the receipt used to print, of the provider's choosing, is no
    // longer surfaced; the trusted verdict it stood on is what this documents.)
    await expect(wallet.receipt()).toBeVisible();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);

    // The oracle shares no code with the wallet and has never heard of this
    // transaction. The user is holding a hash and a receipt for a payment that
    // does not exist.
    expect(await ledger.transaction(hash)).toBeNull();
  });

  test("TRUSTED: an included-but-failed verdict is reported as charged, with no receipt", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(6 * 60_000);
    await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    const sent: { tx: Transaction | null } = { tx: null };
    await speak(harness.context, (call) => {
      if (call.method === "sendTransaction") {
        sent.tx = envelopeOf(call);
        return pendingSend(sent.tx.hash().toString("hex"));
      }
      if (call.method === "getTransaction" && sent.tx) return included(sent.tx, 999, false);
      return "forward";
    });

    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "1.5" });
    await wallet.page.getByRole("button", { name: "Confirm" }).click();

    // The verdict is believed whole: charged, sequence consumed. That is the
    // right sentence for a real failure and it is unverifiable here, so a
    // provider can make a user believe they paid a fee for nothing.
    await expect(wallet.page.getByText(/included but failed on chain \(txFailed\)/)).toBeVisible({
      timeout: WAITS.submission,
    });
    await expect(
      wallet.page.getByText(/A fee was charged and the sequence number was used/),
    ).toBeVisible();
    // What matters most, and it holds: a failure is never dressed as a success.
    await expect(wallet.receipt()).toHaveCount(0);
  });

  test("VERIFIED: a submission that never resolves is submitted once and blocks a second build", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(8 * 60_000);
    await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // The provider takes the envelope and then denies ever seeing it, forever.
    // This is the shape that spends twice if a wallet reads "not found" as "did
    // not happen".
    const heard = await speak(harness.context, (call) => {
      if (call.method === "sendTransaction") {
        return pendingSend(envelopeOf(call).hash().toString("hex"));
      }
      if (call.method === "getTransaction") return neverIncluded();
      return "forward";
    });

    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "1.5" });
    await wallet.page.getByRole("button", { name: "Confirm" }).click();

    // The one instruction that must follow an unresolved submission.
    await expect(wallet.page.getByText(/It has not confirmed yet/)).toBeVisible({
      timeout: WAITS.submission,
    });
    await expect(wallet.page.getByText(/do not resend/)).toBeVisible();
    // Submitted once, whatever the polling said. Counted off the wire.
    expect(heard.countOf("sendTransaction")).toBe(1);
    expect(heard.countOf("getTransaction")).toBeGreaterThan(1);

    // And the guard holds against the user simply trying again: a second
    // payment cannot even be built while the first may still land.
    await wallet.close();
    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "1" });
    await expect(
      wallet.page.getByText(/A transaction submitted earlier has not resolved yet/),
    ).toBeVisible({ timeout: WAITS.ledgerRead });
    expect(heard.countOf("sendTransaction")).toBe(1);
  });

  test("TRUSTED: a rejection for a submission that DID land tells the user nothing was charged", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(10 * 60_000);
    const { address } = await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // The one test here that spends a real testnet transaction, because the
    // whole claim is the gap between what the ledger did and what the provider
    // said. The envelope is forwarded to the real RPC and lands; only the ANSWER
    // is replaced, with a rejection carrying a decodable errorResultXdr, which
    // is what `describeSendError` reads.
    const sent: { hash: string | null } = { hash: null };
    await speak(harness.context, async (call, route) => {
      if (call.method !== "sendTransaction") return "forward";
      sent.hash = envelopeOf(call).hash().toString("hex");
      // Forwarded and awaited, so the envelope is genuinely in the network's
      // hands before the lie is told.
      await route.fetch();
      return {
        result: {
          status: "ERROR",
          hash: sent.hash,
          latestLedger: 100,
          latestLedgerCloseTime: "1",
          errorResultXdr: RESULT_BAD_SEQ,
        },
      };
    });

    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "1.5", memo: "did-land" });
    await wallet.page.getByRole("button", { name: "Confirm" }).click();

    await expect(wallet.page.getByText(/The network rejected it \(txBadSeq\)/)).toBeVisible({
      timeout: WAITS.submission,
    });
    await expect(wallet.page.getByText(/Nothing was charged/)).toBeVisible();
    await expect(wallet.receipt()).toHaveCount(0);

    // The ledger disagrees. The payment is on chain and the money is gone, and
    // the wallet has told the user the opposite.
    expect(sent.hash).not.toBeNull();
    const landed = await ledger.waitForTransaction(sent.hash as string);
    expect(landed.successful).toBe(true);
    expect(await ledger.nativeBalance(address)).toBeLessThan(ledger.FRIENDBOT_XLM - 1);

    // And nothing stands between the user and sending it again: a "rejected"
    // outcome clears the in-flight record, which is correct for a real rejection
    // and is exactly the guard that would have caught this one.
    expect(await askWorker<unknown>(wallet.page, { type: "inFlight" })).toBeNull();
  });

  test("VERIFIED: the envelope signed is the one reviewed, and only the chosen network can apply it", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(8 * 60_000);
    const { address } = await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // Captured at the wire and refused there, so nothing lands: the question is
    // what the wallet was about to sign, not what a ledger did with it.
    const sent: { tx: Transaction | null } = { tx: null };
    await speak(harness.context, (call) => {
      if (call.method !== "sendTransaction") return "forward";
      sent.tx = envelopeOf(call);
      return { error: { code: -32000, message: "refused by the test" } };
    });

    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "1.5", memo: "bound" });
    const sheet = wallet.page.getByRole("dialog", { name: "Send" });
    await expect(sheet.getByText(/^1\.5000000\s*XLM$/)).toBeVisible({ timeout: WAITS.ledgerRead });
    // The fee is a constant this build chose, not a number the provider offered:
    // a classic payment is never simulated, so there is nothing for an RPC to
    // inflate here.
    await expect(sheet.getByText("Pay a network fee of 0.0000100 XLM")).toBeVisible();
    await wallet.page.getByRole("button", { name: "Confirm" }).click();
    await expect(wallet.page.getByText(/It has not confirmed yet/)).toBeVisible({
      timeout: WAITS.submission,
    });

    const tx = sent.tx;
    expect(tx).not.toBeNull();
    const signed = tx as Transaction;
    // Field for field against what the review screen said.
    expect(signed.source).toBe(address);
    expect(signed.fee).toBe("100");
    expect(signed.operations).toHaveLength(1);
    const op = signed.operations[0] as { type: string; destination?: string; amount?: string };
    expect(op.type).toBe("payment");
    expect(op.destination).toBe(RECIPIENT);
    // Seven decimals, which is the exact figure the review screen rendered.
    expect(op.amount).toBe("1.5000000");
    expect(signed.memo.value?.toString()).toBe("bound");

    // The replay question, asked of the bytes rather than of the source. A
    // signature covers the network id, so this asserts the signature verifies
    // against the testnet hash and does NOT verify against the mainnet one --
    // which is the property "valid only on the network the user chose" means.
    const verifier = Keypair.fromPublicKey(address);
    expect(signed.signatures).toHaveLength(1);
    const sig = signed.signatures[0]!.signature();
    expect(verifier.verify(signed.hash(), sig)).toBe(true);
    const reread = TransactionBuilder.fromXDR(signed.toXDR(), MAINNET) as Transaction;
    expect(verifier.verify(reread.hash(), sig)).toBe(false);
  });

  test("TRUSTED: the sequence number is signed exactly as the provider supplied it", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(8 * 60_000);
    const { address } = await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // `readNative` checks the key echo AND the account id inside the entry.
    // `server.getAccount`, which is where the sequence number comes from, is the
    // SDK's PARSED path: it reads `entries[0]`, takes `seqNum`, and labels it
    // with the address the CALLER asked about. So the same endpoint answers two
    // questions with different amounts of scepticism, and it is the less
    // sceptical one whose value ends up inside a signed envelope.
    const FABRICATED_SEQ = "9007199254000123";
    const sent: { tx: Transaction | null } = { tx: null };
    await speak(harness.context, (call) => {
      if (call.method === "sendTransaction") {
        sent.tx = envelopeOf(call);
        return { error: { code: -32000, message: "refused by the test" } };
      }
      if (call.method !== "getLedgerEntries" || !asksAccount(call, address)) return "forward";
      // The account id is left correct so the balance check passes and the
      // payment is allowed at all; only the sequence number is the provider's.
      return {
        result: entriesResult([
          entryFor(
            accountKey(address),
            accountEntry(address, 10_000n * STROOPS, { seq: FABRICATED_SEQ }),
          ),
        ]),
      };
    });

    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "1.5" });
    await wallet.page.getByRole("button", { name: "Confirm" }).click();
    await expect(wallet.page.getByText(/It has not confirmed yet/)).toBeVisible({
      timeout: WAITS.submission,
    });

    const signed = sent.tx as Transaction;
    expect(signed).not.toBeNull();
    // Signed against a sequence number the provider chose. On a real ledger this
    // is refused as txBadSeq, which charges no fee and consumes nothing, so the
    // reachable harm is denial rather than loss -- which is what this records.
    expect(signed.sequence).toBe((BigInt(FABRICATED_SEQ) + 1n).toString());
  });
});

// ------------------------------------------------------------- fees and costs

test.describe("fees and costs", () => {
  test("RECORDED: a private operation states a fee before the fee exists, and the provider picks the real one", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(14 * 60_000);
    await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // A classic payment is never simulated, so its fee is a constant this build
    // chose and no provider can move it. A SOROBAN operation is different:
    // `signAndSubmit` calls `prepareTransaction`, which rewrites the envelope's
    // fee to BASE_FEE + the `minResourceFee` the RPC's simulation returned --
    // and it does so AFTER the user has approved a review screen whose fee line
    // was computed from the unprepared envelope. So the number on the screen is
    // structurally not the number that will be charged, and the number that will
    // be charged is chosen by the provider.
    //
    // Set-up sends two transactions. The first, the auditor-key registration,
    // is forwarded and lands for real, because the review screen this test is
    // about only exists on the far side of it. The second is captured at the
    // wire and refused there, so nothing is charged for the operation under
    // test and the assertion is about the envelope, not about a ledger.
    //
    // The simulation is left honest until the review is on screen, and only
    // then is its `minResourceFee` multiplied -- so the inflation can only
    // reach the ONE simulation that happens after the user approved, which is
    // exactly the window this finding is about.
    const INFLATION = 20;
    let sends = 0;
    let inflate = false;
    const quoted: number[] = [];
    const sent: { tx: Transaction | null } = { tx: null };
    await speak(harness.context, async (call, route) => {
      if (call.method === "sendTransaction") {
        if (++sends === 1) return "forward";
        sent.tx = envelopeOf(call);
        return { error: { code: -32000, message: "refused by the test" } };
      }
      if (call.method !== "simulateTransaction" || !inflate) return "forward";
      const body = (await (await route.fetch()).json()) as {
        result?: { minResourceFee?: string; transactionData?: string };
      };
      const raw = body.result?.transactionData;
      if (!raw) return { result: body.result };
      // The number that actually sets the fee is `resourceFee` INSIDE the
      // simulation's `transactionData`, not the `minResourceFee` beside it:
      // `assembleTransaction` keeps the classic fee and attaches the Soroban
      // data whole, and `build()` adds that struct's resourceFee. Rewriting the
      // sibling field alone changes nothing, which is worth knowing -- the
      // authoritative cost figure travels inside an opaque blob.
      const data = xdr.SorobanTransactionData.fromXDR(raw, "base64");
      const honest = BigInt(data.resourceFee().toString());
      quoted.push(Number(honest));
      data.resourceFee(xdr.Int64.fromString((honest * BigInt(INFLATION)).toString()));
      return {
        result: {
          ...body.result,
          minResourceFee: (honest * BigInt(INFLATION)).toString(),
          transactionData: data.toXDR("base64"),
        },
      };
    });

    await wallet.openMove();
    const move = wallet.page.getByRole("dialog", { name: "Move" });
    await expect(move.getByRole("button", { name: "Set up the private pocket" })).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await move.getByRole("button", { name: "Set up the private pocket" }).click();

    // The review screen, and the one sentence about cost it offers.
    await expect(wallet.page.getByText("What this does")).toBeVisible({
      timeout: WAITS.proving,
    });
    const feeLine = wallet.page.getByText(/^Pay a network fee of [\d.]+ XLM$/);
    await expect(feeLine).toBeVisible();
    const statedXlm = (await feeLine.innerText()).replace(/[^\d.]/g, "");
    const statedStroops = Math.round(Number(statedXlm) * 1e7);
    // The base fee, and only the base fee: the resource fee does not exist yet.
    expect(statedStroops).toBe(100);

    inflate = true;
    await wallet.page.getByRole("button", { name: "Approve" }).click();
    await expect(
      wallet.page.getByText(/It has not confirmed yet|Something went wrong/).first(),
    ).toBeVisible({ timeout: WAITS.submission });

    const signed = sent.tx as Transaction;
    expect(signed).not.toBeNull();
    expect(quoted.length).toBeGreaterThan(0);
    // The envelope that was signed carries base fee plus whatever the provider's
    // simulation asked for, exactly. No threshold and no approximation: the fee
    // IS the provider's number, and the screen the user approved said 0.0000100.
    const asked = quoted[quoted.length - 1] as number;
    expect(signed.fee).toBe(String(statedStroops + asked * INFLATION));
    expect(Number(signed.fee)).toBeGreaterThan(1000 * statedStroops);
  });
});

// -------------------------------------------------- what the private pocket trusts

test.describe("the private pocket", () => {
  test("VERIFIED: an invented private account produces no figure, because the openings are local", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(6 * 60_000);
    await fundedWallet(wallet);

    // The most a provider can do here. It claims this account has a private
    // pocket, with commitments of its choosing and an auditor id of its
    // choosing. It cannot produce the OPENINGS, which exist only in the
    // encrypted vault, so no balance can be computed and none is shown.
    const heard = await speak(
      harness.context,
      only("simulateTransaction", () => simulated(inventedConfidentialAccount())),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPrivatePocket();

    await expect(wallet.page.getByText(/this device has no record of its balances/)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await expect(wallet.money()).toHaveCount(0);
    // And the invented state is not narrated back as a fact about the user.
    await expect(wallet.page.getByText("Private pocket not set up")).toHaveCount(0);
    await expect(wallet.page.getByText(/auditor #?7/i)).toHaveCount(0);
    // The lie was told, from the worker. Without this the test would pass just
    // as well against a wallet that never asked.
    expect(heard.countOf("simulateTransaction")).toBeGreaterThan(0);
    expect(heard.fromServiceWorker).toBeGreaterThan(0);
  });

  test("VERIFIED: a provider that cannot say whether a pocket exists may not imply it does not", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(6 * 60_000);
    await fundedWallet(wallet);

    // The irreversible-action guard. "There is no private pocket here" and "I
    // could not tell you" carry opposite instructions, and one of them --
    // pressing Set up -- binds an auditor key permanently. A simulation with no
    // error, no restore preamble and no result is a reply that did not answer,
    // and it must not become the first of those two.
    const heard = await speak(
      harness.context,
      only("simulateTransaction", () => simulated()),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPrivatePocket();

    await expect(
      wallet.page.getByText(/did not answer whether this account has a private pocket/),
    ).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money()).toHaveCount(0);
    await expect(wallet.page.getByText("Private pocket not set up")).toHaveCount(0);
    // Nothing on screen invites the permanent action while the answer is unknown.
    await expect(
      wallet.page.getByRole("button", { name: "Set up the private pocket" }),
    ).toHaveCount(0);
    expect(heard.countOf("simulateTransaction")).toBeGreaterThan(0);
  });

  test("VERIFIED: a TTL read that cannot answer never becomes a dormancy claim", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(6 * 60_000);
    const { address } = await fundedWallet(wallet);

    // The account entry is answered truthfully so the wallet gets past the
    // funding check. The CONTRACT DATA key -- the confidential account's own
    // entry, where the TTL lives -- comes back with no entries field. Reading
    // that as "absent" would offer set-up to somebody who already has a pocket
    // and merely went dormant, which is the unrecoverable version of this bug.
    let ttlReads = 0;
    await speak(
      harness.context,
      only("getLedgerEntries", (call) => {
        if (asksAccount(call, address)) return "forward";
        ttlReads++;
        return { result: { latestLedger: 100 } };
      }),
    );
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPrivatePocket();

    // `LedgerReadError` is on the safe-error allowlist because its wording is
    // wholly ours and interpolates nothing from the wire, so the exact sentence
    // is the assertion rather than a shrug at any error at all.
    await expect(
      wallet.page.getByText(
        "the ledger did not answer the question: the response carried no entries field",
      ),
    ).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money()).toHaveCount(0);
    await expect(wallet.page.getByText(/dormant/)).toHaveCount(0);
    expect(ttlReads).toBeGreaterThan(0);
  });
});

// -------------------------------------------- slow, partly wrong, and entirely down

test.describe("availability", () => {
  test("one call held open forever does not take the rest of the wallet with it", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(8 * 60_000);
    await fundedWallet(wallet);

    // Correct for some calls and never for others. Ledger reads are answered
    // truthfully; simulation is accepted and then silently held open, which is a
    // different failure from a refused connection and is the one that exercises
    // the request deadline rather than the socket.
    await speak(harness.context, (call) => {
      if (call.method !== "simulateTransaction") return "forward";
      return new Promise<Answer>(() => {
        /* deliberately never settled */
      });
    });
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    // The pocket that does not depend on the stalled call is unaffected and
    // states the ledger's own figure.
    expect(await wallet.publicBalance()).toBeGreaterThan(9000);

    await wallet.openPrivatePocket();
    // The pocket that does depend on it shows a wait or a refusal, and in
    // neither case a number, and in neither case a claim about its state.
    await expect(
      wallet.page.getByText(/Looking for payments you have received|Something went wrong/).first(),
    ).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money()).toHaveCount(0);
    for (const claim of ["Private pocket not set up", "Private pocket is dormant", "Receiving"]) {
      await expect(wallet.page.getByText(claim, { exact: true })).toHaveCount(0);
    }

    // And the wallet is still a wallet, with the other call still hanging.
    await wallet.openPocket("Public pocket");
    expect(await wallet.publicBalance()).toBeGreaterThan(9000);
  });

  test("RECORDED: everything already on the home screen outlives a refresh that failed", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(8 * 60_000);
    const { address } = await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    expect(await wallet.publicBalance()).toBeGreaterThan(9000);
    // The exact renderings, so the assertions below are about THESE facts rather
    // than about anything that happens to be shaped like them.
    const figure = (await wallet.money().first().innerText()).trim();
    await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible();

    // The Refresh control on the home screen is a user action, so this is the
    // reachable version of "a balance that is stale presented as current".
    // `WalletProvider.loadBalances` keeps the previous figure deliberately -- a
    // zero would be a lie -- and its comment says "the error says the number is
    // stale". `Home.publicHero` renders `balanceError` only when there is NO
    // balance, and `privateHero` renders `privError` only when there is no
    // pocket state, so once either has loaded the error has nowhere to appear.
    let held = 0;
    await speak(
      harness.context,
      only("getLedgerEntries", (call) => {
        if (!asksAccount(call, address)) return "forward";
        held++;
        return new Promise<Answer>(() => {
          /* deliberately never settled */
        });
      }),
    );

    // The premise, proved rather than assumed, and proved through the worker's
    // own answer rather than through the screen: while this stub is installed
    // NO account read can complete, so nothing the popup does next can succeed.
    // Without this the rest would pass just as well against a refresh that
    // quietly worked.
    await expect(askWorker(wallet.page, { type: "balances" })).rejects.toThrow();
    expect(held).toBeGreaterThan(0);

    await wallet.page.getByRole("button", { name: "Refresh" }).click();
    // The refresh really started, and then really finished. Both edges, so this
    // is not an assertion about the state before the click.
    const spinner = wallet.page.locator(".pocket-spinner");
    await expect(spinner).toHaveCount(1, { timeout: WAITS.ledgerRead });
    await expect(spinner).toHaveCount(0, { timeout: WAITS.ledgerRead });

    // Nothing moved and nothing said anything. The figure, the reserve line and
    // the private pocket's state are all still stated as facts, and every read
    // behind them failed. The wallet's rule is "never render a number it does
    // not have"; these are numbers and states it no longer has.
    await expect(wallet.money().first()).toHaveText(figure);
    await expect(wallet.page.getByText(/by the network as a reserve/)).toBeVisible();
    await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible();
    await expect(wallet.page.getByText(/Something went wrong/)).toHaveCount(0);
    await expect(wallet.page.getByText(/Reading the ledger/)).toHaveCount(0);
    await expect(wallet.page.locator(".pocket-skeleton")).toHaveCount(0);
  });

  test("entirely down: the address is still shown in full, and no figure is", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(6 * 60_000);
    await fundedWallet(wallet);

    // R15's whole point. An address is derived locally and owes the network
    // nothing, so a dead RPC must not stop a user receiving. A wallet that
    // greyed out Receive because a read failed would be a wallet that "looks
    // broken" for a reason that has nothing to do with receiving.
    await offline(harness.context, RPC_HOST);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await expect(
      wallet.page.getByText(/Something went wrong|check your connection/i).first(),
    ).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.money()).toHaveCount(0);

    expect(await wallet.revealAddress()).toMatch(/^G[A-Z2-7]{55}$/);
  });

  test("a dependency this build does not use is never contacted, and never blamed", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    // DeFindex is unconfigured in a shipped build, so the honest answer is
    // "there is no vault", not "the vault could not be read". Proved by refusing
    // every request to the host and asserting none was made: an availability
    // failure cannot be reported for a dependency that was never contacted.
    let contacted = 0;
    await intercept(harness.context, "api.defindex.io", async (route) => {
      contacted++;
      await route.abort("connectionfailed");
    });

    await fundedWallet(wallet);
    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);

    await expect(
      wallet.page.getByText(
        "Yield is not configured for this network. Nothing is at risk; there is simply no vault to deposit into.",
      ),
    ).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(wallet.page.getByText(/could not be read/)).toHaveCount(0);
    expect(contacted).toBe(0);
  });

  test("TRUSTED: the wallet never asks the provider which network it is on", async ({
    harness,
    wallet,
  }) => {
    test.setTimeout(8 * 60_000);
    await fundedWallet(wallet);

    // The replay case, stated as what it is. The network passphrase is a local
    // constant, so a provider cannot talk this wallet into signing for a network
    // the user did not choose -- and, by the same token, the wallet has no way
    // to DETECT that the provider it is reading is serving another network's
    // state. A G-address is valid on every Stellar network and a ledger entry
    // for it is byte-identical in shape, so every check in the read path passes
    // against the wrong chain's data.
    //
    // Both halves are asserted: `getNetwork` is never called across a full
    // session, and answering it with mainnet's identity changes nothing at all.
    const heard = await speak(harness.context, (call) =>
      call.method === "getNetwork"
        ? {
            result: {
              friendbotUrl: "https://example.invalid/friendbot",
              passphrase: MAINNET,
              protocolVersion: 23,
            },
          }
        : "forward",
    );

    await wallet.reopen();
    await wallet.waitForHome(WAITS.ledgerRead);
    expect(await wallet.publicBalance()).toBeGreaterThan(9000);
    await wallet.openPrivatePocket();
    await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
      timeout: WAITS.ledgerRead,
    });
    await wallet.openPocket("Public pocket");
    await wallet.openSend();
    await wallet.composePayment({ to: RECIPIENT, amount: "1" });
    await expect(wallet.page.getByText(/^1\.0000000\s*XLM$/)).toBeVisible({
      timeout: WAITS.ledgerRead,
    });

    expect(heard.countOf("getNetwork")).toBe(0);
    expect(heard.countOf("getHealth")).toBe(0);
    expect(heard.fromServiceWorker).toBeGreaterThan(0);
  });
});
