// R4: secret material escaping the worker.
//
// The property: after every flow, no secret exists anywhere it should not. The
// secrets are the 24-word phrase, every key derived from it, and the device
// password. The wallet's own answer about where it keeps them is not evidence,
// so nothing here asks it: every surface is read from outside, with the same
// sweep, at every stage of a wallet's life.
//
// The surfaces, and why each one is here rather than assumed clean:
//
//   chrome.storage.local/.session/.sync   read from the worker that owns them
//   the DOM of every open page            including input VALUES, which the
//                                         serialised html does not carry
//   the accessibility tree                a screen reader reads names and
//                                         values the DOM text does not show
//   every network request                 url, headers and body, from pages AND
//                                         from the worker
//   console output                        pages, and the worker's own console,
//                                         which playwright does not report
//   error messages and stack traces       the taxonomy's whole job, provoked
//                                         rather than waited for
//   the clipboard                         the wallet can put the phrase there
//                                         on request; it must not be there when
//                                         nobody asked
//   document.title                        a title reaches the tab strip, the
//                                         history file and the window manager
//   page localStorage/sessionStorage      a popup surface with no encryption
//   the profile on disk                   what actually survives the process
//   the built artifact                    a build must not carry a run's secret
//
// A sweep that finds nothing is worth nothing unless it can find something, so
// two things are load-bearing here: the last test in this file plants the phrase
// on every surface above and requires the sweep to report each one, and the disk
// scan proves it reached the wallet's own storage files by finding the vault
// ciphertext there before it concludes the plaintext is absent.
import { test, expect } from "../support/fixtures";
import { EXTENSION_PATH, type Harness } from "../support/extension";
import { WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { Keypair } from "@stellar/stellar-sdk/base";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { scrypt } from "@noble/hashes/scrypt.js";
import { mnemonicToSeed } from "@scure/bip39";
import { readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { BrowserContext, Page, Worker } from "@playwright/test";

/** Distinctive on purpose: it must not be a substring of anything the UI says. */
const PASSWORD = "qa-r4-device-password-Vb7Kx";

/**
 * A valid BIP-39 24-word phrase that is not this wallet's.
 *
 * The published zero-entropy vector. Used wherever a request needs a phrase and
 * sending the real one would either destroy the wallet under test or prove
 * nothing about what the wallet already held.
 */
const DECOY_PHRASE = `${"abandon ".repeat(23)}art`;

// --------------------------------------------------------------------- needles

interface Needle {
  label: string;
  value: string;
}

interface ByteNeedle {
  label: string;
  value: Buffer;
}

interface Secrets {
  phrase: string;
  address: string;
  /** Exact, case-sensitive substrings. Each is a value that must exist nowhere. */
  exact: Needle[];
  /** Every four-word window of the phrase, lowercase and single-spaced. */
  runs: string[];
  /** The same secrets as bytes, for surfaces that are not text. */
  bytes: ByteNeedle[];
}

/**
 * SLIP-0010 ed25519 to m/44'/148'/0'.
 *
 * Written out rather than imported from the wallet. The needle is the thing the
 * whole file hunts for, and deriving it with the code under test would let one
 * wrong derivation produce a needle nothing could ever match, which is a sweep
 * that passes by construction.
 */
function slip10(seed: Uint8Array, path: number[]): Uint8Array {
  let I = hmac(sha512, new TextEncoder().encode("ed25519 seed"), seed);
  let key = I.slice(0, 32);
  let chain = I.slice(32);
  for (const level of path) {
    const data = new Uint8Array(37);
    data[0] = 0;
    data.set(key, 1);
    const i = (level | 0x80000000) >>> 0;
    data[33] = (i >>> 24) & 0xff;
    data[34] = (i >>> 16) & 0xff;
    data[35] = (i >>> 8) & 0xff;
    data[36] = i & 0xff;
    I = hmac(sha512, chain, data);
    key = I.slice(0, 32);
    chain = I.slice(32);
  }
  return key;
}

/** Every four-word window of the phrase, which is what a partial leak looks like. */
function windows(phrase: string, size: number, step: number): string[] {
  const words = phrase.toLowerCase().split(" ");
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i += step) out.push(words.slice(i, i + size).join(" "));
  return out;
}

/**
 * The values this run must never find, derived from the phrase the screen
 * actually showed.
 *
 * Four consecutive words in order is the smallest fragment worth chasing: the
 * BIP-39 list is ordinary English, so one word proves nothing, and four
 * specific words in sequence cannot appear by accident.
 */
async function secretsOf(phrase: string, password: string): Promise<Secrets> {
  const seed = Buffer.from(await mnemonicToSeed(phrase));
  const raw = Buffer.from(slip10(seed, [44, 148, 0]));
  const keypair = Keypair.fromRawEd25519Seed(raw);

  const exact: Needle[] = [
    { label: "the 24-word phrase", value: phrase },
    { label: "the device password", value: password },
    { label: "the stellar secret seed", value: keypair.secret() },
    { label: "the BIP-39 seed as hex", value: seed.toString("hex") },
    { label: "the BIP-39 seed as HEX", value: seed.toString("hex").toUpperCase() },
    { label: "the BIP-39 seed as base64", value: seed.toString("base64") },
    { label: "the ed25519 secret as hex", value: raw.toString("hex") },
    { label: "the ed25519 secret as HEX", value: raw.toString("hex").toUpperCase() },
    { label: "the ed25519 secret as base64", value: raw.toString("base64") },
  ];

  const bytes: ByteNeedle[] = [];
  for (const n of exact) {
    bytes.push({ label: `${n.label} (utf-8)`, value: Buffer.from(n.value, "utf8") });
    bytes.push({ label: `${n.label} (utf-16)`, value: Buffer.from(n.value, "utf16le") });
  }
  // The raw key material, unencoded. A plaintext write of a key does not spell
  // it in hex, and the encodings above would all miss it.
  bytes.push({ label: "the BIP-39 seed, raw bytes", value: seed });
  bytes.push({ label: "the ed25519 secret, raw bytes", value: raw });
  // Non-overlapping windows only, because the byte scan runs over every file in
  // a browser profile and each needle is a whole pass. Any contiguous copy of
  // the phrase contains all six; any run of seven words contains one.
  for (const run of windows(phrase, 4, 4)) {
    bytes.push({ label: `four words of the phrase ("${run}")`, value: Buffer.from(run, "utf8") });
    bytes.push({
      label: `four words of the phrase, utf-16 ("${run}")`,
      value: Buffer.from(run, "utf16le"),
    });
  }

  return {
    phrase,
    address: keypair.publicKey(),
    exact,
    runs: windows(phrase, 4, 1),
    bytes,
  };
}

/**
 * What a piece of text gives away.
 *
 * Two normalisations, because a leak is rarely a verbatim copy. The spaced form
 * catches the phrase however it was punctuated: numbered cells, a JSON array,
 * one word per line. The compact form catches it with the separators stripped
 * out entirely.
 */
function scanText(text: string, s: Secrets): string[] {
  if (!text) return [];
  const hits: string[] = [];
  for (const n of s.exact) if (text.includes(n.value)) hits.push(n.label);
  const spaced = ` ${text.toLowerCase().replace(/[^a-z]+/g, " ")} `;
  const compact = text.toLowerCase().replace(/[^a-z]+/g, "");
  for (const run of s.runs) {
    if (spaced.includes(` ${run} `)) hits.push(`four words of the phrase ("${run}")`);
    else if (compact.includes(run.replace(/ /g, ""))) {
      hits.push(`four words of the phrase, unseparated ("${run}")`);
    }
  }
  return [...new Set(hits)];
}

// ------------------------------------------------------------------ recording
//
// Console, network and uncaught errors are events, not state. Sampling them at
// the end of a stage sees only what is still on screen, so they are collected
// from the moment the browser opens and swept as an accumulating transcript.

interface Recorded {
  console: string[];
  requests: string[];
  pageErrors: string[];
}

function record(context: BrowserContext): Recorded {
  const rec: Recorded = { console: [], requests: [], pageErrors: [] };
  const watch = (page: Page): void => {
    page.on("console", (m) => rec.console.push(`${m.type()} ${m.text()}`));
    page.on("pageerror", (e) => rec.pageErrors.push(`${e.message}\n${e.stack ?? ""}`));
  };
  for (const page of context.pages()) watch(page);
  context.on("page", watch);
  // The config sets PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS, so this sees
  // the worker's chain calls as well as the pages'. Without it the one process
  // that holds the keys would be the one process nobody watched.
  context.on("request", (req) => {
    rec.requests.push(
      `${req.method()} ${req.url()} ${JSON.stringify(req.headers())} ${req.postData() ?? ""}`,
    );
  });
  return rec;
}

/**
 * Record the worker's own console.
 *
 * Playwright reports console messages for pages and not for service workers,
 * and the worker is the process that holds every key, so leaving it unwatched
 * would leave the most dangerous console in the extension unobserved. The
 * wrapper still calls through, so nothing is suppressed.
 */
async function watchWorkerConsole(worker: Worker): Promise<void> {
  await worker.evaluate(() => {
    const g = self as unknown as { __qaConsole?: string[] };
    if (g.__qaConsole) return;
    const seen: string[] = [];
    g.__qaConsole = seen;
    const levels = ["log", "info", "warn", "error", "debug", "trace"] as const;
    for (const level of levels) {
      // the two lines below WRAP the worker's console rather than write to one,
      // and they call through, so nothing the wallet logs is suppressed.
      // eslint-disable-next-line no-console
      const original = console[level].bind(console) as (...a: unknown[]) => void;
      // eslint-disable-next-line no-console
      console[level] = (...args: unknown[]) => {
        try {
          seen.push(
            `${level} ${args
              .map((a) => {
                try {
                  return typeof a === "string" ? a : (JSON.stringify(a) ?? String(a));
                } catch {
                  return String(a);
                }
              })
              .join(" ")}`,
          );
        } catch {
          seen.push(`${level} <unrenderable>`);
        }
        original(...args);
      };
    }
  });
}

// -------------------------------------------------------------------- surfaces

/** One request to the worker where a refusal is an answer rather than a throw. */
async function ask<T>(
  page: Page,
  message: unknown,
): Promise<{ ok: boolean; data?: T; error?: string }> {
  return page.evaluate(
    (msg) =>
      new Promise<{ ok: boolean; data?: unknown; error?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          msg,
          (reply: { ok?: boolean; data?: unknown; error?: string }) => {
            const lost = chrome.runtime.lastError?.message;
            resolve(
              reply
                ? { ok: reply.ok === true, data: reply.data, error: reply.error }
                : { ok: false, error: lost ?? "the worker did not answer" },
            );
          },
        );
      }),
    message,
  ) as Promise<{ ok: boolean; data?: T; error?: string }>;
}

/** Everything one page can be made to say about itself. */
async function pageText(context: BrowserContext, page: Page): Promise<Record<string, string>> {
  const dom = await page.evaluate(() => {
    const fields = Array.from(document.querySelectorAll("input, textarea"))
      .map((el) => (el as HTMLInputElement).value)
      .filter((v) => v.length > 0)
      .join("\n");
    // An opaque origin has no web storage and throws on the property itself, so
    // this is guarded rather than assumed. A page that HAS none is covered; a
    // page that would not say is the one case that must not read as empty.
    const store = (which: "localStorage" | "sessionStorage"): Record<string, string> | string => {
      try {
        const s = window[which];
        const out: Record<string, string> = {};
        for (let i = 0; i < s.length; i++) {
          const k = s.key(i);
          if (k !== null) out[k] = s.getItem(k) ?? "";
        }
        return out;
      } catch {
        return "no web storage on this origin";
      }
    };
    return {
      html: document.documentElement.outerHTML,
      values: fields,
      title: document.title,
      webStorage: JSON.stringify({
        local: store("localStorage"),
        session: store("sessionStorage"),
      }),
    };
  });

  // The accessibility tree, over CDP. It is not a second look at the markup:
  // it reaches inside shadow roots, which `outerHTML` does not serialise, and
  // it carries computed names a reader announces from attributes rather than
  // from text. The last test in this file proves that difference rather than
  // asserting it.
  const cdp = await context.newCDPSession(page);
  const accessibility = await (async () => {
    try {
      await cdp.send("Accessibility.enable");
      return JSON.stringify((await cdp.send("Accessibility.getFullAXTree")).nodes);
    } finally {
      await cdp.detach().catch(() => undefined);
    }
  })();

  return { ...dom, accessibility };
}

/**
 * An ordinary web page, in the same browser as the wallet.
 *
 * It exists because the clipboard cannot be read from an extension page: Chrome
 * gates `clipboard-read` behind the `clipboardRead` manifest permission, which
 * this extension correctly does not request, and CDP refuses to grant a
 * permission to a `chrome-extension://` origin at all ("Permission can't be
 * granted to opaque origins"). A page on a normal https origin CAN be granted
 * it, and reads the same board the popup writes to. That is also the real
 * threat: the clipboard is shared with every site the user has open.
 *
 * Every request it makes is fulfilled locally. It needs an origin, not a
 * server, and a real load would put a page nobody is testing on the network.
 * The host is one the ambient watcher already expects, so borrowing it as an
 * origin does not read as the wallet talking to somewhere new.
 */
const READER_ORIGIN = "https://friendbot.stellar.org";

const readers = new WeakMap<BrowserContext, Page>();

async function reader(context: BrowserContext): Promise<Page> {
  const existing = readers.get(context);
  if (existing && !existing.isClosed()) return existing;
  const page = await context.newPage();
  // Scoped to the origin, not to everything. The wallet's content script loads
  // its SEP-43 shim from a chrome-extension:// url into every https page, and a
  // catch-all route answers that with html, which the browser reports as a MIME
  // type error. The page under test here is the origin; the extension's own
  // requests must be left alone.
  await page.route(`${READER_ORIGIN}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>qa reader</title>",
    }),
  );
  await page.goto(`${READER_ORIGIN}/qa-reader`);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: READER_ORIGIN });
  readers.set(context, page);
  return page;
}

/**
 * What is on the clipboard, and whether the clipboard could be read at all.
 *
 * The order matters. Reading first captures whatever a flow left there; the
 * probe afterwards proves the read path works, so an empty result is an
 * observation rather than a silence. Writing the probe also clears the board
 * between stages, so a hit is always attributable to the stage that reported it.
 */
async function clipboard(
  context: BrowserContext,
  popup: Page,
): Promise<{ text: string; readable: boolean }> {
  const page = await reader(context);
  // readText resolves only for a focused document, so the reader is brought
  // forward and the popup is put back afterwards: a sweep must not leave the
  // wallet behind another tab for whatever the test does next.
  await page.bringToFront();
  const text = await page.evaluate(() =>
    navigator.clipboard.readText().then(
      (t) => t,
      () => "",
    ),
  );
  const readable = await page.evaluate(async (probe) => {
    try {
      await navigator.clipboard.writeText(probe);
      return (await navigator.clipboard.readText()) === probe;
    } catch {
      return false;
    }
  }, "qa-r4-clipboard-probe");
  await popup.bringToFront();
  return { text, readable };
}

// ------------------------------------------------------------------ disk scan

interface DiskScan {
  files: number;
  bytes: number;
  unreadable: string[];
  hits: string[];
}

function walk(dir: string, out: string[] = []): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.isFile()) out.push(path);
  }
  return out;
}

/**
 * Every byte of a directory tree, against every needle.
 *
 * Read whole rather than streamed: a browser profile after these flows is tens
 * of megabytes, and a chunked read would have to overlap by the longest needle
 * or miss a value that straddles a boundary. Anything that cannot be read is
 * NAMED rather than skipped quietly, because "nothing was found" and "nothing
 * was looked at" must not be the same result.
 */
function scanDir(root: string, needles: ByteNeedle[]): DiskScan {
  const scan: DiskScan = { files: 0, bytes: 0, unreadable: [], hits: [] };
  const found = new Set<string>();
  for (const path of walk(root)) {
    let buf: Buffer;
    try {
      buf = readFileSync(path);
    } catch (e) {
      scan.unreadable.push(`${path}: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    scan.files++;
    scan.bytes += buf.length;
    for (const needle of needles) {
      if (found.has(needle.label)) continue;
      if (buf.includes(needle.value)) {
        found.add(needle.label);
        scan.hits.push(`${needle.label} in ${path.slice(root.length + 1)}`);
      }
    }
  }
  return scan;
}

// ---------------------------------------------------------------------- sweep

interface SweepResult {
  findings: string[];
  gaps: string[];
}

/**
 * Every live surface, at one moment, against every needle.
 *
 * `disk` is opt-in per stage: it is the only surface whose cost scales with the
 * size of the profile, and it changes only when something is written.
 */
async function sweep(
  harness: Harness,
  rec: Recorded,
  s: Secrets,
  stage: string,
  opts: { disk?: boolean } = {},
): Promise<SweepResult> {
  const findings: string[] = [];
  const gaps: string[] = [];
  const note = (surface: string, hits: string[]): void => {
    for (const hit of hits) findings.push(`${stage} · ${surface} · ${hit}`);
  };

  const worker = await harness.worker();

  // The three storage areas, read from the process that owns them.
  try {
    const stores = await worker.evaluate(async () => ({
      local: JSON.stringify(await chrome.storage.local.get(null)),
      session: JSON.stringify(await chrome.storage.session.get(null)),
      sync: JSON.stringify(await chrome.storage.sync.get(null)),
    }));
    for (const [area, json] of Object.entries(stores)) {
      note(`chrome.storage.${area}`, scanText(json, s));
    }
  } catch (e) {
    gaps.push(`${stage}: chrome.storage could not be read (${String(e)})`);
  }

  // The worker's console, and whether the recorder was still installed. A
  // restarted worker loses the wrapper, and that is a gap in coverage rather
  // than a clean console.
  try {
    const lines = await worker.evaluate(
      () => (self as unknown as { __qaConsole?: string[] }).__qaConsole ?? null,
    );
    if (lines === null) {
      gaps.push(`${stage}: the service worker restarted, so its console was not observed`);
      await watchWorkerConsole(worker);
    } else {
      note("the worker's console", scanText(lines.join("\n"), s));
    }
  } catch (e) {
    gaps.push(`${stage}: the worker's console could not be read (${String(e)})`);
  }

  // Every open page: markup, field values, title, web storage, a11y tree.
  for (const page of harness.context.pages()) {
    if (page.isClosed()) continue;
    const where = new URL(page.url()).pathname.split("/").pop() || page.url();
    try {
      for (const [surface, text] of Object.entries(await pageText(harness.context, page))) {
        note(`${where} ${surface}`, scanText(text, s));
      }
    } catch (e) {
      gaps.push(`${stage}: ${where} could not be read (${String(e)})`);
    }
  }

  const board = await clipboard(harness.context, harness.popup);
  if (!board.readable) gaps.push(`${stage}: the clipboard could not be read`);
  note("the clipboard", scanText(board.text, s));

  // The transcripts, which accumulate rather than reset, so a leak reported
  // here happened at or before this stage.
  note("console output", scanText(rec.console.join("\n"), s));
  note("network requests", scanText(rec.requests.join("\n"), s));
  note("uncaught errors", scanText(rec.pageErrors.join("\n"), s));

  if (opts.disk) {
    const profile = scanDir(harness.profileDir, s.bytes);
    note("the profile on disk", profile.hits);
    for (const bad of profile.unreadable.slice(0, 5)) gaps.push(`${stage}: unreadable ${bad}`);
    const build = scanDir(EXTENSION_PATH, s.bytes);
    note("the built artifact", build.hits);
  }

  return { findings, gaps };
}

// ------------------------------------------------------------- the vault at rest

interface VaultHeader {
  v: number;
  kdf: { id: string; N: number; r: number; p: number; dkLen: number };
  salt: string;
  wrap: { iv: string; ct: string };
  aadAlg: string;
}

interface Sealed {
  v: number;
  iv: string;
  ct: string;
}

/** WebCrypto wants a view over a real ArrayBuffer, not any ArrayBufferLike. */
function ab(u: Uint8Array): ArrayBuffer {
  return u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
}

const from64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/**
 * The header exactly as the format binds it, rebuilt from its own fields.
 *
 * Written here rather than imported so that "the blob decrypts" is a statement
 * about the artefact and not about the code that produced it. Get the order
 * wrong and the tag fails, which is a loud wrong answer rather than a quiet one.
 */
function headerAad(h: VaultHeader): Uint8Array {
  const q = (v: string): string => JSON.stringify(v);
  return new TextEncoder().encode(
    `{"v":${h.v},"kdf":{"id":${q(h.kdf.id)},"N":${h.kdf.N},"r":${h.kdf.r},` +
      `"p":${h.kdf.p},"dkLen":${h.kdf.dkLen}},"salt":${q(h.salt)},` +
      `"wrapIv":${q(h.wrap.iv)},"aadAlg":${q(h.aadAlg)}}`,
  );
}

async function unwrapDek(header: VaultHeader, password: string): Promise<Uint8Array> {
  const kekRaw = scrypt(new TextEncoder().encode(password.normalize("NFKC")), from64(header.salt), {
    N: header.kdf.N,
    r: header.kdf.r,
    p: header.kdf.p,
    dkLen: header.kdf.dkLen,
  });
  const kek = await crypto.subtle.importKey("raw", ab(kekRaw), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ab(from64(header.wrap.iv)), additionalData: ab(headerAad(header)) },
    kek,
    ab(from64(header.wrap.ct)),
  );
  return new Uint8Array(pt);
}

async function openSealed<T>(dek: Uint8Array, sealed: Sealed): Promise<T> {
  const key = await crypto.subtle.importKey("raw", ab(dek), "AES-GCM", false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: ab(from64(sealed.iv)),
      additionalData: ab(new TextEncoder().encode(`pocket.payload.v${sealed.v}`)),
    },
    key,
    ab(from64(sealed.ct)),
  );
  return JSON.parse(new TextDecoder().decode(new Uint8Array(pt))) as T;
}

/**
 * Shannon entropy per byte.
 *
 * Read against a random sample of the SAME LENGTH, never against 8. A sealed
 * mnemonic is about 190 bytes, and 190 draws from 256 symbols cannot fill the
 * histogram: genuine AES output measures about 6.9 there, so a flat threshold
 * of 8, or even 7, fails on correct ciphertext and says nothing about whether
 * it is readable. The comparison below is what makes the number mean something.
 */
function entropy(buf: Uint8Array): number {
  const counts = new Array<number>(256).fill(0);
  for (const b of buf) counts[b] = (counts[b] ?? 0) + 1;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / buf.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/** What entropy a truly random buffer of this length measures, on this run. */
function randomEntropy(length: number): number {
  return entropy(crypto.getRandomValues(new Uint8Array(length)));
}

/** The longest run of printable ASCII. Ciphertext has none worth the name. */
function longestPrintableRun(buf: Uint8Array): number {
  let best = 0;
  let run = 0;
  for (const b of buf) {
    if (b >= 0x20 && b <= 0x7e) {
      run++;
      if (run > best) best = run;
    } else run = 0;
  }
  return best;
}

// ------------------------------------------------------------------ the tests

test("no secret material reaches any surface, from creation to erasure", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(14 * 60_000);

  const rec = record(harness.context);
  await watchWorkerConsole(await harness.worker());

  const phrase = await wallet.createWallet(PASSWORD);
  const s = await secretsOf(phrase, PASSWORD);
  const address = await wallet.revealAddress();
  // The needles are derived independently, so this also says the phrase on
  // screen owns the account on screen. If it did not, every needle below would
  // be a value this wallet never held and the sweep would be hunting nothing.
  expect(address, "the phrase shown must derive the address shown").toBe(s.address);

  const findings: string[] = [];
  const gaps: string[] = [];
  const at = async (stage: string, disk = false): Promise<void> => {
    const r = await sweep(harness, rec, s, stage, { disk });
    findings.push(...r.findings);
    gaps.push(...r.gaps);
  };

  await at("after creating the wallet", true);

  // The notification surface, closed by not existing. A notification is text
  // the wallet hands to the operating system, where it outlives the popup and
  // lands in a notification centre nothing in this suite can read back. The
  // only assertion worth making is that the wallet cannot produce one at all,
  // which is a manifest fact rather than a behaviour, so it is checked as one.
  const notifications = await (
    await harness.worker()
  ).evaluate(() => ({
    api: typeof chrome.notifications,
    permissions: chrome.runtime.getManifest().permissions ?? [],
  }));
  expect(notifications.permissions, "a notification is a surface with no reader").not.toContain(
    "notifications",
  );
  expect(notifications.api, "the worker must not be able to raise a notification").toBe(
    "undefined",
  );

  await wallet.lock();
  await at("after locking");

  await wallet.unlock(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await at("after unlocking");

  // A real payment, on the ledger. The interesting surfaces of a send are the
  // ones that only exist because something was signed: the request bodies the
  // worker put on the wire, and the receipt still on screen.
  await ledger.fund(address);
  const recipient = Keypair.random().publicKey();
  await ledger.fund(recipient);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openSend();
  await wallet.composePayment({ to: recipient, amount: "1.5" });
  await wallet.confirmPayment();
  await at("after sending, with the receipt still on screen");
  await wallet.dismissReceipt();
  await at("after sending", true);

  // The control for the network surface. Every chain call happens in the
  // service worker, and playwright only reports a worker's requests when
  // PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS is set. Unset, the recorder
  // would see the popup's requests, of which there are none, and "no secret on
  // the wire" would mean "nobody watched the wire". A payment has just been
  // built, simulated and submitted, so the worker's traffic must be in here.
  expect(
    rec.requests.filter((r) => r.includes("soroban-testnet.stellar.org")).length,
    "the worker's own requests were not recorded, so the network sweep is vacuous",
  ).toBeGreaterThan(0);
  expect(
    rec.requests.some((r) => r.startsWith("POST ") && r.trimEnd().endsWith("}")),
    "no request body was captured, so the payload sweep is vacuous",
  ).toBe(true);

  await wallet.nav("Settings").click();
  await wallet.page.getByRole("button", { name: /^Erase this wallet/ }).click();
  await wallet.page.getByRole("button", { name: "I understand, continue" }).click();
  await wallet.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
  await wallet.page.getByRole("dialog").getByRole("button", { name: "Erase this wallet" }).click();
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await at("after erasing", true);

  expect(gaps, "a surface this sweep claims to cover was not actually read").toEqual([]);
  expect(findings, "secret material was found outside the worker").toEqual([]);
});

test("provoked errors carry no secret, and the wallet survives being provoked", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(8 * 60_000);

  const rec = record(harness.context);
  await watchWorkerConsole(await harness.worker());

  const phrase = await wallet.createWallet(PASSWORD);
  const s = await secretsOf(phrase, PASSWORD);

  // Every one of these fails, and a failure is where a message, a cause and a
  // stack get assembled out of whatever was in scope. That is the moment key
  // material reaches a string, so it is provoked rather than waited for.
  const provocations: unknown[] = [
    { type: "unlock", password: "not-the-password" },
    { type: "unlock", password: `${PASSWORD} ` },
    { type: "reset", password: "not-the-password" },
    { type: "import", password: PASSWORD, mnemonic: "not a recovery phrase at all" },
    { type: "import", password: PASSWORD, mnemonic: DECOY_PHRASE },
    { type: "recoverFromMnemonic", mnemonic: DECOY_PHRASE, password: PASSWORD },
    { type: "recoverFromMnemonic", mnemonic: "nonsense", password: PASSWORD },
    { type: "buildPayment", to: "GARBAGE", amount: "1", assetId: "native" },
    { type: "buildPayment", to: 42, amount: "1", assetId: "native" },
    { type: "buildPayment", to: null, amount: null, assetId: null },
    { type: "confirmPayment", handle: "no-such-handle" },
    { type: "buildPrivateOp", op: { kind: "transfer", to: "nope", amount: "-1" } },
    { type: "buildPrivateOp", op: { kind: "not-an-operation" } },
    { type: "buildPrivateOp", op: null },
    { type: "confirmPrivateOp", handle: "no-such-handle" },
    { type: "connectDapp", origin: "not-an-origin" },
    { type: "disconnectDapp", origin: 7 },
    { type: "resolveDappRequest", id: "nope", approved: true },
    { type: "setNetwork", network: "mainnet" },
    { type: "there-is-no-such-request" },
    { type: 12 },
  ];

  // Two transcripts on purpose. Only what the WORKER said is scanned: half of
  // these requests carry the password or a phrase by construction, and scanning
  // the request alongside the answer would report this test's own arguments as
  // a leak and hide a real one in the noise.
  const answers: string[] = [];
  const transcript: string[] = [];
  for (const message of provocations) {
    const reply = await ask(harness.popup, message);
    const answer = reply.error ?? JSON.stringify(reply.data ?? null);
    answers.push(answer);
    transcript.push(`${JSON.stringify(message)} -> ${answer}`);
  }

  const hits = scanText(answers.join("\n"), s);
  expect(hits, `an error message carried secret material:\n${transcript.join("\n")}`).toEqual([]);

  // Not merely that the strings were clean: nothing above may have unlocked,
  // erased or replaced anything. A test that provoked the wallet into a
  // different state proves nothing about the state it was asked about.
  const status = await ask<{ locked: boolean; initialised: boolean; address?: string }>(
    harness.popup,
    { type: "status" },
  );
  expect(status.data?.initialised, "the wallet must still exist").toBe(true);
  expect(status.data?.locked, "a wrong password must not have locked the wallet").toBe(false);
  expect(status.data?.address, "the wallet must still be the same account").toBe(s.address);

  // And nothing the provocations produced reached a console, a request or a
  // page while it was happening.
  const r = await sweep(harness, rec, s, "after provoking every error path");
  expect(r.gaps).toEqual([]);
  expect(r.findings).toEqual([]);

  // Asked LAST, and after every assertion above, because unlike the twenty-two
  // it does not leave a wallet behind. `setNetwork` is the one field in the
  // contract that reaches the controller without passing through dispatch's
  // shape check: an unknown id is adopted AND WRITTEN TO pocket.settings before
  // anything reads it, after which every status, balance and unlock throws on
  // the missing config, across restarts, with the popup offering nothing but
  // "Try again". That is reported as a defect of its own and is not R4, so the
  // only thing asserted here is the R4 half: whatever it says, it says nothing
  // secret. Nothing may be asserted about this wallet afterwards.
  const corrupting = await ask(harness.popup, {
    type: "setNetwork",
    network: "a-network-that-does-not-exist",
  });
  expect(
    scanText(corrupting.error ?? "", s),
    "even a request that bricks the wallet must not leak",
  ).toEqual([]);
});

test("the vault at rest is ciphertext, and the disk really was read", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(8 * 60_000);

  const phrase = await wallet.createWallet(PASSWORD);
  const s = await secretsOf(phrase, PASSWORD);

  const stored = await harness.popup.evaluate(async () => chrome.storage.local.get(null));
  const header = stored["pocket.vault"] as VaultHeader | undefined;
  const state = stored["pocket.state"] as Sealed | undefined;
  expect(header, "a created wallet must have written a vault header").toBeDefined();
  expect(state, "a created wallet must have written sealed state").toBeDefined();
  if (!header || !state) return;

  // The parameters the header claims, checked against the floor the format
  // documents. A header that asked for weaker derivation would still open, so
  // "it decrypts" is not the assertion that matters here.
  expect(header.kdf.id).toBe("scrypt");
  expect(header.kdf.N).toBeGreaterThanOrEqual(1 << 15);
  expect(header.kdf.r).toBeGreaterThanOrEqual(8);
  expect(header.kdf.p).toBeGreaterThanOrEqual(1);
  expect(header.kdf.dkLen).toBe(32);
  expect(from64(header.salt).length, "a 16-byte salt, freshly random").toBe(16);
  expect(from64(header.wrap.iv).length, "AES-GCM takes a 96-bit iv").toBe(12);
  // 32 bytes of wrapped key plus a 16-byte tag. A shorter blob is not a wrapped
  // AES-256 key, whatever else it is.
  expect(from64(header.wrap.ct).length).toBe(48);

  // The blob really is this wallet's phrase, opened with nothing but the
  // password. Without this the "no plaintext in storage" assertion below would
  // hold just as well for a store that never contained the phrase at all.
  const dek = await unwrapDek(header, PASSWORD);
  const opened = await openSealed<{ mnemonic: string }>(dek, state);
  expect(opened.mnemonic, "the sealed state must be the phrase the screen showed").toBe(phrase);

  // And it is genuinely encrypted rather than merely encoded. Measured against
  // random bytes of the same length and against the plaintext it hides, because
  // both ends of that comparison are what "not readable" means.
  const ct = from64(state.ct);
  const plain = new TextEncoder().encode(JSON.stringify(opened));
  expect(entropy(ct), "sealed state must look like random bytes of its own length").toBeGreaterThan(
    randomEntropy(ct.length) - 0.3,
  );
  expect(entropy(ct), "sealed state must not look like the text it hides").toBeGreaterThan(
    entropy(plain) + 1,
  );
  // 190 random bytes hold a printable run of about 6 by chance; a phrase holds
  // one as long as the phrase.
  expect(
    longestPrintableRun(ct),
    "a long readable run in sealed state is plaintext that was not sealed",
  ).toBeLessThan(16);
  expect(scanText(JSON.stringify(stored), s), "storage must hold no readable secret").toEqual([]);
  // The wrong password must not open it, which is the only thing that makes the
  // encryption load-bearing rather than decorative.
  await expect(unwrapDek(header, `${PASSWORD}x`)).rejects.toThrow();

  // Now the disk. The control comes first: find the vault's own ciphertext in
  // the profile, which proves the scan reaches the files chrome.storage writes.
  // Without it, "the phrase is not on disk" could just as easily mean the walk
  // never opened a single storage file.
  const control = header.wrap.ct.slice(0, 32);
  await expect
    .poll(
      () =>
        scanDir(harness.profileDir, [{ label: "control", value: Buffer.from(control) }]).hits
          .length,
      {
        message:
          "the vault ciphertext never appeared in the profile, so the disk scan reached nothing and every disk result in this file is vacuous",
        timeout: 60_000,
      },
    )
    .toBeGreaterThan(0);

  const profile = scanDir(harness.profileDir, s.bytes);
  expect(profile.files, "an empty walk is not a clean profile").toBeGreaterThan(10);
  // Files alone would be satisfied by a tree of empty ones, and the number that
  // matters is how many bytes were actually looked at.
  expect(profile.bytes, "a walk that read nothing is not a clean profile").toBeGreaterThan(100_000);
  expect(profile.unreadable, "a file that could not be opened is a hole in this scan").toEqual([]);
  expect(profile.hits, "secret material was found in the browser profile").toEqual([]);

  const build = scanDir(EXTENSION_PATH, s.bytes);
  expect(build.files, "an empty walk is not a clean build").toBeGreaterThan(5);
  expect(build.bytes, "a walk that read nothing is not a clean build").toBeGreaterThan(1_000_000);
  expect(build.hits, "secret material was found in the built artifact").toEqual([]);
});

test("locking clears the session rather than hiding it", async ({ wallet, harness }) => {
  test.setTimeout(8 * 60_000);

  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  // The control for everything below. These two answer an unlocked wallet, so
  // the refusals that follow are the lock talking and not a wallet that refuses
  // everything. Both are local reads: nothing here waits on a ledger.
  for (const message of [{ type: "inFlight" }, { type: "dappSessions" }]) {
    const open = await ask(harness.popup, message);
    expect(open.ok, `${message.type} must answer an UNLOCKED wallet`).toBe(true);
  }

  await wallet.lock();

  // Not "the screen says locked". Every request that needs key material is
  // asked to do its work, and each one must refuse. A wallet that merely
  // re-rendered would answer these.
  const needsKeys = [
    { type: "balances" },
    { type: "privatePocket" },
    { type: "rebuildFromHistory" },
    { type: "buildPayment", to: Keypair.random().publicKey(), amount: "1", assetId: "native" },
    { type: "confirmPayment", handle: "anything" },
    { type: "buildPrivateOp", op: { kind: "merge" } },
    { type: "confirmPrivateOp", handle: "anything" },
    { type: "inFlight" },
    { type: "reconcileInFlight" },
    { type: "yieldPosition" },
    { type: "dappSessions" },
    { type: "connectDapp", origin: "https://example.com" },
    { type: "reset", password: PASSWORD },
    { type: "revealPhrase", password: PASSWORD },
    { type: "setNetwork", network: "testnet" },
  ];

  for (const message of needsKeys) {
    const reply = await ask(harness.popup, message);
    expect(reply.ok, `${message.type} answered a locked wallet`).toBe(false);
    expect(reply.error, `${message.type} refused for the wrong reason`).toBe("Wallet is locked.");
  }

  // The address is derived from the seed, so a locked wallet reporting one is a
  // wallet that still holds it somewhere.
  const status = await ask<{ locked: boolean; address?: string; privateEnabled: boolean }>(
    harness.popup,
    { type: "status" },
  );
  expect(status.data?.locked).toBe(true);
  expect(status.data?.address, "a locked wallet must not report a derived address").toBeUndefined();
  expect(status.data?.privateEnabled, "a locked wallet knows nothing about its pocket").toBe(false);

  // The wallet is refusing because it is locked and not because it is broken,
  // which is the difference between a lock and a failure.
  await wallet.unlock(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  const after = await ask<{ locked: boolean }>(harness.popup, { type: "balances" });
  expect(after.ok, "the same request must succeed once unlocked").toBe(true);
});

test("a locked wallet reveals nothing through any of the 38 message types", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(8 * 60_000);

  const rec = record(harness.context);
  await watchWorkerConsole(await harness.worker());

  const phrase = await wallet.createWallet(PASSWORD);
  const s = await secretsOf(phrase, PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.lock();

  // The whole contract, one entry per type, with arguments a caller could
  // actually send. Nothing here is expected to succeed; what is being asked is
  // what each one SAYS, including the six that a locked wallet still serves.
  const contract: { type: string; message: unknown; allowed: boolean }[] = [
    { type: "status", message: { type: "status" }, allowed: true },
    { type: "create", message: { type: "create", password: PASSWORD }, allowed: true },
    {
      type: "import",
      message: { type: "import", password: PASSWORD, mnemonic: DECOY_PHRASE },
      allowed: true,
    },
    { type: "unlock", message: { type: "unlock", password: "not-the-password" }, allowed: true },
    { type: "lock", message: { type: "lock" }, allowed: true },
    {
      type: "recoverFromMnemonic",
      message: { type: "recoverFromMnemonic", mnemonic: DECOY_PHRASE, password: PASSWORD },
      allowed: true,
    },
    { type: "balances", message: { type: "balances" }, allowed: false },
    {
      type: "buildPayment",
      message: {
        type: "buildPayment",
        to: Keypair.random().publicKey(),
        amount: "1",
        assetId: "native",
      },
      allowed: false,
    },
    { type: "confirmPayment", message: { type: "confirmPayment", handle: "h" }, allowed: false },
    { type: "reset", message: { type: "reset", password: PASSWORD }, allowed: false },
    // Even WITH the correct password, a locked wallet must refuse to reveal the
    // phrase: the seed is exactly what the lock guards, and `revealPhrase` is
    // deliberately absent from ALLOWED_WHILE_LOCKED. This is the one entry whose
    // answer, were it wrong, would hand over the whole wallet.
    {
      type: "revealPhrase",
      message: { type: "revealPhrase", password: PASSWORD },
      allowed: false,
    },
    { type: "privatePocket", message: { type: "privatePocket" }, allowed: false },
    { type: "privatePockets", message: { type: "privatePockets" }, allowed: false },
    { type: "rebuildFromHistory", message: { type: "rebuildFromHistory" }, allowed: false },
    { type: "dappSessions", message: { type: "dappSessions" }, allowed: false },
    {
      type: "connectDapp",
      message: { type: "connectDapp", origin: "https://example.com" },
      allowed: false,
    },
    {
      type: "disconnectDapp",
      message: { type: "disconnectDapp", origin: "https://example.com" },
      allowed: false,
    },
    { type: "yieldPosition", message: { type: "yieldPosition" }, allowed: false },
    {
      type: "buildYieldMove",
      message: { type: "buildYieldMove", kind: "deposit", amount: "1" },
      allowed: false,
    },
    {
      type: "confirmYieldMove",
      message: { type: "confirmYieldMove", handle: "h" },
      allowed: false,
    },
    {
      type: "swapQuote",
      message: { type: "swapQuote", assetIn: "native", assetOut: "native", amount: "1" },
      allowed: false,
    },
    {
      type: "buildSwap",
      message: { type: "buildSwap", assetIn: "native", assetOut: "native", amount: "1" },
      allowed: false,
    },
    { type: "confirmSwap", message: { type: "confirmSwap", handle: "h" }, allowed: false },
    {
      type: "buildCctpSend",
      message: {
        type: "buildCctpSend",
        destinationDomain: 6,
        recipient: "0x0000000000000000000000000000000000000000",
        amount: "1",
      },
      allowed: false,
    },
    { type: "confirmCctpSend", message: { type: "confirmCctpSend", handle: "h" }, allowed: false },
    {
      type: "cctpAttestation",
      message: { type: "cctpAttestation", sourceDomain: 6, txHash: "h" },
      allowed: false,
    },
    {
      type: "buildCctpClaim",
      message: { type: "buildCctpClaim", sourceDomain: 6, txHash: "h" },
      allowed: false,
    },
    {
      type: "confirmCctpClaim",
      message: { type: "confirmCctpClaim", handle: "h" },
      allowed: false,
    },
    { type: "currentPhase", message: { type: "currentPhase" }, allowed: false },
    { type: "pendingDappRequest", message: { type: "pendingDappRequest" }, allowed: false },
    {
      type: "resolveDappRequest",
      message: { type: "resolveDappRequest", id: "x", approved: true },
      allowed: false,
    },
    {
      type: "buildPrivateOp",
      message: { type: "buildPrivateOp", op: { kind: "merge" } },
      allowed: false,
    },
    {
      type: "confirmPrivateOp",
      message: { type: "confirmPrivateOp", handle: "h" },
      allowed: false,
    },
    { type: "inFlight", message: { type: "inFlight" }, allowed: false },
    { type: "reconcileInFlight", message: { type: "reconcileInFlight" }, allowed: false },
    { type: "setNetwork", message: { type: "setNetwork", network: "testnet" }, allowed: false },
    { type: "setAutoLock", message: { type: "setAutoLock", minutes: 15 }, allowed: false },
    { type: "history", message: { type: "history" }, allowed: false },
  ];

  // If a type is ever added, this list stops covering it and the count is what
  // says so. (The three chart reads valueSeries/assetMarket/assetSeries are
  // covered by their own locked-refusal checks and are intentionally not
  // duplicated here.)
  expect(new Set(contract.map((c) => c.type)).size, "every request type must be asked").toBe(38);

  const said: string[] = [];
  for (const entry of contract) {
    const reply = await ask(harness.popup, entry.message);
    said.push(
      `${entry.type} -> ok=${reply.ok} ${reply.error ?? JSON.stringify(reply.data ?? null)}`,
    );
    if (!entry.allowed) {
      expect(reply.ok, `${entry.type} answered a locked wallet`).toBe(false);
      expect(reply.error, `${entry.type} refused for the wrong reason`).toBe("Wallet is locked.");
    }
  }

  expect(
    scanText(said.join("\n"), s),
    `a locked wallet gave something away:\n${said.join("\n")}`,
  ).toEqual([]);

  // Nothing above may have opened it. `create`, `import` and
  // `recoverFromMnemonic` are served while locked precisely because each
  // carries its own authorisation, and this is the assertion that they do.
  const status = await ask<{ locked: boolean; initialised: boolean }>(harness.popup, {
    type: "status",
  });
  expect(status.data?.locked, "the wallet must still be locked").toBe(true);
  expect(status.data?.initialised, "the wallet must still exist").toBe(true);

  // Whatever the requests stirred up, none of it landed on a surface either.
  const r = await sweep(harness, rec, s, "after asking a locked wallet everything", { disk: true });
  expect(r.gaps).toEqual([]);
  expect(r.findings).toEqual([]);

  // And the phrase still opens it, so the refusals above cost the user nothing.
  await wallet.unlock(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
});

test("the sweep catches material planted on every surface it claims to cover", async ({
  wallet,
  harness,
}) => {
  test.setTimeout(10 * 60_000);

  const rec = record(harness.context);
  await watchWorkerConsole(await harness.worker());

  const phrase = await wallet.createWallet(PASSWORD);
  const s = await secretsOf(phrase, PASSWORD);

  // A clean run first. Anything reported here is a real finding, not the plant,
  // and it also fixes what "caught it" has to mean below.
  const before = await sweep(harness, rec, s, "control", { disk: true });
  expect(before.gaps).toEqual([]);
  expect(before.findings, "the negative control must start from a clean sweep").toEqual([]);

  // Now put the phrase, and only the phrase, on every surface this file claims
  // to read. Nothing here touches the wallet: the plants go into a junk storage
  // key, a detached node, the page title, web storage, the clipboard, a console
  // line, a request the popup makes itself, and a file in the profile.
  const worker = await harness.worker();
  await worker.evaluate(async (value) => {
    await chrome.storage.local.set({ "qa.r4.plant": value });
    await chrome.storage.session.set({ "qa.r4.plant": value });
    await chrome.storage.sync.set({ "qa.r4.plant": value });
    console.error("qa plant", value);
  }, phrase);

  await harness.popup.evaluate(
    async ({ value, password }) => {
      document.title = `Pocket ${value}`;
      const node = document.createElement("div");
      node.setAttribute("aria-label", value);
      node.textContent = value;
      document.body.appendChild(node);
      // The password, and only the password, goes inside a shadow root.
      // `outerHTML` does not serialise shadow content, so this is the one plant
      // the markup sweep cannot see and the accessibility tree must. Without it,
      // reading the a11y tree would be a claim rather than a covered surface.
      const host = document.createElement("div");
      document.body.appendChild(host);
      host
        .attachShadow({ mode: "open" })
        .append(Object.assign(document.createElement("span"), { textContent: password }));
      const field = document.createElement("input");
      field.value = value;
      document.body.appendChild(field);
      localStorage.setItem("qa.r4.plant", value);
      sessionStorage.setItem("qa.r4.plant", value);
      console.warn("qa plant", value);
      await navigator.clipboard.writeText(value).catch(() => undefined);
    },
    { value: phrase, password: PASSWORD },
  );

  // The request goes out from the reader rather than from the popup: an
  // extension page fetching a cross-origin url is refused by CORS, and Chrome
  // logs that refusal as a console error, which the ambient watcher would
  // report as this test's own defect. The reader's requests are fulfilled
  // locally, so this exercises the recorder and nothing else.
  await (
    await reader(harness.context)
  ).evaluate(async (value) => {
    await fetch(`/qa?planted=${encodeURIComponent(value)}`, {
      method: "POST",
      body: value,
    }).catch(() => undefined);
  }, phrase);

  const planted = join(harness.profileDir, "qa-r4-plant.txt");
  writeFileSync(planted, phrase, "utf8");

  const after = await sweep(harness, rec, s, "planted", { disk: true });

  // Every surface, by name. A sweep that caught the plant in storage and missed
  // it in the accessibility tree would still "fail" without this, and would
  // still be blind where it mattered.
  const covered = [
    "chrome.storage.local",
    "chrome.storage.session",
    "chrome.storage.sync",
    "the worker's console",
    "popup.html html",
    "popup.html values",
    "popup.html title",
    "popup.html webStorage",
    "popup.html accessibility",
    "the clipboard",
    "console output",
    "network requests",
    "the profile on disk",
  ];
  const missed = covered.filter(
    (surface) => !after.findings.some((f) => f.includes(`· ${surface} ·`)),
  );
  expect(
    missed,
    `the sweep did not see the phrase on these surfaces, so it cannot be trusted on them:\n${after.findings.join("\n")}`,
  ).toEqual([]);

  // And the accessibility read is a surface of its own rather than a second
  // look at the markup: the password was planted only inside a shadow root, so
  // the tree must report it and the serialised html must not.
  expect(
    after.findings.filter((f) => f.includes("popup.html accessibility · the device password")),
    "the accessibility tree did not see shadow content, so it adds nothing the markup sweep already had",
  ).not.toEqual([]);
  expect(
    after.findings.filter((f) => f.includes("popup.html html · the device password")),
    "outerHTML serialised shadow content, so this stopped being a test of the a11y read",
  ).toEqual([]);

  // Put it back the way it was, so the sweep at the end of this test is looking
  // at a wallet rather than at the plant.
  rmSync(planted, { force: true });
  await worker.evaluate(async () => {
    await chrome.storage.local.remove("qa.r4.plant");
    await chrome.storage.session.remove("qa.r4.plant");
    await chrome.storage.sync.remove("qa.r4.plant");
  });
  await harness.popup.reload();
  await wallet.waitForHome(WAITS.ledgerRead);

  // The transcripts are cumulative and now hold the plant permanently, so the
  // storage areas are what can be re-checked. That they come back clean is what
  // says the plant was the plant and not something the wallet was already doing.
  const stores = await worker.evaluate(async () => ({
    local: JSON.stringify(await chrome.storage.local.get(null)),
    session: JSON.stringify(await chrome.storage.session.get(null)),
    sync: JSON.stringify(await chrome.storage.sync.get(null)),
  }));
  for (const [area, json] of Object.entries(stores)) {
    expect(scanText(json, s), `${area} did not come back clean`).toEqual([]);
  }
});
