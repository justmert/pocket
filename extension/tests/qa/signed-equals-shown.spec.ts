// R3: what is signed is not what was shown.
//
// the confirmation screen is the last thing between a person and a signature,
// so the property is not "the wallet built a sensible transaction" but "the
// bytes that left the machine are the bytes the screen described". proving that
// needs a second opinion, and every envelope below gets one: it is taken off
// the WIRE (or off the value handed back to the site) and decoded with
// @stellar/stellar-sdk the way any third party would, then compared against
// what the DOM said. comparing the wallet's summary to the wallet's own
// description of its own envelope would only prove the wallet agrees with
// itself, which is the one thing that is never in doubt.
//
// two paths, and they are not equally provable:
//
//   the wallet's own review  buildPayment -> ReviewPanel -> confirmPayment.
//     the review is assembled from the REQUEST, not by decoding the envelope,
//     so nothing inside the wallet would notice if the builder and the summary
//     disagreed. the check here is therefore a full reconstruction: an envelope
//     is rebuilt from the screen alone and its hash compared to the one on the
//     wire. the hash commits to every field, so equality is byte equality of
//     the signed payload, including the fields nobody thought to assert.
//
//   a site's request  pendingDappRequest -> DappApproval -> resolveDappRequest.
//     here the test authors the bytes, so equality is literal: strip the
//     signature off what came back and it must be the same base64 string.
import { test, expect } from "../support/fixtures";
import { askWorker } from "../support/extension";
import { Wallet, WAITS } from "../support/wallet";
import { intercept, RPC_HOST } from "../support/stub";
import * as ledger from "../support/testnet";
import { DEPLOYMENT } from "../support/soroban";
import {
  Account,
  Address,
  Asset,
  Claimant,
  FeeBumpTransaction,
  Keypair,
  Memo,
  Operation,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk/base";
import type { BrowserContext, Page } from "@playwright/test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const PASSWORD = "a-strong-test-password";

/**
 * the network the signature must commit to, written down here rather than read
 * from the wallet's own config: a test that asked the wallet which network it
 * was on could not tell a wrong passphrase from a wrong answer about it.
 */
const TESTNET = "Test SDF Network ; September 2015";

/** decimal XLM as it appears on screen, to the stroops an envelope carries. */
function stroops(xlm: string): bigint {
  const [whole = "0", fraction = ""] = xlm.trim().split(".");
  return BigInt(whole) * 10_000_000n + BigInt(`${fraction}0000000`.slice(0, 7));
}

/** the same envelope with its signatures removed, for a literal comparison. */
function unsigned(envelopeB64: string): string {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeB64, "base64");
  envelope.v1().signatures([]);
  return envelope.toXDR("base64");
}

/**
 * every envelope this browser submits, in order, as base64.
 *
 * the wire is the only place the signed bytes exist outside the worker: the
 * popup is handed an opaque handle and never sees XDR, which is the point of
 * the handle and also why nothing inside the extension can answer this
 * question. the requests are continued untouched, so the wallet's own flow is
 * unaffected by being watched.
 */
async function captureSubmissions(context: BrowserContext): Promise<string[]> {
  const sent: string[] = [];
  await intercept(context, RPC_HOST, async (route) => {
    let body: unknown = null;
    try {
      body = route.request().postDataJSON();
    } catch {
      body = null;
    }
    for (const call of Array.isArray(body) ? body : [body]) {
      const c = call as { method?: string; params?: { transaction?: string } } | null;
      if (c?.method === "sendTransaction" && typeof c.params?.transaction === "string") {
        sent.push(c.params.transaction);
      }
    }
    await route.continue();
  });
  return sent;
}

/** decode a wire envelope as a stranger would, refusing the fee-bump shape. */
function decode(envelopeB64: string) {
  const tx = TransactionBuilder.fromXDR(envelopeB64, TESTNET);
  if (tx instanceof FeeBumpTransaction) throw new Error("a fee-bump envelope reached the wire");
  return tx;
}

/** what the review panel put on screen, read the way a person reads it.
 *
 * the confirm shows the SIGNED facts as visible rows now: the figure is the hero,
 * the recipient is the full-address block, the fee and the memo are their own
 * labelled rows. the "what this does" enumeration moved into an info tip (the
 * explanation, not the facts). so the reconstruction reads the rows, which is
 * exactly the surface a person reads before approving. */
async function readReview(wallet: Wallet) {
  // the review only exists once the worker has built and retained the envelope,
  // and building reads the ledger first. waiting on the panel itself rather
  // than on a duration.
  await expect(wallet.page.getByText("What this does")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  // the hero carries the exact value and its code in one run ("12.5000000 XLM").
  const hero = (await wallet.money().first().innerText()).trim();
  const [amount, code] = hero.split(/\s+/);
  // the value beside a labelled row: the fact sits in the row's second cell.
  const rowValue = async (label: string): Promise<string> =>
    (
      await wallet.page
        .getByText(label, { exact: true })
        .locator("xpath=following-sibling::*[1]")
        .innerText()
    ).trim();
  const fee = (await rowValue("Network fee")).replace(/[^\d.]/g, "");
  const memoText = await rowValue("Memo");
  const memo = memoText === "None" ? undefined : memoText;
  return {
    to: await wallet.readAddress(),
    hero,
    amount: amount!,
    code: code!,
    fee,
    memo,
  };
}

// --------------------------------------------------------------- the site side

/** a real origin, so the content script's http match actually fires. */
async function serveSite(): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><title>a website</title><body><h1>a website</h1></body>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise<void>((r) => {
        // chromium holds the socket open with keep-alive, so a plain close()
        // waits for it and the test hangs long after its assertions passed.
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}

interface Site {
  page: Page;
  origin: string;
  close: () => Promise<void>;
}

/** an ordinary page, connected to the wallet, next to the popup. */
async function connectedSite(context: BrowserContext, popup: Page): Promise<Site> {
  const served = await serveSite();
  const page = await context.newPage();
  await page.goto(served.url);
  await page.waitForFunction(() => "pocket" in window, undefined, { timeout: 15_000 });
  const origin = new URL(served.url).origin;
  // granting is the popup's job and a page cannot do it; this is setup, not the
  // subject, so it goes through the worker rather than through the settings UI.
  await askWorker(popup, { type: "connectDapp", origin });
  return { page, origin, close: served.close };
}

/**
 * ask for a signature without waiting for it.
 *
 * the call parks in the worker until somebody answers it in the popup, so
 * awaiting it here would deadlock the page that has to stay alive to receive
 * the answer. the promise is stashed on the window and collected afterwards.
 */
async function requestSignature(page: Page, envelopeB64: string): Promise<void> {
  await page.evaluate((xdrB64) => {
    const provider = (window as unknown as { pocket: Record<string, unknown> }).pocket;
    const sign = provider.signTransaction as (x: string, o: unknown) => Promise<unknown>;
    (window as unknown as { __signing: Promise<unknown> }).__signing = sign(xdrB64, {});
  }, envelopeB64);
}

async function signatureResult(page: Page): Promise<{
  signedTxXdr?: string;
  signerAddress?: string;
  error?: { message: string };
}> {
  return page.evaluate(
    () => (window as unknown as { __signing: Promise<unknown> }).__signing,
  ) as Promise<{ signedTxXdr?: string; signerAddress?: string; error?: { message: string } }>;
}

/** an envelope a site would hand over, authored here so its bytes are known. */
function siteEnvelope(
  source: string,
  operations: xdr.Operation[],
  opts: { memo?: string; fee?: string; sequence?: string } = {},
) {
  const builder = new TransactionBuilder(new Account(source, opts.sequence ?? "8675309"), {
    fee: opts.fee ?? "1234",
    networkPassphrase: TESTNET,
  });
  for (const op of operations) builder.addOperation(op);
  builder.setTimeout(600);
  if (opts.memo) builder.addMemo(Memo.text(opts.memo));
  return builder.build();
}

/** the popup, remounted, so the pending request check on mount runs again. */
async function showApproval(wallet: Wallet): Promise<void> {
  await wallet.reopen();
  await expect(wallet.page.getByRole("heading", { name: "Signature request" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
}

// ============================================================ the wallet's own review

test("the payment on the wire is, byte for byte, the payment the review screen showed", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(8 * 60_000);
  const sent = await captureSubmissions(harness.context);

  await wallet.createWallet(PASSWORD);
  const sender = await wallet.revealAddress();
  await ledger.fund(sender);
  // a real destination account, because a payment to an account that does not
  // exist fails on chain and there would be no signature to inspect.
  const recipient = Keypair.random().publicKey();
  await ledger.fund(recipient);

  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openSend();
  await wallet.composePayment({ to: recipient, amount: "12.5", memo: "invoice-42" });

  const shown = await readReview(wallet);
  // the two renderings of the same figure have to agree before either can be
  // compared to anything: a hero that disagrees with its own effects line is
  // already a defect, and would otherwise let the reconstruction below pick
  // whichever one happened to match.
  expect(shown.hero).toBe(`${shown.amount} ${shown.code}`);
  expect(shown.memo).toBe("invoice-42");
  await expect(wallet.page.getByText("invoice-42", { exact: true })).toBeVisible();

  const hash = await wallet.confirmPayment();

  expect(sent, "exactly one envelope was submitted").toHaveLength(1);
  const wire = decode(sent[0]!);

  // field by field first, so a failure names which field moved.
  expect(wire.source).toBe(sender);
  expect(wire.operations).toHaveLength(1);
  const op = wire.operations[0] as {
    type: string;
    destination: string;
    amount: string;
    asset: Asset;
  };
  expect(op.type).toBe("payment");
  expect(op.destination).toBe(shown.to);
  expect(op.amount).toBe(shown.amount);
  expect(op.asset.isNative()).toBe(true);
  expect(shown.code).toBe("XLM");
  expect((wire.memo as { value: unknown }).value?.toString()).toBe(shown.memo);
  expect(wire.fee).toBe(stroops(shown.fee).toString());
  expect(wire.networkPassphrase).toBe(TESTNET);

  // then the whole envelope at once. everything above is rebuilt from the
  // screen; the only two values borrowed from the wire are the sequence number
  // and the time bounds, which the review does not display and could not. if
  // the hashes match, the signed payload contains NOTHING the screen did not
  // say -- no second operation, no extra precondition, no muxed destination, no
  // field this test did not think to check.
  const rebuilt = new TransactionBuilder(
    new Account(sender, (BigInt(wire.sequence) - 1n).toString()),
    {
      fee: stroops(shown.fee).toString(),
      networkPassphrase: TESTNET,
      timebounds: wire.timeBounds!,
    },
  )
    .addOperation(
      Operation.payment({
        destination: shown.to,
        asset: Asset.native(),
        amount: shown.amount,
      }),
    )
    .addMemo(Memo.text(shown.memo!))
    .build();
  expect(
    rebuilt.hash().toString("hex"),
    "the envelope on the wire is not the one the screen described",
  ).toBe(wire.hash().toString("hex"));

  // the handle is the hash of the envelope the worker retained, and confirm
  // signs only what that handle names, so this equality is also the proof that
  // the handle, the display and the signature are all the same transaction.
  expect(hash).toBe(wire.hash().toString("hex"));

  // one signature, and it is this wallet's, over exactly these bytes on exactly
  // this network. a signature that verifies against another passphrase would be
  // valid on a chain the user did not choose.
  expect(wire.signatures).toHaveLength(1);
  expect(Keypair.fromPublicKey(sender).verify(wire.hash(), wire.signatures[0]!.signature())).toBe(
    true,
  );

  // and the ledger's own copy agrees, which is the only authority on what was
  // actually applied.
  const landed = await ledger.waitForTransaction(hash);
  expect(landed.successful).toBe(true);
  expect(landed.memo).toBe(shown.memo);
  expect(landed.operation_count).toBe(1);
});

test("an envelope built while the review is on screen cannot take its place", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(8 * 60_000);
  const sent = await captureSubmissions(harness.context);

  await wallet.createWallet(PASSWORD);
  const sender = await wallet.revealAddress();
  await ledger.fund(sender);
  const recipient = Keypair.random().publicKey();
  await ledger.fund(recipient);
  // funded too, and deliberately: if the wrong envelope were signed it would be
  // a payment that LANDS, and the test then fails on the address it was
  // watching rather than five minutes later on a receipt that never came.
  const stranger = Keypair.random().publicKey();
  await ledger.fund(stranger);

  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openSend();
  await wallet.composePayment({ to: recipient, amount: "3", memo: "reviewed" });
  const shown = await readReview(wallet);

  // the worker retains every envelope it builds for ten minutes, so while this
  // review sits on screen a second one is made to exist beside it, for a
  // different person and a different amount. that is the shape of the attack
  // the build/confirm split has to survive: the display happened once, and
  // anything that arrives afterwards must not be what gets signed.
  const other = await askWorker<{ xdr: string }>(wallet.page, {
    type: "buildPayment",
    to: stranger,
    amount: "500",
    assetId: "native",
    memo: "not reviewed",
  });
  expect(other.xdr).toMatch(/^[0-9a-f]{64}$/);

  const hash = await wallet.confirmPayment();

  expect(sent, "more than one envelope was submitted").toHaveLength(1);
  const wire = decode(sent[0]!);
  const op = wire.operations[0] as { type: string; destination: string; amount: string };
  expect(op.destination, "the signature went to the address the screen never showed").toBe(
    shown.to,
  );
  expect(op.destination).not.toBe(stranger);
  expect(op.amount).toBe(shown.amount);
  expect((wire.memo as { value: unknown }).value?.toString()).toBe("reviewed");
  expect(hash).toBe(wire.hash().toString("hex"));
  expect(hash, "the second envelope was signed instead").not.toBe(other.xdr);
});

test("the worker signs nothing it did not build, and puts nothing on the wire when refusing", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(6 * 60_000);
  const sent = await captureSubmissions(harness.context);

  await wallet.createWallet(PASSWORD);
  const sender = await wallet.revealAddress();
  await ledger.fund(sender);
  const attacker = Keypair.random().publicKey();
  const account = await ledger.account(sender);

  // two envelopes this wallet would never build, both perfectly well formed and
  // both sourced from the wallet's own account so nothing later in the chain of
  // checks can be what refuses them. if a caller could choose the bytes, the
  // approval screen would be decoration.
  const drain = siteEnvelope(
    sender,
    [Operation.payment({ destination: attacker, asset: Asset.native(), amount: "9000" })],
    { sequence: account!.sequence },
  );
  const takeover = siteEnvelope(sender, [Operation.accountMerge({ destination: attacker })], {
    sequence: account!.sequence,
  });

  for (const [what, envelope] of [
    ["a payment", drain],
    ["an account merge", takeover],
  ] as const) {
    for (const [form, handle] of [
      ["raw XDR", envelope.toXDR()],
      ["its hash, as though it were a handle", envelope.hash().toString("hex")],
    ] as const) {
      await expect(
        askWorker(wallet.page, { type: "confirmPayment", handle }),
        `${what} as ${form} was accepted`,
      ).rejects.toThrow(/no longer pending confirmation/i);
      await expect(
        askWorker(wallet.page, { type: "confirmPrivateOp", handle }),
        `${what} as ${form} was accepted by the private path`,
      ).rejects.toThrow(/no longer pending confirmation/i);
    }
  }

  // the assertion that matters: refusing is not enough if the bytes went out
  // anyway. nothing was submitted at all.
  expect(sent, "an envelope reached the network despite the refusal").toHaveLength(0);
});

// ================================================================== a site's request

test("a site gets back exactly the envelope the approval screen described, plus one signature", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(6 * 60_000);
  const sent = await captureSubmissions(harness.context);

  await wallet.createWallet(PASSWORD);
  const owner = await wallet.revealAddress();
  // no funding: nothing here is submitted. the wallet decodes the envelope and
  // signs it, and the ledger is not part of the question.
  const site = await connectedSite(harness.context, wallet.page);
  try {
    const recipient = Keypair.random().publicKey();
    const envelope = siteEnvelope(
      owner,
      [Operation.payment({ destination: recipient, asset: Asset.native(), amount: "42.5000000" })],
      { memo: "from-the-site", fee: "1234" },
    );
    await requestSignature(site.page, envelope.toXDR());
    await showApproval(wallet);

    // what the screen says, against what this test knows it put in the bytes.
    const effects = await wallet.page.getByRole("listitem").allInnerTexts();
    expect(effects).toEqual([`1. Send 42.5000000 XLM to ${recipient}`]);
    await expect(wallet.page.getByText("from-the-site", { exact: true })).toBeVisible();
    await expect(wallet.page.getByText("0.0001234 XLM")).toBeVisible();
    await expect(wallet.page.getByText(site.origin)).toBeVisible();
    await expect(wallet.page.getByText(/could not read/i)).toHaveCount(0);

    await wallet.page.getByRole("button", { name: "Approve" }).click();
    const result = await signatureResult(site.page);

    expect(result.error).toBeFalsy();
    expect(result.signerAddress).toBe(owner);
    // literal byte equality: strip the signature off what came back and it is
    // the same base64 the site sent. not a field comparison, not a hash -- the
    // same string.
    expect(unsigned(result.signedTxXdr!)).toBe(envelope.toXDR());

    const signed = decode(result.signedTxXdr!);
    expect(signed.signatures).toHaveLength(1);
    expect(
      Keypair.fromPublicKey(owner).verify(signed.hash(), signed.signatures[0]!.signature()),
      "the signature does not verify over these bytes on this network",
    ).toBe(true);
    // and the wallet did not quietly submit what it was asked to sign.
    expect(sent).toHaveLength(0);
  } finally {
    await site.close();
  }
});

test("one approval authorises one envelope and no other", async ({ harness, wallet }) => {
  test.setTimeout(6 * 60_000);
  await wallet.createWallet(PASSWORD);
  const owner = await wallet.revealAddress();
  const site = await connectedSite(harness.context, wallet.page);
  try {
    const first = siteEnvelope(owner, [
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "1.0000000",
      }),
    ]);
    await requestSignature(site.page, first.toXDR());
    await showApproval(wallet);
    await wallet.page.getByRole("button", { name: "Approve" }).click();
    expect((await signatureResult(site.page)).signedTxXdr).toBeTruthy();

    // the same site, still connected, asks again for something else. "Approving
    // signs this once. It does not let the site sign anything else." is on the
    // screen the user just used, so a second envelope must reach a second
    // approval rather than a signature.
    const second = siteEnvelope(owner, [Operation.accountMerge({ destination: owner })], {
      sequence: "8675310",
    });
    await requestSignature(site.page, second.toXDR());

    const parked = await askWorker<{ id: string; summary: { effects: string[] } } | null>(
      wallet.page,
      { type: "pendingDappRequest" },
    );
    expect(parked, "the second request signed itself instead of parking").not.toBeNull();
    expect(parked!.summary.effects.join(" ")).toMatch(/DESTROY this account/);

    // and refusing it returns a refusal, not bytes.
    await showApproval(wallet);
    await wallet.page.getByRole("button", { name: "Reject" }).click();
    const refused = await signatureResult(site.page);
    expect(refused.signedTxXdr, "a rejected request still handed over a signature").toBeUndefined();
    expect(refused.error?.message).toMatch(/declined/i);
  } finally {
    await site.close();
  }
});

/**
 * DEFECT R3-1. left failing on purpose; `test.fail()` records that it is known,
 * and the run goes red the moment somebody fixes it without removing this line.
 *
 * describe-tx.ts states the rule in its own header: "if this module cannot say
 * what a transaction does, the approval screen says so and the Approve button
 * does not appear". its switch covers eight operation types; every other one
 * falls through to `${n} ${op.type}`, with decoded: true and no warning, so the
 * screen offers Approve above a line that is nothing but an operation name. a
 * claimable balance for the whole account balance reads "1.
 * createClaimableBalance", with no amount and no beneficiary, and the site gets
 * a valid signature for it.
 */
test("an operation the wallet cannot describe is never offered for approval [DEFECT R3-1]", async ({
  harness,
  wallet,
}) => {
  test.fail();
  test.setTimeout(6 * 60_000);
  await wallet.createWallet(PASSWORD);
  const owner = await wallet.revealAddress();
  const site = await connectedSite(harness.context, wallet.page);
  try {
    const attacker = Keypair.random().publicKey();
    const envelope = siteEnvelope(owner, [
      Operation.createClaimableBalance({
        asset: Asset.native(),
        amount: "9500.0000000",
        claimants: [new Claimant(attacker, Claimant.predicateUnconditional())],
      }),
    ]);
    await requestSignature(site.page, envelope.toXDR());
    await showApproval(wallet);

    const effects = (await wallet.page.getByRole("listitem").allInnerTexts()).join(" ");
    const approve = wallet.page.getByRole("button", { name: "Approve" });
    if ((await approve.count()) === 0) {
      await expect(wallet.page.getByText(/could not read|will not offer to sign/i)).toBeVisible();
      return;
    }

    // the evidence is gathered BEFORE the property is asserted, so the failure
    // reports what the wallet actually did rather than only what it failed to
    // print: a signature over an operation that never reached the screen.
    await approve.click();
    const result = await signatureResult(site.page);
    const signed = decode(result.signedTxXdr!);
    const op = signed.operations[0] as { type: string; amount: string };
    expect(op.type).toBe("createClaimableBalance");
    expect(op.amount).toBe("9500.0000000");
    expect(unsigned(result.signedTxXdr!)).toBe(envelope.toXDR());

    expect(
      effects,
      `the wallet signed a ${op.amount} XLM claimable balance for ${attacker} ` +
        `after showing only "${effects}"`,
    ).toContain("9500");
    expect(effects, "the beneficiary is not on the screen").toContain(attacker);
  } finally {
    await site.close();
  }
});

/**
 * DEFECT R3-2. same convention as R3-1.
 *
 * describeOperation prints `op.asset.getCode()` for anything non-native, and a
 * code is up to twelve characters its issuer chooses. an asset called XLM
 * issued by a stranger therefore renders in exactly the words native XLM does,
 * and the issuer -- the only thing that tells them apart -- never reaches the
 * screen. the wallet's own review has the same shape: `assetCode` with no
 * issuer beside it.
 */
test("a payment of a look-alike asset is not shown as if it were XLM [DEFECT R3-2]", async ({
  harness,
  wallet,
}) => {
  test.fail();
  test.setTimeout(6 * 60_000);
  await wallet.createWallet(PASSWORD);
  const owner = await wallet.revealAddress();
  const site = await connectedSite(harness.context, wallet.page);
  try {
    const issuer = Keypair.random().publicKey();
    const envelope = siteEnvelope(owner, [
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: new Asset("XLM", issuer),
        amount: "100.0000000",
      }),
    ]);
    await requestSignature(site.page, envelope.toXDR());
    await showApproval(wallet);

    const effects = (await wallet.page.getByRole("listitem").allInnerTexts()).join(" ");
    // it decoded, so this is not a refusal: the screen is describing an issued
    // asset in the words it uses for the native one.
    expect(effects).toMatch(/^1\. Send 100\.0000000 XLM to G/);
    expect(
      effects,
      "an issued asset is described in the same words as native XLM, with nothing on screen to tell them apart",
    ).toContain(issuer);
  } finally {
    await site.close();
  }
});

// ============================================================= the private pocket

/**
 * DEFECT R3-3. same convention as R3-1.
 *
 * every private-pocket review states its fee as `formatAmount(BigInt(tx.fee))`
 * of the envelope as BUILT, which for a Soroban invocation is the classic base
 * fee alone. `signAndSubmit` then calls `prepareTransaction`, and simulation
 * rewrites the envelope with its footprint, its auth entries and a fee that
 * includes the resource fee -- controller.ts says so in its own comment, three
 * lines below the call. what is signed and charged is therefore not the fee the
 * user approved, on all five private operations.
 */
test("the fee a private-pocket review states is the fee that gets signed [DEFECT R3-3]", async ({
  harness,
  wallet,
}) => {
  test.fail();
  test.setTimeout(14 * 60_000);
  const sent = await captureSubmissions(harness.context);

  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openPrivatePocket();
  await wallet.openMove();

  const setUp = wallet.page.getByRole("button", { name: "Set up the private pocket" });
  await expect(setUp).toBeVisible({ timeout: WAITS.ledgerRead });
  await setUp.click();
  // the review is for the SECOND transaction; the first went out on the press,
  // which the sheet says above the button.
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  // the fee is its own row now (the effect enumeration moved into the tip).
  const feeShown = (
    await wallet.page
      .getByText("Network fee", { exact: true })
      .locator("xpath=following-sibling::*[1]")
      .innerText()
  ).replace(/[^\d.]/g, "");
  expect(feeShown, "no fee on the review").toBeTruthy();

  const before = sent.length;
  await wallet.page.getByRole("button", { name: "Approve" }).click();
  await expect(wallet.receipt()).toBeVisible({ timeout: WAITS.submission });
  const hash = await wallet.readHash();

  // identified by hash rather than by position: a contended registration is
  // retried, and picking "the last one" would sometimes pick an attempt that
  // never landed.
  const signedEnvelope = sent
    .slice(before)
    .map(decode)
    .find((tx) => tx.hash().toString("hex") === hash);
  expect(signedEnvelope, "nothing on the wire matches the hash on the receipt").toBeTruthy();

  // the operation is the one the effects described, on the deployment this
  // build claims to use, for this account.
  const op = signedEnvelope!.operations[0] as { type: string; func: xdr.HostFunction };
  expect(op.type).toBe("invokeHostFunction");
  const call = op.func.invokeContract();
  expect(Address.fromScAddress(call.contractAddress()).toString()).toBe(DEPLOYMENT.token);
  expect(call.functionName().toString()).toBe("register");
  expect(Address.fromScVal(call.args()[0]!).toString()).toBe(address);

  // and the fee. this is the field that moved.
  expect(
    signedEnvelope!.fee,
    `the review said ${feeShown} XLM and the envelope signed carries ` +
      `${(Number(signedEnvelope!.fee) / 1e7).toFixed(7)} XLM`,
  ).toBe(stroops(feeShown!).toString());
});
