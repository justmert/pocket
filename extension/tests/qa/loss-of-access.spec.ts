// Losing access: the phrase, the record on the device, and the money that
// outlives both.
//
// Three risks meet in this file and they are one story. R1: a shipped build has
// NO archive, so the openings that make a confidential commitment spendable
// cannot be replayed once RPC has aged the events out, and the funds are
// visible on chain forever and spendable by nobody. R11: every stored structure
// has to be readable by the code that wrote it or refused outright, because a
// half-loaded vault is the same loss with a different cause. R12: value that has
// arrived and not been merged is not spendable, and if merge cannot be built or
// silently no-ops it is the same loss again.
//
// The premise, established from the ARTEFACT rather than from the source: this
// build carries `archiveUrl: void 0`. `wxt build` does not load
// `.env.development`, which is the only file that sets VITE_ARCHIVE_URL, so the
// package a user installs cannot replay anything. Every honesty assertion below
// is conditioned on that fact being true of the build under test, and the first
// test fails loudly if it stops being true rather than quietly checking the
// wrong wallet.
//
// Nothing here mocks wallet code. The confidential account that several tests
// need cannot be created offline (registering costs two real transactions and a
// proof), so it is presented at the NETWORK boundary: one fabricated
// `confidential_balance` simulation, and everything else the wallet asks for is
// answered by the real testnet it is already pointed at. That is the same rule
// tests/support/stub.ts states: intercept HTTP on its way out, never reach into
// core/.
import { test, expect, askWorker, Wallet } from "../support/fixtures";
import type { BrowserContext, Page } from "@playwright/test";
import { launchWallet, EXTENSION_PATH } from "../support/extension";
import { WAITS } from "../support/wallet";
import { intercept, RPC_HOST } from "../support/stub";
import * as ledger from "../support/testnet";
import {
  ADDRESS_KEY,
  IDENTITY,
  OPENINGS_PREFIX,
  STATE_KEY,
  VAULT_KEY,
  addressFromMnemonic,
  commitmentOf,
  inspect,
  openSealed,
  openingKeyFor,
  storage,
  unwrapDek,
  type Point,
  type Sealed,
  type VaultHeader,
} from "../integrity/oracle";
import { xdr } from "@stellar/stellar-sdk/base";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const PASSWORD = "a-strong-test-password";

// ---------------------------------------------------------------- the artefact

/** Every javascript file in the built package, read as text. */
function bundleFiles(): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) out.push({ name: full, text: readFileSync(full, "utf8") });
    }
  };
  walk(EXTENSION_PATH);
  return out;
}

// ------------------------------------------------------------------- storage

/**
 * chrome.storage.local, read and written through the SERVICE WORKER.
 *
 * The worker is the only context that writes these keys in production, so
 * planting damage from there is planting it where it would actually appear.
 * The popup's own store is the same one, which is what makes the reopen
 * afterwards a real test rather than a test of two separate caches.
 */
async function workerStorage(page: Page, ctx: BrowserContext): Promise<Record<string, unknown>> {
  const [worker] = ctx.serviceWorkers();
  if (!worker) return storage(page);
  const raw = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  return JSON.parse(raw) as Record<string, unknown>;
}

async function plant(ctx: BrowserContext, items: Record<string, unknown>): Promise<void> {
  const [worker] = ctx.serviceWorkers();
  if (!worker) throw new Error("no service worker to plant storage through");
  await worker.evaluate(async (raw) => {
    await chrome.storage.local.set(JSON.parse(raw) as Record<string, unknown>);
  }, JSON.stringify(items));
}

async function drop(ctx: BrowserContext, keys: string[]): Promise<void> {
  const [worker] = ctx.serviceWorkers();
  if (!worker) throw new Error("no service worker to drop storage through");
  await worker.evaluate(async (k) => {
    await chrome.storage.local.remove(k);
  }, keys);
}

/** Ask the worker, treating a refusal as an answer rather than a throw. */
async function tryAsk(
  page: Page,
  msg: unknown,
): Promise<{ ok?: boolean; data?: unknown; error?: string }> {
  return page.evaluate(
    (m) =>
      new Promise<{ ok?: boolean; data?: unknown; error?: string }>((res) => {
        chrome.runtime.sendMessage(m, (reply) => {
          const err = chrome.runtime.lastError;
          res(reply ?? { ok: false, error: err?.message ?? "no response" });
        });
      }),
    msg,
  );
}

/**
 * Seal a payload the way the vault does, from the password alone.
 *
 * Written out rather than imported for the same reason the oracle is: a planted
 * record produced by the wallet's own sealer would agree with the wallet's own
 * reader no matter how wrong both were. The AAD string and the schema version
 * are read back off a blob the wallet really wrote, so a schema change breaks
 * this loudly instead of planting something the wallet quietly ignores.
 */
async function sealLikeVault(dek: Uint8Array, value: unknown, v: number): Promise<Sealed> {
  const key = await crypto.subtle.importKey("raw", dek as unknown as ArrayBuffer, "AES-GCM", false, [
    "encrypt",
  ]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: iv as unknown as ArrayBuffer,
      additionalData: new TextEncoder().encode(`pocket.payload.v${v}`) as unknown as ArrayBuffer,
    },
    key,
    new TextEncoder().encode(JSON.stringify(value)) as unknown as ArrayBuffer,
  );
  return {
    v,
    iv: Buffer.from(iv).toString("base64"),
    ct: Buffer.from(new Uint8Array(ct)).toString("base64"),
  };
}

/** Flip one bit in a base64 payload, leaving its length and shape intact. */
function flipOneBit(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  const at = Math.floor(bytes.length / 2);
  bytes[at] = (bytes[at] ?? 0) ^ 0x01;
  return bytes.toString("base64");
}

/** Cut a base64 payload in half, which is what a partial write leaves behind. */
function truncate(b64: string): string {
  const bytes = Buffer.from(b64, "base64");
  return bytes.subarray(0, Math.floor(bytes.length / 2)).toString("base64");
}

// -------------------------------------------------------------- the fake chain

const FAKE_LEDGER = 900_000;

/** A 64-byte uncompressed affine point, as the contract returns one. */
function pointScVal(p: Point): xdr.ScVal {
  const bytes = Buffer.alloc(64);
  const write = (v: bigint, off: number): void => {
    for (let i = 31; i >= 0; i--) {
      bytes[off + i] = Number(v & 0xffn);
      v >>= 8n;
    }
  };
  write(p.x, 0);
  write(p.y, 32);
  return xdr.ScVal.scvBytes(bytes);
}

/**
 * The ScMap `confidential_balance` returns: a #[contracttype] struct, rendered
 * by the host as a map with sorted Symbol keys.
 */
function confidentialAccountScVal(a: {
  auditorId: number;
  spendable: Point;
  receiving: Point;
}): string {
  const field = (name: string, val: xdr.ScVal) =>
    new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(name), val });
  return xdr.ScVal
    .scvMap([
      field("auditor_id", xdr.ScVal.scvU32(a.auditorId)),
      field("receiving_commitment", pointScVal(a.receiving)),
      field("spendable_commitment", pointScVal(a.spendable)),
      // the wallet does not check these two against its own derivation on a
      // read, and no test below spends, so the identity is enough to satisfy
      // the decoder without pretending to be a key anyone holds.
      field("spending_public_key", pointScVal(IDENTITY)),
      field("viewing_public_key", pointScVal(IDENTITY)),
    ])
    .toXDR("base64");
}

/**
 * Present a registered confidential account to the wallet, and nothing else.
 *
 * Only two of the RPC's methods are answered here. `confidential_balance` is
 * fabricated because a real one costs two submitted transactions and a proof,
 * which no offline test can produce; `getEvents` is answered empty so the
 * inbound scan is a bounded, deterministic no-op instead of forty pages of
 * somebody else's history. Every other method the wallet asks for goes to the
 * testnet it is really pointed at, so the account, its balance and its
 * sequence number are all genuine.
 *
 * Submissions are switched off through the handle this returns rather than by
 * installing a second route: playwright resolves routes newest-first, so a
 * second one for the same host silently replaces this whole account and the
 * test carries on measuring an unregistered wallet.
 */
async function presentConfidentialAccount(
  ctx: BrowserContext,
  account: { auditorId: number; spendable: Point; receiving: Point } | null,
): Promise<{ breakSubmission(): void }> {
  const retval = account ? confidentialAccountScVal(account) : null;
  let submissionsBroken = false;
  await intercept(ctx, RPC_HOST, async (route) => {
    let body: unknown = null;
    try {
      body = route.request().postDataJSON();
    } catch {
      body = null;
    }
    const calls = (Array.isArray(body) ? body : [body]) as ({
      id?: unknown;
      method?: string;
      params?: { transaction?: string };
    } | null)[];

    if (submissionsBroken && calls.some((c) => c?.method === "sendTransaction")) {
      await route.abort("connectionfailed");
      return;
    }

    const answers = calls.map((c) => {
      const id = c?.id ?? 1;
      if (c?.method === "getEvents") {
        // no cursor, so `findInbound` stops after one page rather than paging.
        return { jsonrpc: "2.0", id, result: { events: [], latestLedger: FAKE_LEDGER, oldestLedger: 1 } };
      }
      if (c?.method === "simulateTransaction") {
        const tx = c.params?.transaction ?? "";
        // the invoked symbol is stored as raw ascii inside the envelope, so
        // this identifies the call without decoding the whole thing. any other
        // simulation is somebody else's and must not be answered from here.
        if (!Buffer.from(tx, "base64").includes("confidential_balance")) return null;
        if (retval === null) {
          // 3501 is AccountNotRegistered, which the wallet reads as "no private
          // pocket" rather than as a failure.
          return {
            jsonrpc: "2.0",
            id,
            result: {
              latestLedger: FAKE_LEDGER,
              error: "HostError: Error(Contract, #3501)",
              events: [],
            },
          };
        }
        return {
          jsonrpc: "2.0",
          id,
          result: {
            latestLedger: FAKE_LEDGER,
            minResourceFee: "100",
            transactionData: "",
            events: [],
            results: [{ auth: [], xdr: retval }],
          },
        };
      }
      return null;
    });

    if (answers.some((a) => a === null)) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(Array.isArray(body) ? answers : answers[0]),
    });
  });
  return {
    breakSubmission() {
      submissionsBroken = true;
    },
  };
}

/** A funded wallet whose private pocket the fake chain is about to describe. */
async function fundedWallet(wallet: Wallet): Promise<{ phrase: string; address: string }> {
  const phrase = await wallet.createWallet(PASSWORD);
  const address = await wallet.revealAddress();
  await ledger.fund(address);
  return { phrase, address };
}

// =========================================================== R1: the premise

test("the build under test ships with no archive, so nothing can replay a history", async () => {
  // The premise of every honesty assertion below, taken from the package a user
  // would install rather than from `config.ts`. If a future build starts
  // shipping an archive, this goes red first and names why the rest of the file
  // is now checking the wrong wallet.
  const files = bundleFiles();
  const withConfig = files.filter((f) => f.text.includes("archiveUrl"));
  expect(withConfig.length, "the network config must reach the built package").toBeGreaterThan(0);

  for (const f of withConfig) {
    expect(
      f.text,
      `${f.name} carries an archive url, so this build is not the shipped no-archive variant`,
    ).toContain("archiveUrl:void 0");
  }

  // And the loopback address the development env file sets is nowhere in it:
  // baked into a package it points every user at their own machine.
  for (const f of files) {
    expect(f.text, `${f.name} carries a loopback archive address`).not.toContain("127.0.0.1:8787");
  }
});

// ================================================= R1: what the wallet says

test("both erase doors say the private balances cannot be rebuilt, in the same words", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);

  // The sentence a build with no archive is obliged to say. Read from the two
  // screens that reach the irreversible act, because the two used to disagree
  // and the softer wording was on the door more people reach.
  const CANNOT = /Rebuilding them needs a durable archive, and this build has none configured, so they cannot be rebuilt yet\./;

  await wallet.nav("Settings").click();
  await page.getByRole("button", { name: "Erase this wallet" }).click();
  const eraseSheet = page.getByRole("dialog", { name: "Erase this wallet" });
  await expect(eraseSheet).toBeVisible();
  await expect(eraseSheet.getByText(CANNOT), "the settings door must say it").toBeVisible();
  await wallet.close();

  // The other door, reached from the locked screen by a user who has forgotten
  // their password and is one press from destroying the only copy. The lock
  // control lives on home, so that is where this goes back to first.
  await wallet.nav("Home").click();
  await wallet.lock();
  await wallet.openRecover();
  await expect(page.getByText(CANNOT), "the forgotten-password door must say it too").toBeVisible();
});

test("a private pocket with no record on this device says the record cannot be rebuilt", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(6 * 60_000);
  await fundedWallet(wallet);
  await presentConfidentialAccount(harness.context, {
    auditorId: 1,
    spendable: IDENTITY,
    receiving: IDENTITY,
  });

  // This is R1 exactly: a registered confidential account, and a device holding
  // no openings for it. Reached here by presenting the account rather than by
  // waiting seven days for the events to age out, which is the same state.
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  const pocket = (await askWorker(harness.popup, { type: "privatePocket" })) as {
    state: string;
    message?: string;
    spendable?: string;
  };
  expect(pocket.state, "a registered account with no local openings needs rebuilding").toBe(
    "needsRecovery",
  );
  expect(pocket.message, "the state must say what is true of THIS build").toMatch(
    /this build has none configured, so they cannot be rebuilt yet/i,
  );
  // And it must not put a number next to that sentence. A figure here would be
  // a claim about money the wallet cannot move.
  expect(pocket.spendable, "an unreadable balance must not be rendered as a figure").toBeUndefined();
});

test("rebuildFromHistory refuses, names the archive, and writes nothing", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(6 * 60_000);
  await fundedWallet(wallet);
  await presentConfidentialAccount(harness.context, {
    auditorId: 1,
    spendable: IDENTITY,
    receiving: IDENTITY,
  });
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  const before = await workerStorage(harness.popup, harness.context);
  const answer = await tryAsk(harness.popup, { type: "rebuildFromHistory" });

  // Loud, not silent. The one outcome that must never happen is a resolved
  // reply carrying a plausible balance, because a wrong opening looks exactly
  // like a right one until the day it is spent.
  expect(answer.ok, "a rebuild with nothing to replay must not succeed").toBeFalsy();
  expect(answer.error, "the refusal must name the missing archive").toMatch(
    /needs a durable event history, and no archive is configured/i,
  );
  expect(answer.error, "the refusal must say the money is still there").toMatch(
    /funds are safe on chain/i,
  );
  expect(
    answer.error,
    "a specific refusal must not have been flattened into the generic one",
  ).not.toMatch(/Something went wrong/i);

  // And it must not have half-done it. An openings blob written from a failed
  // replay is the exact shape of the disaster: a number on screen for funds
  // that cannot move.
  const after = await workerStorage(harness.popup, harness.context);
  expect(
    Object.keys(after).filter((k) => k.startsWith(OPENINGS_PREFIX)),
    "a refused rebuild must not leave openings behind",
  ).toEqual([]);
  expect(Object.keys(after).sort(), "a refused rebuild must not write anything").toEqual(
    Object.keys(before).sort(),
  );
});

test("no screen offers a rebuild this build cannot perform", async ({ wallet, harness }) => {
  test.setTimeout(6 * 60_000);
  await fundedWallet(wallet);
  const page = wallet.page;

  // The rule, from the brief: no screen may offer an action that cannot
  // succeed. `rebuildFromHistory` cannot succeed in this build for any user in
  // any state, so a control that runs it is an offer the wallet cannot keep,
  // and the user pressing it is a user in the state where they are deciding
  // whether to panic.
  //
  // Every surface is walked before anything is asserted, so a red here is the
  // whole finding rather than the first half of it.
  const offers: string[] = [];

  // First on a wallet that has never had a private pocket at all, because
  // `privateAvailable` is only "this deployment has a confidential wrapper",
  // which is true of every testnet wallet. If the offer is there already it is
  // there for everybody, not only for the people it stranded.
  await wallet.nav("Settings").click();
  if ((await page.getByRole("button", { name: "Rebuild from history" }).count()) > 0) {
    offers.push("settings offers a rebuild to a wallet with no private pocket at all");
  }
  await wallet.nav("Home").click();

  await presentConfidentialAccount(harness.context, {
    auditorId: 1,
    spendable: IDENTITY,
    receiving: IDENTITY,
  });
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  await wallet.openPrivatePocket();
  await wallet.openMove();
  const card = page.getByRole("dialog", { name: "Move" });
  // the sheet renders a skeleton until the pocket's state arrives, and a count
  // taken before then would report "nothing offered" for a screen that is about
  // to offer something.
  await expect(card.getByText("Needs rebuilding"))
    .toBeVisible({ timeout: WAITS.ledgerRead })
    .catch(() => undefined);
  if ((await card.getByRole("button", { name: /Rebuild from history/i }).count()) > 0) {
    offers.push('the move sheet offers "Rebuild from history"');
  }
  // the same sheet states the opposite three lines above the button, which is
  // the part a user has to reconcile on their own.
  const moveSaid = await card.innerText();
  if (/cannot be rebuilt yet/i.test(moveSaid) && /Rebuild from history/i.test(moveSaid)) {
    offers.push("the move sheet says both that it cannot be rebuilt and that it can");
  }
  await wallet.close();

  await wallet.nav("Settings").click();
  const inSettings = page.getByRole("button", { name: "Rebuild from history" });
  if ((await inSettings.count()) > 0) {
    offers.push('settings lists "Rebuild from history: replay the ledger to recover balances"');
    await inSettings.click();
    const sheet = page.getByRole("dialog", { name: "Rebuild from history" });
    await expect(sheet).toBeVisible();
    if ((await sheet.getByRole("button", { name: /^Rebuild$/ }).count()) > 0) {
      offers.push('the rebuild sheet offers a "Rebuild" button');
    }
    // and what it says above that button, which describes a replay as the thing
    // that is about to happen rather than as something this build cannot do.
    if (/Replays your event history/i.test(await sheet.innerText())) {
      offers.push('the rebuild sheet says "Replays your event history"');
    }
  }

  expect(
    offers,
    "this build has no archive, so a rebuild cannot succeed for anyone. offered anyway by:\n  " +
      offers.join("\n  "),
  ).toEqual([]);
});

test("pressing rebuild reaches a refusal the user can read, and leaves the pocket as it was", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(6 * 60_000);
  await fundedWallet(wallet);
  await presentConfidentialAccount(harness.context, {
    auditorId: 1,
    spendable: IDENTITY,
    receiving: IDENTITY,
  });
  const page = wallet.page;
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  // The other half of the honesty question. Whatever the previous test decides
  // about whether the offer should exist, a user who takes it must land
  // somewhere true: a named reason, not a spinner that stops and not a success.
  await wallet.nav("Settings").click();
  await page.getByRole("button", { name: "Rebuild from history" }).click();
  const sheet = page.getByRole("dialog", { name: "Rebuild from history" });
  await expect(sheet).toBeVisible();
  await sheet.getByRole("button", { name: /^Rebuild$/ }).click();

  await expect(
    sheet.getByText(/no archive is configured for this network/i),
    "the screen must show the specific reason, not a generic failure",
  ).toBeVisible({ timeout: WAITS.ledgerRead });
  await expect(
    sheet.getByText("Rebuilt from history."),
    "nothing was rebuilt, so nothing may claim it was",
  ).toHaveCount(0);

  const after = await workerStorage(harness.popup, harness.context);
  expect(
    Object.keys(after).filter((k) => k.startsWith(OPENINGS_PREFIX)),
    "a refused rebuild must not leave openings behind",
  ).toEqual([]);
});

// ============================================ R1: the phrase on a clean device

test("the phrase alone reproduces the account on a clean device, and does not bring the private record with it", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(6 * 60_000);
  const phrase = await wallet.createWallet(PASSWORD);
  const shown = await wallet.revealAddress();

  // Derived here, from the phrase, by an implementation that shares no code
  // with the wallet. Trusting the wallet's own display for this would mean the
  // recovery assertion below is the wallet agreeing with itself.
  const derived = await addressFromMnemonic(phrase);
  expect(shown, "the address on screen must be the one the phrase owns").toBe(derived);

  const clean = await launchWallet();
  try {
    const page = await clean.popup;
    const second = new Wallet(page);
    await second.importPhrase(phrase, "a-different-password-entirely");
    expect(
      await second.revealAddress(),
      "the same phrase must reproduce the same account on a clean device",
    ).toBe(derived);

    const disk = await inspect(page, "a-different-password-entirely");
    expect(disk.mnemonic, "the restored device must hold the same phrase").toBe(phrase);
    expect(disk.storedAddress, "and record the same account").toBe(derived);

    // The half that R1 is about. The public pocket came back in full; the
    // private record did NOT, and cannot, because only the old device ever held
    // it. This assertion is what makes the copy on the erase screens a fact
    // rather than a caution.
    expect(
      disk.openings,
      "no opening can survive to a device that never held one",
    ).toBeNull();
    expect(
      Object.keys(disk.all).filter((k) => k.startsWith(OPENINGS_PREFIX)),
      "a restored device starts with no record of any confidential balance",
    ).toEqual([]);
  } finally {
    await clean.close();
  }
});

// ================================================= R11: damaged stored state

/**
 * Every way one stored record can arrive damaged.
 *
 * `damage` runs against a real wallet's real storage; `expect` states what the
 * wallet has to do next. The bar from the risk model is the same in every row:
 * readable by the code that wrote it, or refused cleanly. Never half-loaded,
 * and never silently re-onboarded, because the first thing an onboarding screen
 * offers is the button that destroys what is still there.
 */
const DAMAGE: {
  name: string;
  damage: (all: Record<string, unknown>) => Record<string, unknown>;
  drop?: string[];
}[] = [
  {
    name: "a vault header whose wrapped key was truncated by a partial write",
    damage: (all) => {
      const h = all[VAULT_KEY] as VaultHeader;
      return { [VAULT_KEY]: { ...h, wrap: { ...h.wrap, ct: truncate(h.wrap.ct) } } };
    },
  },
  {
    name: "a vault header with one flipped bit in its wrapped key",
    damage: (all) => {
      const h = all[VAULT_KEY] as VaultHeader;
      return { [VAULT_KEY]: { ...h, wrap: { ...h.wrap, ct: flipOneBit(h.wrap.ct) } } };
    },
  },
  {
    name: "a vault header that is not an object at all",
    damage: () => ({ [VAULT_KEY]: "corrupted" }),
  },
  {
    name: "a vault header claiming a schema version this build cannot read",
    damage: (all) => ({ [VAULT_KEY]: { ...(all[VAULT_KEY] as VaultHeader), v: 99 } }),
  },
  {
    name: "sealed state with one flipped bit",
    damage: (all) => {
      const s = all[STATE_KEY] as Sealed;
      return { [STATE_KEY]: { ...s, ct: flipOneBit(s.ct) } };
    },
  },
  {
    name: "sealed state truncated halfway",
    damage: (all) => {
      const s = all[STATE_KEY] as Sealed;
      return { [STATE_KEY]: { ...s, ct: truncate(s.ct) } };
    },
  },
  {
    name: "a vault with its state gone entirely",
    damage: () => ({}),
    drop: [STATE_KEY],
  },
];

for (const c of DAMAGE) {
  test(`${c.name} is refused rather than half-loaded`, async ({ wallet, harness }) => {
    test.setTimeout(5 * 60_000);
    await wallet.createWallet(PASSWORD);
    const before = await workerStorage(harness.popup, harness.context);

    await wallet.lock();
    if (c.drop) await drop(harness.context, c.drop);
    const patch = c.damage(before);
    if (Object.keys(patch).length > 0) await plant(harness.context, patch);

    // Reopened cold, so nothing is answered out of a heap that still remembers
    // the undamaged version.
    await wallet.reopen();

    // A damaged install must never present itself as a fresh device. The first
    // control on that screen creates a new wallet, and doing that over a vault
    // whose owner has funds is the destructive act this whole file is about.
    await expect(
      wallet.page.getByRole("button", { name: "Create a new wallet" }),
      "a damaged install must not offer to start over as if nothing were there",
    ).toHaveCount(0);

    const answer = await tryAsk(harness.popup, { type: "unlock", password: PASSWORD });
    expect(answer.ok, "a damaged record must not open").toBeFalsy();
    expect(typeof answer.error, "the refusal must carry a message").toBe("string");
    expect(
      (answer.error ?? "").length,
      "a refusal with an empty message is a refusal the user cannot act on",
    ).toBeGreaterThan(0);

    // Nothing half-loaded: no session, no address handed out, and the store is
    // exactly as damaged as the test left it rather than partly rewritten.
    const status = (await askWorker(harness.popup, { type: "status" })) as {
      locked: boolean;
      address?: string;
    };
    expect(status.locked, "a failed unlock must leave the wallet locked").toBe(true);
    expect(status.address, "a locked wallet must not hand out an address").toBeUndefined();

    const after = await workerStorage(harness.popup, harness.context);
    expect(
      Object.keys(after).sort(),
      "a refused unlock must not add or remove stored records",
    ).toEqual(Object.keys(before).filter((k) => !(c.drop ?? []).includes(k)).sort());
  });
}

test("a damaged openings record is refused, never read as a zero balance", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(6 * 60_000);
  const { address } = await fundedWallet(wallet);
  await presentConfidentialAccount(harness.context, {
    auditorId: 1,
    spendable: IDENTITY,
    receiving: IDENTITY,
  });

  // Plant an openings blob that is sealed under the right key and then damaged,
  // which is what a partial write or a bad sector leaves. The failure mode this
  // is looking for is the quiet one: a reader that swallows the error and shows
  // 0.0000000, which reads as "you have nothing" for money that is on chain.
  const disk = await inspect(harness.popup, PASSWORD);
  const sealed = await sealLikeVault(
    disk.dek,
    {
      spendable: { value: "0", randomness: "0" },
      receiving: { value: "0", randomness: "0" },
      syncedThrough: FAKE_LEDGER,
    },
    (disk.all[STATE_KEY] as Sealed).v,
  );
  await plant(harness.context, {
    [openingKeyFor(address)]: { ...sealed, ct: flipOneBit(sealed.ct) },
  });

  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  const answer = await tryAsk(harness.popup, { type: "privatePocket" });
  if (answer.ok) {
    const pocket = answer.data as { state: string; spendable?: string };
    expect(
      pocket.state,
      "an unreadable record must not be reported as a working pocket",
    ).not.toBe("ready");
    expect(
      pocket.spendable,
      "a record that cannot be opened must not produce a figure",
    ).toBeUndefined();
  } else {
    expect(
      (answer.error ?? "").length,
      "a refusal the user cannot read is not a refusal",
    ).toBeGreaterThan(0);
    expect(answer.error, "the refusal must not be a bare exception").not.toMatch(
      /^\[object|undefined$/,
    );
  }

  // And the damaged blob is still there. Deleting it would turn a recoverable
  // record into an unrecoverable one, which is the worst available response to
  // a read failure.
  const after = await workerStorage(harness.popup, harness.context);
  expect(
    Object.keys(after).filter((k) => k.startsWith(OPENINGS_PREFIX)),
    "a record that could not be read must not be thrown away",
  ).toHaveLength(1);
});

test("a stored address that no longer matches the vault is repaired by one unlock, not left to lock the user out", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(5 * 60_000);
  const phrase = await wallet.createWallet(PASSWORD);
  const real = await addressFromMnemonic(phrase);

  // `pocket.address` is what authorises erase-and-restore. Corrupted, it makes
  // the user's own phrase look like somebody else's, which locks the one door
  // out of a forgotten password.
  await wallet.lock();
  await plant(harness.context, {
    [ADDRESS_KEY]: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  });
  await wallet.reopen();

  const refused = await tryAsk(harness.popup, {
    type: "recoverFromMnemonic",
    mnemonic: phrase,
    password: "another-strong-password",
  });
  expect(refused.ok, "a phrase that does not match the recorded account must not erase it").toBeFalsy();

  // The documented repair: one unlock rewrites the address from the seed the
  // vault just yielded. Without it the corruption would be permanent.
  await wallet.unlock(PASSWORD);
  await wallet.waitForHome(WAITS.onboarding);
  const after = await workerStorage(harness.popup, harness.context);
  expect(after[ADDRESS_KEY], "one unlock must restore the recorded account").toBe(real);
});

test("a create that cannot finish writing does not leave a wallet that can neither be opened nor erased", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(5 * 60_000);
  const worker = await harness.worker();

  // Storage refusing one key is what an exhausted quota, a locked profile or a
  // disk error looks like from inside an extension. `pocket.state` is the third
  // and last of the three writes `installSeed` makes, so failing it produces
  // the exact half-install its own comment calls the dangerous one.
  await worker.evaluate(() => {
    const real = chrome.storage.local.set.bind(chrome.storage.local);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.storage.local as any).set = (items: Record<string, unknown>) => {
      if (Object.keys(items).includes("pocket.state")) {
        return Promise.reject(new Error("QUOTA_BYTES quota exceeded"));
      }
      return real(items);
    };
  });

  const answer = await tryAsk(harness.popup, { type: "create", password: PASSWORD });
  expect(answer.ok, "a create whose state write failed must not report success").toBeFalsy();

  // Now the question that matters: what is the user looking at, and can they
  // get out of it? A vault header with no state opens for nobody, and the
  // phrase was never shown, so if this install also refuses to be erased the
  // device is stuck holding a wallet that never existed.
  const all = await workerStorage(harness.popup, harness.context);
  const half = all[VAULT_KEY] !== undefined && all[STATE_KEY] === undefined;
  if (!half) {
    // Either nothing was installed or the wallet rolled the partial write back,
    // both of which are correct outcomes.
    expect(all[VAULT_KEY], "an install that did not finish must not leave a vault").toBeUndefined();
    return;
  }

  // A vault header with no state opens for nobody, and the phrase was never
  // drawn, so the user holds a device that thinks it has a wallet and has no
  // material that can prove ownership of it. Every documented route out is
  // tried, and the test states which of them worked, because "no way out" is
  // only a finding if all of them are shut.
  // a reload issued while the worker is restarting is reported by chrome as
  // ERR_FILE_NOT_FOUND, which is the platform racing rather than the wallet
  // answering. tests/support/ambient.ts already treats it as noise.
  await wallet.reopen().catch(() => wallet.reopen());
  const routes: string[] = [];

  const unlocked = await tryAsk(harness.popup, { type: "unlock", password: PASSWORD });
  if (unlocked.ok) routes.push("the password still unlocks it");

  const started = await tryAsk(harness.popup, { type: "create", password: PASSWORD });
  if (started.ok) routes.push("creating again works");

  const reset = await tryAsk(harness.popup, { type: "reset", password: PASSWORD });
  if (reset.ok) routes.push("the password erases it");

  // And what the screen says to a user typing the password they chose sixty
  // seconds ago. A generic failure here reads as "wrong password", which sends
  // them to try it again rather than to the one thing that would help.
  await wallet.unlock(PASSWORD);
  // the button says "Unlocking" while the request is in flight, so reading the
  // screen straight away reads it mid-request rather than at its answer.
  await expect(wallet.page.getByRole("button", { name: "Unlock", exact: true })).toBeVisible({
    timeout: WAITS.onboarding,
  });
  const onScreen = await wallet.page.locator("body").innerText();
  const explains = /reinstall|remove the extension|start again|could not be finished/i.test(
    onScreen,
  );
  if (explains) routes.push("the unlock screen explains the state and names the way out");

  expect(
    routes,
    "a create that failed at its last write leaves a vault with no state: " +
      "it cannot be unlocked, and the phrase that would authorise an erase was never shown. " +
      `the unlock screen says: ${JSON.stringify(onScreen.replace(/\s+/g, " ").slice(0, 400))}`,
  ).not.toEqual([]);
});

// ============================ R1: a record the contract does not agree with

const RECEIVING = 125_000_000n;

test("a local record the contract does not agree with is refused, not spent from", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(8 * 60_000);
  const { address } = await fundedWallet(wallet);

  // The shipped-build form of "a recovery whose result disagrees with the
  // contract is refused". `recoverOpenings` re-commits its replay and compares
  // before it stores anything, but with no archive that check is unreachable,
  // so the same guard has to hold on the read path: an opening that does not
  // reproduce the accumulator the contract holds is an opening that cannot move
  // the money, and the number it implies is a lie whichever way it points.
  const disk = await inspect(harness.popup, PASSWORD);
  const sealed = await sealLikeVault(
    disk.dek,
    {
      // claims 40 XLM spendable, against a contract holding a commitment to
      // something else entirely.
      spendable: { value: "400000000", randomness: "7" },
      receiving: { value: "0", randomness: "0" },
      syncedThrough: FAKE_LEDGER,
    },
    (disk.all[STATE_KEY] as Sealed).v,
  );
  await plant(harness.context, { [openingKeyFor(address)]: sealed });
  await presentConfidentialAccount(harness.context, {
    auditorId: 1,
    // what the contract actually holds: a commitment to a different amount.
    spendable: commitmentOf({ value: 100_000_000n, randomness: 3n }),
    receiving: IDENTITY,
  });
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  const pocket = (await askWorker(harness.popup, { type: "privatePocket" })) as {
    state: string;
    spendable?: string;
    message?: string;
  };
  expect(pocket.state, "a record the contract contradicts must be called out").toBe("diverged");
  expect(
    pocket.spendable,
    "40 XLM the contract does not hold must never be rendered as a balance",
  ).toBeUndefined();
  expect(pocket.message, "and the state must say the money is still on chain").toMatch(
    /funds are safe on chain/i,
  );

  // And it must refuse to act on it. Building against an opening the chain
  // disagrees with produces a proof the contract rejects at best, and at worst
  // burns the state that could have been reconciled.
  const spend = await tryAsk(harness.popup, {
    type: "buildPrivateOp",
    op: { kind: "unshield", amount: "1" },
  });
  expect(spend.ok, "a diverged pocket must not be spent from").toBeFalsy();
  expect((spend.error ?? "").length, "and the refusal must be readable").toBeGreaterThan(0);
});

// ======================================================== R12: received funds

/**
 * A pocket holding nothing spendable and 12.5 XLM received but not merged.
 *
 * The openings are planted and the chain is made to agree with them, which is
 * the only offline way to reach this state: receiving a confidential transfer
 * for real needs a second funded party, a proof and two submissions.
 */
async function pocketWithReceivedFunds(
  wallet: Wallet,
  harness: { popup: Page; context: BrowserContext },
  address: string,
): Promise<{ breakSubmission(): void }> {
  const disk = await inspect(harness.popup, PASSWORD);
  const sealed = await sealLikeVault(
    disk.dek,
    {
      spendable: { value: "0", randomness: "0" },
      receiving: { value: RECEIVING.toString(), randomness: "0" },
      syncedThrough: FAKE_LEDGER,
    },
    (disk.all[STATE_KEY] as Sealed).v,
  );
  await plant(harness.context, { [openingKeyFor(address)]: sealed });
  const chain = await presentConfidentialAccount(harness.context, {
    auditorId: 1,
    spendable: IDENTITY,
    // the commitment the planted opening actually opens, computed by the
    // oracle's own curve arithmetic. a chain that disagreed would send the
    // wallet to `diverged`, and this test would be measuring that instead.
    receiving: commitmentOf({ value: RECEIVING, randomness: 0n }),
  });
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  return chain;
}

test("received funds are counted separately, and the wallet refuses to spend them until they are merged", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(8 * 60_000);
  const { address } = await fundedWallet(wallet);
  await pocketWithReceivedFunds(wallet, harness, address);

  const pocket = (await askWorker(harness.popup, { type: "privatePocket" })) as {
    state: string;
    spendable?: string;
    receiving?: string;
    mergeAvailable?: boolean;
  };
  expect(pocket.state, "openings that open the chain make a working pocket").toBe("ready");
  expect(pocket.spendable, "nothing has been merged, so nothing is spendable").toBe("0.0000000");
  expect(pocket.receiving, "the received value is stated as its own figure").toBe("12.5000000");
  expect(pocket.mergeAvailable, "and the way to release it is offered").toBe(true);

  // Genuinely unspendable, asserted against the WORKER rather than against a
  // disabled button. A UI that merely hides the control while the worker would
  // have built the transaction is not the claim the receiving card makes.
  const spend = await tryAsk(harness.popup, {
    type: "buildPrivateOp",
    op: { kind: "transfer", to: "GBHEDQ5XUXCWK5I32NVDSGAL6BIX2X7DUWQYC2MLXV27N44JLDQFGT73", amount: "1" },
  });
  expect(spend.ok, "received funds must not be spendable before a merge").toBeFalsy();
  expect(spend.error, "the refusal must name the spendable balance it measured against").toMatch(
    /more than your spendable balance of 0\.0000000 XLM/i,
  );
  expect(spend.error, "and must say what releases the rest").toMatch(
    /made spendable first/i,
  );

  // Moving it out is spending it too, and the same money must be just as stuck
  // by that route. This is the second door on the same room.
  const out = await tryAsk(harness.popup, {
    type: "buildPrivateOp",
    op: { kind: "unshield", amount: "1" },
  });
  expect(out.ok, "moving received funds out is spending them too").toBeFalsy();
  expect(out.error, "the refusal must name the spendable balance").toMatch(
    /more than your spendable balance of 0\.0000000 XLM/i,
  );
});

test("the home screen shows received funds as held, with the control that releases them", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(8 * 60_000);
  const { address } = await fundedWallet(wallet);
  await pocketWithReceivedFunds(wallet, harness, address);
  const page = wallet.page;

  await wallet.openPrivatePocket();

  // "Received funds sit here until you make them spendable." is a claim the
  // brief lists verbatim. The figure has to be there, named, and next to the
  // one control that changes it.
  await expect(page.getByText("Receiving", { exact: true })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  const balances = await wallet.privateBalances();
  expect(balances.spendable, "the hero is what can be sent right now").toBe(0);
  expect(balances.receiving, "and the held figure is stated in full").toBe(12.5);

  // the control that releases it sits with the figure, on home, and again in
  // the move sheet where every other private-pocket action lives. both, because
  // a user who has just read "until you make them spendable" looks for it where
  // they read it.
  await expect(
    page.getByRole("button", { name: "Make spendable" }).first(),
    "the merge must be offered beside the held figure",
  ).toBeVisible();
  await wallet.openMove();
  await expect(
    page.getByRole("dialog").getByRole("button", { name: "Make spendable" }),
    "and in the sheet that holds the rest of the private-pocket actions",
  ).toBeVisible();
});

test("a merge that fails to submit leaves the received funds exactly where they were", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(8 * 60_000);
  const { address } = await fundedWallet(wallet);
  const chain = await pocketWithReceivedFunds(wallet, harness, address);
  const key = openingKeyFor(address);
  const before = (await workerStorage(harness.popup, harness.context))[key] as Sealed;

  // The failure that matters is the one after the wallet has decided to go: a
  // merge that is built and then cannot be sent. If the local record is written
  // ahead of the chain agreeing, the receiving side is gone locally and still
  // there on chain, which is R1 with a different cause.
  chain.breakSubmission();

  const built = await tryAsk(harness.popup, {
    type: "buildPrivateOp",
    op: { kind: "merge" },
  });
  // The merge path has to EXIST, not merely be offered. A "Make spendable"
  // button over a merge that cannot be built is the same stranded money with a
  // control on top of it, so this half of the test is as load-bearing as the
  // failure half. A merge is authorised rather than proved, so nothing here
  // waits on the prover.
  expect(
    built.ok,
    `a merge must be buildable when there is something to merge. it answered: ${built.error ?? "no error"}`,
  ).toBe(true);
  const handle = (built.data as { handle: string }).handle;
  const sent = await tryAsk(harness.popup, { type: "confirmPrivateOp", handle });
  expect(sent.ok, "a submission that never reached the network must not report success").toBeFalsy();

  // Whatever happened, the money is still findable. The openings blob is the
  // only thing that can reopen the commitment, so an unchanged blob is the
  // whole assertion.
  const after = (await workerStorage(harness.popup, harness.context))[key] as Sealed | undefined;
  expect(after, "a failed merge must not remove the record that opens the funds").toBeDefined();
  const dek = await unwrapDek(
    (await workerStorage(harness.popup, harness.context))[VAULT_KEY] as VaultHeader,
    PASSWORD,
  );
  const opened = await openSealed<{ receiving: { value: string } }>(dek, after as Sealed);
  expect(
    BigInt(opened.receiving.value),
    "a merge that did not land must leave the received value untouched",
  ).toBe(RECEIVING);
  expect(JSON.stringify(after), "and must not have rewritten it at all").toBe(
    JSON.stringify(before),
  );

  // Recoverable, not merely undeleted: the pocket still reports the money and
  // still offers the one thing that releases it, so the user's next attempt is
  // the same attempt rather than a support question.
  const pocket = (await askWorker(harness.popup, { type: "privatePocket" })) as {
    state: string;
    receiving?: string;
    mergeAvailable?: boolean;
  };
  expect(pocket.state, "a failed merge must not push the pocket into a broken state").toBe("ready");
  expect(pocket.receiving, "the received value is still there").toBe("12.5000000");
  expect(pocket.mergeAvailable, "and the merge is still on offer").toBe(true);
});
