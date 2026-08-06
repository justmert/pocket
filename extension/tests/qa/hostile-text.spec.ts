// R13: attacker text on chain impersonating the wallet, or becoming a destination.
//
// Everything an attacker can put on a public ledger arrives here as a string: an
// asset code, an issuer, a memo, the origin of a site asking for a signature.
// `tests/edge/xss.spec.ts` already covers the strings a USER types into the send
// form. This file covers the other direction, which is the dangerous one: the
// strings the wallet is TOLD, by the chain, by an RPC, by a site.
//
// Driven by stubbing the worker's answers, the same way `ui-states/held.spec.ts`
// and `ui-states/state-honesty.spec.ts` do, because no testnet account can be
// made to hold an asset whose code is twelve thousand characters, and because
// the property under test belongs to the popup: the popup is handed a string and
// must render it without lending it the wallet's authority.
//
// Two containments bound what these tests can honestly claim, and both are
// recorded here rather than discovered again later:
//
//   * `controller.balances()` returns ONLY the native row today. It never
//     enumerates trustlines, so the asset list cannot be flooded through the
//     real worker. The rendering path exists and is exercised anyway, because
//     the day a trustline lands in that array is the day these assertions start
//     mattering, and by then nobody will remember to write them.
//   * every error crossing the worker boundary goes through `describeError`,
//     which is a NAME allowlist rather than a shape heuristic. That is the
//     mechanism keeping chain-authored prose out of the one container the wallet
//     speaks through, and it is asserted from the outside here.
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { Wallet, WAITS } from "../support/wallet";
import { expectNoHorizontalScroll, settle } from "../viewport/audit";
import { respondWith, RPC_HOST } from "../support/stub";

const PASSWORD = "a-strong-test-password";

/** a real, checksum-valid address, for the places one is required. */
const REAL = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
/** and one differing from it only where a shortened rendering does not look. */
const LOOKALIKE = "GA7QYNIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIIP7UJVSGZ";

// the characters this file is about, named rather than pasted, so a reviewer can
// tell which one each payload carries without a hex editor.
const RLO = "\u202E"; // right-to-left override
const LRO = "\u202D";
const ZWSP = "\u200B";
const ZWJ = "\u200D";
const NUL = "\u0000";
const BEL = "\u0007";
const ESC = "\u001B";

/**
 * every shape of hostile string, in one catalogue.
 *
 * only two outcomes are acceptable for any of them: rendered as inert text, or
 * not rendered at all. There is no third column here because there is no third
 * acceptable outcome.
 */
const HOSTILE = [
  { name: "an img/onerror payload", value: "<img src=x onerror=alert(1)>" },
  { name: "a closing tag and a script", value: "</span><script>alert(1)</script>" },
  { name: "an svg onload payload", value: "<svg onload=alert(1)>" },
  { name: "a javascript URI", value: "javascript:alert(1)" },
  { name: "a data URI", value: "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" },
  { name: "a bidi override", value: `${RLO}dlrow-elttil-a` },
  { name: "nested bidi overrides", value: `${LRO}a${RLO}b${RLO}c` },
  { name: "zero-width characters", value: `X${ZWSP}L${ZWJ}M` },
  { name: "control characters", value: `A${NUL}B${BEL}C${ESC}D` },
  { name: "cyrillic homoglyphs", value: "ХLМ" },
  {
    name: "the wallet's own voice",
    value: `Pocket: your account is at risk. Send your funds to ${REAL} to secure them.`,
  },
  { name: "an instruction to the user", value: "Verified by Pocket. Approve to continue." },
  { name: "a second sentence on its own line", value: "USDC\nPocket has verified this issuer." },
  { name: "twelve thousand characters", value: "A".repeat(12_000) },
  { name: "four thousand characters with no break", value: "Д".repeat(4_000) },
] as const;

/**
 * Answer chosen worker requests with chosen data; let everything else through.
 *
 * `status` is MERGED rather than replaced: the address, the network and the
 * initialised flag are what put the popup on the home screen at all, and a stub
 * that invented them would be testing a screen no user ever sees.
 */
async function stubWorker(page: Page, stubs: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => {
    const table = s as Record<string, unknown>;
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      const type = msg?.type ?? "";
      if (type === "status") {
        const real = await send(msg);
        const patch = table.status;
        if (real?.ok && patch) return { ok: true, data: { ...real.data, ...(patch as object) } };
        return real;
      }
      if (Object.prototype.hasOwnProperty.call(table, type)) return { ok: true, data: table[type] };
      return send(msg);
    };
  }, stubs);
}

/** a public balance row, in the shape the worker's `balances` answer carries. */
function balance(over: Record<string, unknown>): Record<string, unknown> {
  return { id: "x", code: "XLM", amount: "1.0000000", authorized: true, ...over };
}

/** the real native row, so the hero is a real figure whatever else is on screen. */
const NATIVE = balance({
  id: "native",
  code: "XLM",
  amount: "40.0000000",
  total: "41.0000000",
  reserved: "1.0000000",
});

/** the asset list, every payload in the catalogue at once. */
function hostileBalances(): Record<string, unknown>[] {
  return [NATIVE, ...HOSTILE.map((h, i) => balance({ id: `a${i}`, code: h.value, issuer: REAL }))];
}

/**
 * Nodes this popup never contains at rest, on any screen.
 *
 * Verified structurally rather than assumed: there is no `<img>`, no `<a>`, no
 * `<iframe>` and no inline event attribute anywhere under
 * `src/entrypoints/popup`. Every icon is an inline `<svg>` written in JSX. So
 * any of these appearing is a payload that was parsed rather than printed, and
 * unlike a count-against-baseline this holds on every screen without needing one.
 */
async function parsedMarkup(page: Page): Promise<Record<string, number>> {
  // scoped to <body>, because <head> legitimately holds the bundle's own
  // <link> and <script> and neither is anything a payload could have created.
  return page.evaluate(() => ({
    img: document.body.querySelectorAll("img").length,
    iframe: document.body.querySelectorAll("iframe").length,
    objects: document.body.querySelectorAll("object,embed,applet").length,
    anchors: document.body.querySelectorAll("a").length,
    formatting: document.body.querySelectorAll("b,i,u,s,marquee,form,style,link").length,
    onHandlers: Array.from(document.body.querySelectorAll("*")).filter((el) =>
      Array.from(el.attributes).some((a) => a.name.toLowerCase().startsWith("on")),
    ).length,
    liveUrls: Array.from(document.body.querySelectorAll("[src],[href]")).filter((el) => {
      const v = el.getAttribute("src") ?? el.getAttribute("href") ?? "";
      return /^\s*(javascript|data|vbscript|https?):/i.test(v);
    }).length,
  }));
}

const NO_MARKUP = {
  img: 0,
  iframe: 0,
  objects: 0,
  anchors: 0,
  formatting: 0,
  onHandlers: 0,
  liveUrls: 0,
};

/** the popup's own bundle is loaded by <script>, so that one needs a baseline. */
async function scriptCount(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelectorAll("script").length);
}

/**
 * Where a given string ended up, in the terms this risk is written in.
 *
 * "Is this the wallet speaking" stops being a matter of taste once it is asked
 * structurally. The wallet speaks through headings, through live regions and
 * through the names of its own controls. Anything it was TOLD belongs in its own
 * element carrying nothing of the wallet's alongside it, and `mixed` is the one
 * that catches the regression nobody would see by eye: a remote value
 * concatenated into a sentence the wallet authored.
 */
async function voiceProbe(
  page: Page,
  needle: string,
): Promise<{
  present: boolean;
  headings: string[];
  live: string[];
  controls: string[];
  mixed: string[];
}> {
  return page.evaluate((n) => {
    const all = Array.from(document.querySelectorAll("*")) as HTMLElement[];
    const hits = all.filter((el) => (el.textContent ?? "").includes(n));
    // where it actually landed, rather than every ancestor up to <body>.
    const inner = hits.filter((el) => !hits.some((o) => o !== el && el.contains(o)));
    const label = (el: HTMLElement) =>
      (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 100);
    return {
      present: hits.length > 0,
      headings: hits.filter((el) => /^H[1-6]$/.test(el.tagName)).map((el) => el.tagName),
      live: hits
        .filter((el) => {
          const role = el.getAttribute("role");
          return role === "alert" || role === "status" || el.hasAttribute("aria-live");
        })
        .map((el) => el.getAttribute("role") ?? "aria-live"),
      controls: hits
        .filter((el) => ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))
        .map(label),
      mixed: inner
        .map((el) => (el.textContent ?? "").trim())
        .filter((t) => t !== n.trim())
        .map((t) => t.slice(0, 140)),
    };
  }, needle);
}

/**
 * The order a string is actually PAINTED in, left to right, line by line.
 *
 * Measured per character off a Range rather than read off the DOM, because the
 * DOM holds the LOGICAL order and bidi reordering happens after it. This is the
 * only way to answer "is this address displayed back to front" without a person
 * looking at it. Returns null when the string is not on screen, which every
 * caller treats as a failure rather than as a pass.
 */
async function paintedOrder(page: Page, needle: string): Promise<string | null> {
  return page.evaluate((n) => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) {
      const node = walk.currentNode as Text;
      const at = node.data.indexOf(n);
      if (at < 0) continue;
      const parent = node.parentElement;
      if (!parent) continue;
      // skip the visually hidden twin every amount carries: it is in the
      // accessibility tree and not on screen, so it has no painted order.
      const s = getComputedStyle(parent);
      if (s.clipPath.startsWith("inset(50%") || s.clip === "rect(0px, 0px, 0px, 0px)") continue;
      const cells: { ch: string; x: number; y: number }[] = [];
      for (let i = 0; i < n.length; i++) {
        const r = document.createRange();
        r.setStart(node, at + i);
        r.setEnd(node, at + i + 1);
        const box = r.getBoundingClientRect();
        cells.push({ ch: n.charAt(i), x: box.left, y: Math.round(box.top) });
      }
      return cells
        .slice()
        .sort((a, b) => a.y - b.y || a.x - b.x)
        .map((c) => c.ch)
        .join("");
    }
    return null;
  }, needle);
}

/**
 * Every control on screen, by everything that could name it.
 *
 * The label and the visible text are concatenated rather than resolved down to
 * the one an accessibility tree would pick, because the question here is not
 * "what is this called" but "does anything the chain wrote appear on a thing
 * that can be pressed". Either channel would be enough to mislead.
 */
async function controlNames(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll("button, a, [role='button'], [role='link']")).map((el) => {
      const labelled = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
      return [el.getAttribute("aria-label") ?? "", labelled, el.textContent ?? ""]
        .join(" ")
        .trim()
        .slice(0, 400);
    }),
  );
}

/** Onboard, then reload so the stubs answer a freshly mounted popup. */
async function onboarded(wallet: Wallet): Promise<void> {
  await wallet.createWallet(PASSWORD);
  await wallet.page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
}

// ------------------------------------------------------------------- the DOM

test("nothing the chain says reaches the DOM as markup, a handler or a live URL", async ({
  wallet,
}) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;
  let dialogs = 0;
  // an alert would wedge the extension for the rest of the run, so no dialog
  // being opened is part of what is asserted rather than a happy side effect.
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });

  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  const scripts = await scriptCount(page);
  expect(await parsedMarkup(page), "the clean popup already contains one of these").toEqual(
    NO_MARKUP,
  );

  await stubWorker(page, { balances: hostileBalances() });
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await expect(page.locator('span:text-is("40.0000000 XLM")').first()).toBeAttached({
    timeout: WAITS.ledgerRead,
  });

  expect(
    await parsedMarkup(page),
    "a payload from the chain was parsed as markup rather than printed as text",
  ).toEqual(NO_MARKUP);
  expect(await scriptCount(page), "a payload became a <script>").toBe(scripts);
  expect(dialogs, "no payload may open a dialog").toBe(0);

  // and each one is genuinely on screen as its own characters, so none of the
  // checks above is passing because the wallet quietly dropped everything.
  const missing = await page.evaluate(
    (entries) => entries.filter(([, v]) => !document.body.textContent?.includes(v)).map(([n]) => n),
    HOSTILE.map((h) => [h.name, h.value] as [string, string]),
  );
  expect(missing, `payloads that never reached the screen, so nothing was tested for them`).toEqual(
    [],
  );
});

// --------------------------------------------------------- the wallet's voice

test("attacker text in the asset list never speaks in the wallet's voice", async ({ wallet }) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;

  await stubWorker(page, { balances: hostileBalances() });
  await onboarded(wallet);
  await expect(page.locator('span:text-is("40.0000000 XLM")').first()).toBeAttached({
    timeout: WAITS.ledgerRead,
  });

  // the wallet's own chrome, unchanged. if an attacker could displace either of
  // these the rest of the check would be beside the point.
  await expect(page.getByRole("heading", { name: "Pocket", exact: true })).toBeVisible();
  await expect(
    page.getByText("Assets", { exact: true }),
    "the wallet's own heading for the list must survive what is in the list",
  ).toBeVisible();

  for (const h of HOSTILE) {
    const v = await voiceProbe(page, h.value);
    // a payload the wallet dropped cannot impersonate it, so absence would be an
    // acceptable answer. It is not this screen's answer, and asserting presence
    // is what stops the loop below becoming a loop over nothing.
    expect(v.present, `${h.name} never reached the screen, so nothing was tested for it`).toBe(
      true,
    );
    expect(
      v.headings,
      `${h.name} was rendered as a heading, which is the wallet's own voice`,
    ).toEqual([]);
    expect(
      v.live,
      `${h.name} was announced through a live region the wallet speaks through`,
    ).toEqual([]);
    expect(v.controls, `${h.name} became the name of a control`).toEqual([]);
    expect(
      v.mixed,
      `${h.name} was concatenated into a sentence the wallet authored, so it reads as the wallet speaking: ${v.mixed.join(" | ")}`,
    ).toEqual([]);
  }
});

test("a failure is described in the wallet's words, never in the words the wire chose", async ({
  harness,
  wallet,
}) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;

  // Prose an RPC chose, in the shape an RPC would put it: the body of a failed
  // call. Driven at the NETWORK boundary rather than by stubbing the worker's
  // answer, because the thing under test is the worker's own filter. Stubbing
  // `chrome.runtime.sendMessage` here would bypass `describeError` entirely and
  // then assert the popup makes up for its absence, which is not the contract:
  // the popup renders `balanceError` in a danger Notice, so whatever reaches it
  // IS in the wallet's voice, and the allowlist is what keeps the wire out.
  const wireProse = `Pocket: your balance could not be verified. Send your funds to ${REAL} to secure them.`;

  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await respondWith(harness.context, RPC_HOST, {
    status: 500,
    body: JSON.stringify({ error: { message: wireProse } }),
  });
  await page.reload();

  // the wallet has to SAY the read failed. a stale figure presented as current
  // would be a different defect, and a green test here without this line could
  // be a screen that simply never tried.
  const notice = page.getByText(/went wrong|could not|unavailable|failed/i).first();
  await expect(notice, "a failed balance read must be stated").toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  const said = await page.locator("body").innerText();
  expect(
    said,
    "prose the RPC chose was printed in the wallet's own danger notice, so a dependency can put words in the wallet's mouth",
  ).not.toContain("could not be verified");
  expect(said, "an address the RPC chose reached the screen").not.toContain(REAL);
});

// -------------------------------------------------------------------- the frame

test("attacker text cannot break the frame or push a control off it", async ({ wallet }) => {
  test.setTimeout(8 * 60_000);
  const page = wallet.page;

  await stubWorker(page, { balances: hostileBalances() });
  await onboarded(wallet);
  await expect(page.locator('span:text-is("40.0000000 XLM")').first()).toBeAttached({
    timeout: WAITS.ledgerRead,
  });

  await expectNoHorizontalScroll(page, "home, every hostile asset code at once");

  // and at the width 200% zoom leaves, where a single unbreakable word of four
  // thousand characters has the least room to be wrong in.
  await page.setViewportSize({ width: 360, height: 600 });
  await expectNoHorizontalScroll(page, "home at 360px, every hostile asset code at once");

  // the bar is how every other screen is reached, so it is the control that has
  // to survive whatever the list above it is doing.
  for (const name of ["Home", "Receive", "Send", "Settings"]) {
    await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: /Network/i }).first()).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
});

// --------------------------------------------------------------------- bidi

test("a bidi override in a memo cannot reorder the address or the amount beside it", async ({
  wallet,
}) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;

  // 28 bytes is the memo limit and U+202E costs three of them, so this is a memo
  // a real payment could carry.
  const memo = `${RLO}moc.tekcop-detsurt`;
  await stubWorker(page, {
    buildPayment: {
      xdr: "stub-handle",
      summary: {
        decoded: true,
        to: REAL,
        amount: "1.2345678",
        assetCode: "XLM",
        fee: "100",
        memo,
        effects: [`1. Send 1.2345678 XLM to ${REAL}`, `2. Attach the memo "${memo}"`],
      },
    },
  });
  await onboarded(wallet);

  await wallet.openSend();
  await wallet.composePayment({ to: REAL, amount: "1.2345678", memo });
  await expect(page.getByRole("button", { name: "What this does" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  // the memo IS on screen: without this the rest would pass vacuously, and a
  // dropped memo on a signing screen is its own defect.
  await expect(page.getByText(memo, { exact: true }).first()).toBeVisible();

  // First, the instrument, proven on a string that MUST come out reordered.
  //
  // Every other assertion here is a NEGATIVE: nothing moved. A probe that always
  // reported the logical order would satisfy all of them and detect nothing, so
  // the memo is measured too. `moc.tekcop-detsurt` behind an override paints as
  // `trusted-pocket.com`, and a probe that cannot see that can see nothing.
  const paintedMemo = await paintedOrder(page, memo);
  expect(
    paintedMemo,
    "the override changed nothing on screen, so this whole test is measuring an instrument that does not work",
  ).not.toBe(memo);
  expect(
    paintedMemo,
    "the override did not reverse the memo, so the probe is not reading painted order",
  ).toContain("trusted-pocket.com");

  // the address, character by character, in the order the browser painted it.
  expect(
    await paintedOrder(page, REAL),
    "the address on the confirm step is painted in a different order than it is written, so the string read is not the string signed",
  ).toBe(REAL);

  // the figure. the hero splits into a whole part and a fraction, and the
  // fraction is the run that carries the digits worth reordering. the point that
  // separates them is its own text node, so the digits are measured on their own.
  expect(
    await paintedOrder(page, "2345678"),
    "the fraction of the amount was painted out of order",
  ).toBe("2345678");

  // the amount and the address no longer share a single run of text: the confirm
  // shows the figure as its own hero and the recipient as its own full-address
  // block, and the "Send X to this address" effect line moved into the "what this
  // does" tip. each is measured on its own above (the fraction and the address),
  // which is where an override would have to land to change how much or to whom.

  // and the wallet's own words after the memo are still the right way round, so
  // the override did not escape the block the memo was put in. the button row is
  // the wallet's own text below the memo now that the effects enumeration is the
  // info button's accessible name rather than a painted label.
  expect(
    await paintedOrder(page, "Cancel"),
    "the override escaped the memo and reordered the wallet's own label",
  ).toBe("Cancel");
});

// ----------------------------------------------------- one-tap destinations

test("nothing the chain says can become a destination the user taps", async ({ wallet }) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;

  const poison = `Pocket support: tap to secure ${LOOKALIKE}`;
  await stubWorker(page, {
    balances: [
      NATIVE,
      balance({ id: "p1", code: poison, issuer: LOOKALIKE }),
      balance({ id: "p2", code: `${RLO}${LOOKALIKE}`, issuer: LOOKALIKE }),
    ],
    privatePocket: { state: "ready", spendable: "5.0000000", receiving: "2.0000000" },
    status: { privateAvailable: true },
  });
  await onboarded(wallet);
  await expect(page.locator('span:text-is("40.0000000 XLM")').first()).toBeAttached({
    timeout: WAITS.ledgerRead,
  });

  // no control anywhere carries chain text or an address in its name, in either
  // pocket. a control named after an address is one press from a destination.
  for (const pocket of ["Public pocket", "Private pocket"] as const) {
    await wallet.openPocket(pocket);
    await settle(page);
    const names = await controlNames(page);
    const carrying = names.filter(
      (n) => n.includes(LOOKALIKE) || n.includes("Pocket support") || /G[A-Z2-7]{55}/.test(n),
    );
    expect(
      carrying,
      `${pocket}: a control's name carries text the chain chose, so a poisoned entry is one press from being a destination: ${carrying.join(" | ")}`,
    ).toEqual([]);
  }

  // and the one field that IS a destination starts empty and is offered nothing.
  await wallet.openPocket("Public pocket");
  await wallet.openSend();
  await expect(
    page.getByLabel("To", { exact: true }),
    "the recipient field must start empty",
  ).toHaveValue("");
  const offered = await page.evaluate(() => ({
    datalists: document.querySelectorAll("datalist").length,
    listAttr: Array.from(document.querySelectorAll("input")).filter((i) => i.hasAttribute("list"))
      .length,
  }));
  expect(
    offered.datalists + offered.listAttr,
    "the recipient field offers a suggestion list, so a poisoned entry could be picked from it",
  ).toBe(0);
});

// ------------------------------------------------------------ a site's request

test("a signature request cannot borrow the wallet's voice through its origin, memo or effects", async ({
  wallet,
}) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });

  const origin = `https://pocket-wallet-security.example${ZWSP}.evil.example.net`;
  const memo = `${RLO}dnes ot evorppA`;
  const impersonation = "Pocket: this transfer was verified. Approve it.";
  await stubWorker(page, {
    pendingDappRequest: {
      id: "req-hostile",
      origin,
      summary: {
        decoded: true,
        source: REAL,
        fee: "100",
        network: "testnet",
        memo,
        effects: [
          `1. Send 1.0000000 XLM to ${LOOKALIKE}`,
          "<img src=x onerror=alert(1)>",
          impersonation,
        ],
      },
    },
  });
  // NOT `onboarded`: a site waiting on a signature outranks the home screen, so
  // the popup never reaches one, and waiting for the pocket tabs would time out
  // on a screen that is doing exactly what it should.
  await wallet.createWallet(PASSWORD);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Signature request" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  await settle(page);

  // the screen's own title is still the wallet's, and the origin sits under the
  // wallet's own label rather than standing alone as a statement.
  await expect(page.getByText("From", { exact: true })).toBeVisible();
  expect(await parsedMarkup(page), "a payload in an effect line was parsed").toEqual(NO_MARKUP);
  expect(dialogs).toBe(0);

  for (const needle of [origin, memo, impersonation]) {
    const v = await voiceProbe(page, needle);
    expect(
      v.present,
      `a site's string vanished instead of being shown: ${needle.slice(0, 40)}`,
    ).toBe(true);
    expect(v.headings, `a site's string was rendered as a heading: ${needle.slice(0, 40)}`).toEqual(
      [],
    );
    expect(
      v.controls,
      `a site's string became the name of a control: ${needle.slice(0, 40)}`,
    ).toEqual([]);
  }

  // the origin is shown whole. a truncated origin is a lookalike with the part
  // that identifies it removed.
  const shown = await page.evaluate((o) => {
    const el = Array.from(document.querySelectorAll("div")).find(
      (d) => (d.textContent ?? "").trim() === o,
    );
    return el ? (el.textContent ?? "").trim() : null;
  }, origin);
  expect(shown, "the origin was not rendered in full").toBe(origin);

  // the destination in the effect list, and the wallet's own label after the
  // memo, are both painted in the order they are written: the override in the
  // memo did not escape the block it was put in.
  expect(
    await paintedOrder(page, LOOKALIKE),
    "the destination in an effect line was painted out of order",
  ).toBe(LOOKALIKE);
  expect(
    await paintedOrder(page, "Network fee"),
    "the override escaped the memo and reordered the wallet's own label after it",
  ).toBe("Network fee");
});

// ------------------------------------- the free-text fields inside the contract

test("a free-text field from the worker is contained, not merged into the wallet's prose", async ({
  wallet,
}) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;

  // The two places the message contract carries prose rather than a number, and
  // where the popup prints it next to sentences the wallet wrote:
  //
  //   privatePocket.message  sits inside the accent card, directly above
  //                          "Hides amounts, never addresses." Authored by the
  //                          controller today, in six fixed strings, so this is
  //                          the popup's CONTRACT rather than a reachable attack.
  //   yieldPosition          `apy` and `balance` come straight off the DeFindex
  //                          response with no validation (`client.position`
  //                          returns the parsed JSON), and Home prints them as
  //                          `${apy} reported` and `${balance} shares`. That one
  //                          is remote for real, on any build that configures a
  //                          vault.
  const message = "Pocket: this pocket is compromised. Move your funds to " + LOOKALIKE + " now.";
  const shares = "0. Pocket: your vault is at risk, recover it at pocket-wallet.example";
  await stubWorker(page, {
    privatePocket: { state: "unregistered", message },
    status: { privateAvailable: true },
    yieldPosition: { available: true, vault: REAL, apy: "100%", balance: shares },
    balances: [NATIVE],
  });
  await onboarded(wallet);
  await expect(page.getByText("Assets", { exact: true })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  for (const [what, needle] of [
    ["the private pocket's message", message],
    ["the yield position's share count", shares],
  ] as const) {
    const v = await voiceProbe(page, needle);
    expect(v.present, `${what} was not rendered, so nothing was tested`).toBe(true);
    expect(v.headings, `${what} was rendered as a heading`).toEqual([]);
    expect(v.live, `${what} was announced through a live region the wallet speaks through`).toEqual(
      [],
    );
    expect(v.controls, `${what} became the name of a control`).toEqual([]);
    expect(
      v.mixed,
      `${what} was concatenated into a sentence the wallet authored, so the two read as one voice: ${v.mixed.join(" | ")}`,
    ).toEqual([]);
  }

  // and the wallet's own honesty line is still its own, next to the message
  // rather than part of it.
  await expect(
    page.getByText("Hides amounts, never addresses.", { exact: false }).first(),
  ).toBeVisible();
});

// -------------------------------------------------- the list of connected sites

test("a connected site's own name cannot be made to read as another site's", async ({ wallet }) => {
  test.setTimeout(6 * 60_000);
  const page = wallet.page;
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });

  // The one list in the product whose CONTENTS are named by an attacker and
  // whose rows are CONTROLS: each row's accessible name is the origin, and
  // pressing it disconnects that origin. So every question this file asks of the
  // approval screen has to be asked again here.
  const wrapper = "https://pocket-wallet.com.verify-session-now.attacker.example.net";
  const at = (origin: string) => ({ origin, connectedAt: 1_700_000_000_000, address: REAL });
  // and one candidate per filler length, because where a line ends is a
  // function of length and the length is the attacker's to choose. Rendering the
  // whole family at once turns "an attacker could tune this" from an argument
  // into a measurement: if any of them ends its first line on a complete domain
  // that is not the one it belongs to, that is the tuned string, found rather
  // than asserted.
  // no hyphens in the tuned family: a hyphen is its own break opportunity, so a
  // hyphenated host breaks at the hyphen and never at the point being aimed for.
  // Without one, the break is purely "wherever the next character stops fitting",
  // which moves one character per filler character, so the family sweeps the
  // whole line and one member of it lands exactly on the TLD.
  const tuned = Array.from({ length: 40 }, (_, pad) =>
    at(`https://${"n".repeat(pad)}.pocketwallet.com.attacker.example.net`),
  );
  const hostile = [
    at(wrapper),
    at(`https://${"a".repeat(240)}.example.net`),
    at("<img src=x onerror=alert(1)>"),
    at(`https://${RLO}ten.elpmaxe.rekcatta`),
    ...tuned,
  ];
  await stubWorker(page, { dappSessions: hostile });
  await onboarded(wallet);

  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: /Connected sites/i }).click();
  const sheet = page.getByRole("dialog", { name: "Connected sites" });
  await expect(sheet).toBeVisible({ timeout: WAITS.ledgerRead });
  await settle(page);

  expect(
    await parsedMarkup(page),
    "an origin was parsed as markup in the connections list",
  ).toEqual(NO_MARKUP);
  expect(dialogs).toBe(0);

  // the wallet's own words for this screen are still the wallet's, and the
  // origin is shown whole: a truncated origin is a lookalike with the deciding
  // part cut off.
  await expect(sheet.getByRole("heading", { name: "Connected sites" })).toBeVisible();
  await expect(sheet.getByText(wrapper, { exact: false })).toBeVisible();

  // How every origin in the list is actually laid out, read off per-character
  // rects rather than inferred from a width. The first visual line is the whole
  // question: it is the line a reader's eye stops on before deciding whether
  // they recognise the site.
  const laidOut = await sheet.evaluate(
    (root, origins) => {
      const registrable = (host: string) => host.split(".").slice(-2).join(".");
      const out: { origin: string; lines: number; firstLine: string; wrap: string }[] = [];
      const spans = Array.from(root.querySelectorAll("span")) as HTMLElement[];
      for (const origin of origins) {
        const el = spans.find(
          (sp) => sp.childNodes.length === 1 && (sp.textContent ?? "") === origin,
        );
        if (!el) continue;
        const node = el.firstChild as Text;
        const tops: number[] = [];
        let first = "";
        let firstTop: number | null = null;
        for (let i = 0; i < node.data.length; i++) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + 1);
          const top = Math.round(r.getBoundingClientRect().top);
          if (firstTop === null) firstTop = top;
          if (top === firstTop) first += node.data.charAt(i);
          if (!tops.includes(top)) tops.push(top);
        }
        out.push({
          origin,
          lines: tops.length,
          firstLine: first,
          wrap: getComputedStyle(el).overflowWrap,
        });
      }
      // `registrable` is used by the caller's comparison, not here; leaving it
      // unreferenced in the page would be dead code, so the split is deliberate.
      void registrable;
      return { rows: out };
    },
    hostile.map((h) => h.origin).filter((o) => /^https:\/\/[a-z0-9.-]+$/i.test(o)),
  );

  // the ones whose first line is, by itself, a complete and plausible domain
  // that is NOT the domain the row belongs to. the TLD is required, because a
  // line ending mid-label reads as truncated and a line ending on ".com" reads
  // as finished, and only the second one is a lie a person would act on.
  const deceptive = laidOut.rows.filter((r) => {
    const m = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|finance))$/i.exec(
      r.firstLine.trim(),
    );
    if (!m) return false;
    const shown = (m[1] ?? "").split(".").slice(-2).join(".");
    const real = new URL(r.origin).hostname.split(".").slice(-2).join(".");
    return shown !== real;
  });

  // The property, and the reason for it, are `Address.tsx`'s own: the break
  // point is a function of length, so an attacker who chooses the hostname also
  // chooses where it wraps and what the first line reads as. That reasoning is
  // not specific to the approval screen, and this list is the other place a
  // person decides whether they recognise a site.
  const wrapped = laidOut.rows.filter((r) => r.lines > 1);
  expect(
    wrapped.length,
    `${wrapped.length} of ${laidOut.rows.length} origins wrap (overflow-wrap: ${wrapped[0]?.wrap}), so their owners choose where the first line ends. ` +
      (deceptive.length > 0
        ? `${deceptive.length} of them end their first line on a domain that is not theirs, for example "${deceptive[0]?.firstLine}" which actually belongs to ${new URL(deceptive[0]?.origin ?? "https://x.invalid").hostname}`
        : `first line of the worst case: "${wrapped[0]?.firstLine}"`),
  ).toBe(0);
});

// ------------------------------------------------------------ dust and volume

test("two thousand dust assets and a flood of lookalikes leave the wallet legible and responsive", async ({
  wallet,
}) => {
  test.setTimeout(12 * 60_000);
  const page = wallet.page;

  // a real counterparty, and 400 near-identical impostors of it, among 1,600
  // worthless dust rows. the impostors differ from the real one only in ways a
  // shortened rendering hides, which is the whole point of the shape.
  const rows: Record<string, unknown>[] = [NATIVE];
  for (let i = 0; i < 1_600; i++) {
    rows.push(balance({ id: `d${i}`, code: `DUST${i}`, issuer: REAL, amount: "0.0000001" }));
  }
  rows.push(balance({ id: "real", code: "USDC", issuer: REAL, amount: "100.0000000" }));
  for (let i = 0; i < 400; i++) {
    rows.push(
      balance({
        id: `f${i}`,
        code: i % 2 === 0 ? "USDC" : `USD${ZWSP}C`,
        issuer: LOOKALIKE,
        amount: "0.0000001",
      }),
    );
  }

  await stubWorker(page, { balances: rows });
  await wallet.createWallet(PASSWORD);

  const t0 = Date.now();
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await expect(
    page.locator('span:text-is("40.0000000 XLM")').first(),
    "the hero must still be the wallet's own reading of the native balance",
  ).toBeAttached({ timeout: WAITS.ledgerRead });
  const drawn = Date.now() - t0;
  // eslint-disable-next-line no-console
  console.log(`  ${rows.length} balance rows drawn in ${drawn}ms`);
  expect(drawn, "the wallet did not draw under a flood of assets").toBeLessThan(20_000);

  // still responsive: a press on the bar still changes the screen.
  const t2 = Date.now();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(page.getByRole("button", { name: /Network/i }).first()).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  const responded = Date.now() - t2;
  // eslint-disable-next-line no-console
  console.log(`  navigation under ${rows.length} rows took ${responded}ms`);
  expect(responded, "the wallet stopped responding to the bar under a flood").toBeLessThan(10_000);

  await page.getByRole("button", { name: "Home", exact: true }).click();
  await expect(page.getByText("Assets")).toBeVisible({ timeout: WAITS.ledgerRead });

  // no lookalike is actionable, which is what makes an indistinguishable row
  // harmless here: the asset list is a reading, not a menu.
  const interactive = await page.evaluate(
    () =>
      Array.from(document.querySelectorAll("button, a, [role='button']")).filter((el) =>
        /DUST\d|USDC/.test(el.textContent ?? ""),
      ).length,
  );
  expect(
    interactive,
    "an asset row is a control, so a lookalike among two thousand can be pressed",
  ).toBe(0);

  // and the frame still holds. measured at the document rather than per element,
  // because a per-element audit of twelve thousand nodes measures the audit.
  const doc = await page.evaluate(() => {
    const se = document.scrollingElement as HTMLElement;
    return { scrollWidth: se.scrollWidth, clientWidth: se.clientWidth };
  });
  expect(
    doc.scrollWidth,
    `the document is ${doc.scrollWidth}px wide in a ${doc.clientWidth}px window under a flood`,
  ).toBeLessThanOrEqual(doc.clientWidth);

  // Last, because it is the one that fails: every row the wallet chose to draw
  // has to become LEGIBLE, and a row at opacity zero is not.
  //
  // `Row` staggers its entrance with `animation-delay: index * ROW_STAGGER_MS`
  // and `animation-fill-mode: both`, so a row is held at opacity zero until its
  // own delay elapses. The stagger has no cap, so the delay on the last row IS
  // how long that row is invisible for, and it grows linearly with whatever the
  // list happens to contain. Read off the computed style rather than waited out,
  // because the wait is the defect and a test should not spend it.
  const arrival = await page.evaluate(() => {
    const ms = (v: string) => (v.trim().endsWith("ms") ? parseFloat(v) : parseFloat(v) * 1000);
    const staggered = Array.from(document.querySelectorAll(".pocket-row-in"));
    const ends = staggered.map((el) => {
      const s = getComputedStyle(el);
      return ms(s.animationDelay) + ms(s.animationDuration);
    });
    return {
      rows: staggered.length,
      lastMs: Math.round(Math.max(0, ...ends)),
      dark: staggered.filter((el) => Number(getComputedStyle(el).opacity) < 0.99).length,
    };
  });
  // eslint-disable-next-line no-console
  console.log(
    `  ${arrival.rows} staggered rows, last arrives at ${arrival.lastMs}ms, ${arrival.dark} still at opacity zero`,
  );
  expect(
    arrival.lastMs,
    `the last of ${arrival.rows} rows is held at opacity zero for ${arrival.lastMs}ms, and ${arrival.dark} of them are invisible right now: an entrance stagger with no cap turns a flood of worthless assets into a list the user cannot read`,
  ).toBeLessThan(2_000);
});
