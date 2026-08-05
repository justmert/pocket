// The longest wait in the product, and what the user looks at during it.
//
// A confidential operation runs real, distinguishable phases: derive the keys,
// build the witness, prove in the offscreen document, simulate, sign, submit,
// then poll the ledger until the transaction reaches a terminal outcome. Every
// one of those is a separate several-hundred-millisecond to several-second step
// and the wallet knows exactly which one it is in.
//
// What the user gets is one spinner and one sentence for all of it.
//
// These tests do not ask for a progress bar, and a fake one would be worse than
// what is there: a bar that advances on a timer is a lie about a proof whose
// duration nobody knows in advance. What they ask is narrower and answerable:
//
//   1. is feedback PRESENT the whole way, with no dead moment?
//   2. is it CONTINUOUS, or does the screen sit unchanged for seconds?
//   3. is it HONEST, or does it name a phase that finished ages ago?
//
// The bounds are in `_test/T9.md` with the measured value beside each.
import { test, expect } from "../support/fixtures";
import { WAITS, openMoveAction } from "../support/wallet";
import * as ledger from "../support/testnet";
import { installProbe, arm, disarm, read, now, screens, longestStaticMs, WATCH, at } from "./probe";

const PASSWORD = "a-strong-test-password";

/**
 * How long the screen may say exactly the same thing.
 *
 * Three seconds of a completely unchanged screen is the point where a spinner
 * stops meaning "working" and starts meaning "maybe hung". The product's own
 * dependency puts a floor under the comparison: a Stellar ledger closes about
 * every five seconds, so a confirmation wait is at least one close, and the
 * wallet has more than enough time to say something new inside it.
 *
 * Measured on this build: 8,000ms for the build-and-prove wait and 3,702ms for
 * the sign-submit-confirm wait, both with zero informational change.
 */
const MAX_STATIC_MS = 3_000;

/**
 * Every named wait this product can show, spelled exactly as the user reads it.
 *
 * The whole list rather than a loose pattern, because a loose one would match
 * the ordinary prose on these screens and the assertion would pass on a screen
 * that had gone silent.
 */
const PROGRESS = new RegExp(
  [
    "Starting",
    "Reading the ledger",
    "Prepare",
    "Proving\\. This takes a moment…",
    "Setting up\\. This takes a moment…",
    "Signing and submitting…",
    "Signing and submitting, then waiting for the ledger…",
    "Submit",
    "Checking the ledger…",
    "Checking",
    "Reactivating…",
    // the line the progress shows for the stretches where the worker names no
    // phase of its own. it is the operation's own description, not a guess.
    "Signing and submitting, then waiting for the ledger to confirm\\.",
    "Checking this against the ledger\\.",
    // The WORKER's phases. None of them were here, so this list could only ever
    // see the static labels the popup sets before its first phase poll comes
    // back, and "no label mentioned the ledger" was partly a statement about
    // this array. They are the strings `controller.setPhase` actually passes.
    "Checking this deployment's verification key…",
    "Loading the circuit…",
    "Registering your auditor key…",
    "Building and proving\\. This is the slow part…",
    "Simulating against the ledger…",
    "Signing…",
    "Submitting, then waiting for the ledger to confirm…",
    "Deposit confirmed\\. Making it spendable, one more transaction…",
  ].join("|"),
);

async function fundedWallet(wallet: import("../support/wallet").Wallet): Promise<string> {
  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);
  await wallet.page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  return address;
}

test("the wallet never goes quiet during a private operation: something is always named", async ({
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  // The window is bounded by MARKS rather than by the test's own clock. Armed
  // before the click and trimmed by hand, this test went red once in a batch
  // run and green alone: a 100ms sample had landed between arming and the
  // button press, so the screen it caught was the one before the wait started.
  // That is a defect in the test, not in the wallet, and the fix is to ask the
  // page when the wait began instead of guessing.
  await installProbe(wallet.page, {
    ...WATCH,
    busy: "Building",
    review: "What this does",
  });
  await fundedWallet(wallet);

  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  await arm(wallet.page);
  await openMoveAction(wallet.page, "Set up the private pocket");
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
  const build = await read(wallet.page);
  await disarm(wallet.page);

  // One sampling interval of slack at the closing edge: a mark is stamped by a
  // rAF and a sample by an interval, so the two disagree by up to a frame about
  // exactly when the review screen replaced the wait.
  const from = at(build, "busy");
  const to = at(build, "review") - 120;
  const waiting = screens(build.samples.filter((s) => s.t >= from && s.t <= to));

  expect(to - from, "there must be a wait to inspect").toBeGreaterThan(500);
  expect(waiting.length, "the wait must have been sampled").toBeGreaterThan(0);
  for (const s of waiting) {
    expect(
      s.text,
      `the screen said nothing about being busy for ${Math.round(s.to - s.from)}ms`,
    ).toMatch(PROGRESS);
  }
});

test("the short wait the wallet already has does not leave the screen unchanged for seconds", async ({
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  // The control for the two tests below. Creating the vault is a real wait with
  // real work behind it (scrypt, in the worker) under a single static label,
  // and it comes in comfortably under the bound. Without this, a bound nothing
  // in the product can meet would be indistinguishable from a bound set too
  // tight to be met by anything.
  await installProbe(wallet.page, {
    ...WATCH,
    creating: "Creating",
    backup: "Save your recovery phrase",
  });
  await wallet.page.bringToFront();
  await wallet.page.reload();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });

  await arm(wallet.page);
  await wallet.page.getByRole("button", { name: "Create a new wallet" }).click();
  await wallet.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await wallet.page.getByLabel("Confirm password").fill(PASSWORD);
  await wallet.page.getByRole("button", { name: "Create wallet" }).click();
  await expect(wallet.page.getByText("Save your recovery phrase")).toBeVisible({
    timeout: WAITS.onboarding,
  });
  const p = await read(wallet.page);
  await disarm(wallet.page);

  const from = at(p, "creating");
  const to = at(p, "backup") - 120;
  const during = p.samples.filter((s) => s.t >= from && s.t <= to);
  expect(to - from, "there must be a wait to inspect").toBeGreaterThan(300);
  expect(during.length, "the wait must have been sampled").toBeGreaterThan(1);
  console.log(
    `  vault creation ${(to - from).toFixed(0)}ms, longest unchanged screen ${longestStaticMs(during).toFixed(0)}ms`,
  );
  expect(
    longestStaticMs(during),
    "scrypt under one static label still resolves inside the bound",
  ).toBeLessThan(MAX_STATIC_MS);
});

test("the build-and-prove wait does not leave the screen unchanged for seconds", async ({
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  await installProbe(wallet.page);
  await fundedWallet(wallet);

  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  await arm(wallet.page);
  const t0 = await now(wallet.page);
  await openMoveAction(wallet.page, "Set up the private pocket");
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });
  const t1 = await now(wallet.page);
  const p = await read(wallet.page);
  await disarm(wallet.page);

  // The premise, asserted rather than assumed: this really is a long wait, so
  // the assertion below is about a wait a user sits through and not about a
  // flicker. Registering derives keys, builds a witness, proves in the
  // offscreen document and simulates against live RPC.
  expect(t1 - t0, "this is supposed to be the slow path").toBeGreaterThan(1_000);

  console.log(
    `  build+prove ${(t1 - t0).toFixed(0)}ms, longest unchanged screen ${longestStaticMs(p.samples).toFixed(0)}ms, ${screens(p.samples).length} distinct screen(s)`,
  );
  expect(
    longestStaticMs(p.samples),
    "the user watched an unchanging screen while the wallet ran several distinct phases",
  ).toBeLessThan(MAX_STATIC_MS);
});

test("the wait after Approve does not leave the screen unchanged for seconds", async ({
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  await installProbe(wallet.page);
  await fundedWallet(wallet);

  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await openMoveAction(wallet.page, "Set up the private pocket");
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  await arm(wallet.page);
  const t0 = await now(wallet.page);
  await wallet.page.getByRole("button", { name: "Approve" }).click();
  await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
    timeout: WAITS.submission,
  });
  const t1 = await now(wallet.page);
  const p = await read(wallet.page);
  await disarm(wallet.page);

  expect(
    t1 - t0,
    "simulate, sign, submit and confirm cannot beat one ledger close",
  ).toBeGreaterThan(1_000);
  console.log(
    `  approve to receipt ${(t1 - t0).toFixed(0)}ms, longest unchanged screen ${longestStaticMs(p.samples).toFixed(0)}ms, ${screens(p.samples).length} distinct screen(s)`,
  );
  expect(
    longestStaticMs(p.samples),
    "signing, submitting and waiting for the ledger are three phases under one unchanging line",
  ).toBeLessThan(MAX_STATIC_MS);
});

test("the wait after Approve says the wallet is waiting for the ledger", async ({ wallet }) => {
  test.setTimeout(10 * 60_000);
  await installProbe(wallet.page);
  await fundedWallet(wallet);

  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await openMoveAction(wallet.page, "Set up the private pocket");
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  await arm(wallet.page);
  await wallet.page.getByRole("button", { name: "Approve" }).click();
  await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
    timeout: WAITS.submission,
  });
  const p = await read(wallet.page);
  await disarm(wallet.page);

  // Most of this wait is polling for the transaction's outcome, not signing and
  // not submitting. The bar is the product's own: `Send` spends the same phase
  // saying "Submit", and the test below proves
  // that bar is met somewhere, so this is not an invented standard.
  //
  // The assertion is on the WAIT LABEL, not on the screen containing it, and
  // that distinction was not academic. Written as "some screen during this wait
  // mentions the ledger" this test went green, because the success notice reads
  // "Confirmed in ledger." and lands while `busy` is still set. It was
  // passing on the receipt for the wait it was supposed to be judging.
  const labels = new Set<string>();
  for (const s of screens(p.samples)) {
    for (const m of s.text.matchAll(new RegExp(PROGRESS.source, "g"))) labels.add(m[0]);
  }
  console.log(`  labels during the approve wait: ${[...labels].join(" | ")}`);

  expect(labels.size, "the wait must have been named at all").toBeGreaterThan(0);
  expect(
    [...labels].some((l) => /ledger/i.test(l)),
    "the longest phase of this wait is a ledger poll and no label ever mentions it",
  ).toBe(true);
});

test("the build wait does not sign and submit while it says it is only setting up", async ({
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  // Found by measuring, not by reading: the same register build took 4,824ms in
  // one run and 17,483ms in another. Nothing about proving varies by 3.6x, so
  // something else was happening behind that sentence.
  //
  // `ownAuditorId` signs, submits and confirms a `register_auditor` transaction
  // inside `buildPrivateOp`, before the review screen exists. Horizon is the
  // oracle here, not the wallet: the question is what actually reached the
  // ledger.
  //
  // The finding was real; the remedy this test originally demanded was not
  // available. It asserted that NOTHING is paid before the review screen, which
  // would require registering the auditor key after approval. That ordering is
  // impossible: the registry ALLOCATES the id and returns it, the id is not
  // chosen by the caller, and the account-creation proof commits to it. The id
  // cannot be known until the registration has landed.
  //
  // So the property changed to the one that is both true and worth having: the
  // first transaction is DISCLOSED before the button that sends it, and the
  // second is still governed by the review screen. Consent before the spend,
  // which is what the original assertion was reaching for.
  await installProbe(wallet.page);
  const address = await fundedWallet(wallet);

  await wallet.openPrivatePocket();
  await expect(wallet.page.getByText("Private pocket not set up")).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // the disclosure lives with the button, and the button lives in the move
  // sheet, so the sheet is what has to be open for either to be judged.
  await wallet.openMove();

  // Before the press, on the same screen as the button, in words that say a
  // transaction is sent and a fee is paid. Anything vaguer is not consent.
  await expect(
    wallet.page.getByText(/TWO transactions/),
    "the screen must say setting up takes two transactions",
  ).toBeVisible();
  await expect(
    wallet.page.getByText(/sends the first one straight away/),
    "the screen must say the first transaction goes on the press, not on approval",
  ).toBeVisible();
  await expect(
    wallet.page.getByText(/pays a network fee/),
    "the screen must say the press costs money",
  ).toBeVisible();

  const paidFor = async () =>
    ledger.feesPaidBy(address, await ledger.transactions(address, 100)).toFixed(7);
  const before = await paidFor();

  await openMoveAction(wallet.page, "Set up the private pocket");
  await expect(wallet.page.getByText(/Building/)).toBeVisible();
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  // The review screen is up and nothing has been approved. Give Horizon time to
  // catch up, so the reading is what actually landed rather than what it had
  // noticed so far.
  let after = before;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && after === before) {
    after = await paidFor();
  }
  console.log(`  fees paid before the review screen: ${before} -> ${after} XLM`);

  // The property, and NOT a transaction count. Counting reached 2 on a run where
  // the registry counter contended: a losing registration is included, charges a
  // fee and is retried, which is documented behaviour and not a second thing
  // being done behind the user's back. Counting would have called that a
  // consent failure, and a test that cries wolf on legitimate contention gets
  // switched off.
  //
  // What must be true is that the transaction the review screen is ASKING ABOUT
  // has not already happened. The confidential account is what Approve creates,
  // so until Approve is pressed the chain must still say there is none.
  const state = await wallet.page.evaluate(
    () =>
      new Promise((resolve) =>
        chrome.runtime.sendMessage({ type: "privatePocket" }, (r: unknown) => resolve(r)),
      ),
  );
  expect(
    (state as { data?: { state?: string } })?.data?.state,
    "the account the review screen asks you to approve had already been created",
  ).toBe("unregistered");
});

test("the public send build wait signs and submits nothing, which is the bar", async ({
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  // The green counterpart to the test above, and the reason its red means
  // something. `buildPayment` reads and simulates and then stops, so pressing
  // Review costs nothing and the confirm screen is the first commitment. Same
  // assertion, same oracle, opposite verdict.
  const address = await fundedWallet(wallet);
  const { Keypair } = await import("@stellar/stellar-sdk/base");
  const to = Keypair.random().publicKey();
  await ledger.fund(to);

  const paidFor = async () =>
    ledger.feesPaidBy(address, await ledger.transactions(address, 100)).toFixed(7);
  const before = await paidFor();

  await wallet.openSend();
  await wallet.composePayment({ to, amount: "1" });
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  let after = before;
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline && after === before) {
    after = await paidFor();
  }
  console.log(`  fees paid before the public confirm screen: ${before} -> ${after} XLM`);

  expect(after, "building a public payment must not cost anything").toBe(before);
});

test("the public send wait does say it is waiting for the ledger", async ({ wallet }) => {
  test.setTimeout(10 * 60_000);
  await installProbe(wallet.page);
  await fundedWallet(wallet);

  // A real, funded recipient. A payment to an account the ledger has never seen
  // fails at simulation, and this test needs the SUBMIT wait, not an error.
  const { Keypair } = await import("@stellar/stellar-sdk/base");
  const to = Keypair.random().publicKey();
  await ledger.fund(to);

  await wallet.openSend();
  await wallet.composePayment({ to, amount: "1" });
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  await arm(wallet.page);
  await wallet.page.getByRole("button", { name: "Confirm" }).click();
  await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
    timeout: WAITS.submission,
  });
  const p = await read(wallet.page);
  await disarm(wallet.page);

  const said = screens(p.samples).map((s) => s.text);
  expect(
    said.some((t) => /ledger/i.test(t)),
    "the public send flow already names the ledger poll: this is the bar, met",
  ).toBe(true);
});

test("the public send wait does not leave the screen unchanged for seconds either", async ({
  wallet,
}) => {
  test.setTimeout(10 * 60_000);
  // Here so the scope of the finding is not misread. The unchanging-screen
  // problem is not a private-pocket problem: the public send has the same one,
  // with a better-worded label in front of it. Splitting it out keeps the
  // WORDING test above green, because that half of the product genuinely is
  // right and lumping the two together would hide it.
  await installProbe(wallet.page);
  await fundedWallet(wallet);

  const { Keypair } = await import("@stellar/stellar-sdk/base");
  const to = Keypair.random().publicKey();
  await ledger.fund(to);

  await wallet.openSend();
  await wallet.composePayment({ to, amount: "1" });
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  await arm(wallet.page);
  const t0 = await now(wallet.page);
  await wallet.page.getByRole("button", { name: "Confirm" }).click();
  await expect(wallet.page.getByText("Transaction successful")).toBeVisible({
    timeout: WAITS.submission,
  });
  const t1 = await now(wallet.page);
  const p = await read(wallet.page);
  await disarm(wallet.page);

  console.log(
    `  public send confirm ${(t1 - t0).toFixed(0)}ms, longest unchanged screen ${longestStaticMs(p.samples).toFixed(0)}ms`,
  );
  expect(t1 - t0, "submit and confirm cannot beat one ledger close").toBeGreaterThan(1_000);
  expect(
    longestStaticMs(p.samples),
    "the public send has the same unchanging screen, under a better sentence",
  ).toBeLessThan(MAX_STATIC_MS);
});
