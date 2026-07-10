// amounts on a real screen: R7 (an amount misparsed by a factor of a thousand)
// and R14 (dust and precision at int64 boundaries), in the shipped extension.
//
// tests/qa/amounts.test.ts asks these questions of the functions. this file
// asks them of the product, because the value path does not end at
// `formatAmount`: it ends at a pixel, in a browser whose language the wallet
// does not choose, and the last few steps are where a number that was exact all
// the way through gets rendered through the locale and read as a different one.
//
// four things are only answerable here:
//
//   1. does anything in the RUNNING popup or the RUNNING service worker convert
//      a money string to a float, or format a number through the locale? the
//      source scan in the unit file reads the code; this traps the conversions
//      as they happen, in the built artifact, with react and the sdk loaded.
//   2. does a change of language BETWEEN typing an amount and confirming it
//      move a digit? that needs a live page, an already-typed value, and a
//      language that changes underneath it.
//   3. does a comma-decimal browser change what a comma means? asked in a
//      chromium that really is in de-DE and in ar-EG, not in one pretending.
//   4. does 922337203685.4775807 fit on a 384px screen and read as itself? the
//      display measures itself, and a measurement is not something a unit test
//      can check.
//
// the trap has one honest limit, stated here rather than discovered later: it
// sees `Number(x)` and `parseFloat(x)`, and it cannot see implicit coercion
// (`+x`, `x * 1`, `x - 0`), for which javascript offers no hook. the source
// scan in amounts.test.ts is the other half of that answer, and neither alone
// is complete.
import { chromium, type BrowserContext, type Page } from "@playwright/test";
import { Keypair } from "@stellar/stellar-sdk/base";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  test,
  expect,
  onboard,
  compose,
  review,
  closeSend,
  fund,
  receiveAddress,
  surfaceText,
  PASSWORD,
  SLOW,
} from "../edge/edge";
import { EXTENSION_PATH } from "../support/extension";

test.use({ actionTimeout: SLOW });

const valid = () => Keypair.random().publicKey();

/** i64 max in stroops, and the same figure as a person types and reads it. */
const I64_MAX_STROOPS = "9223372036854775807";
const I64_MAX_TEXT = "922337203685.4775807";

/* ------------------------------------------------------------------- traps */

/**
 * what the recorder collects, from a page or from the service worker.
 *
 * `alive` is not bookkeeping. an MV3 service worker is killed whenever chrome
 * feels like it, and a recorder installed into a worker that has since
 * restarted reports an empty list that looks exactly like a clean result. the
 * sentinel makes "nothing happened" and "nothing was watching" different
 * answers, which is the difference between evidence and a green tick.
 */
interface Recording {
  alive: boolean;
  floats: string[];
  locale: string[];
}

/**
 * install a recorder in whatever realm this runs in.
 *
 * one self-contained function, because it is serialised into the page and into
 * the worker and so can close over nothing.
 *
 * what counts as a violation is narrow on purpose, exactly as in the unit file:
 * a STRING carrying a decimal point is a money string and nothing else in this
 * wallet looks like one, and a BIGINT outside the safe integer range is a
 * conversion that provably changes the number. a ledger sequence or a unix time
 * is an integer and is not money, so neither is reported and the trap cannot
 * cry wolf.
 */
const RECORDER = () => {
  const g = globalThis as unknown as {
    __pocketQaFloats?: string[];
    __pocketQaLocale?: string[];
    __pocketQaLang?: string;
    Number: NumberConstructor;
    parseFloat: (s: string) => number;
  };
  if (g.__pocketQaFloats) return;
  const floats: string[] = [];
  const locale: string[] = [];
  g.__pocketQaFloats = floats;
  g.__pocketQaLocale = locale;

  const show = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : String(v));
  const suspect = (v: unknown): boolean => {
    if (typeof v === "string") return /^\s*-?\d+\.\d+\s*$/.test(v);
    if (typeof v === "bigint") return v > 9007199254740991n || v < -9007199254740991n;
    return false;
  };
  // three frames of stack, so a hit names the code that did it rather than
  // only that it happened.
  const at = () => (new Error().stack ?? "").split("\n").slice(2, 5).join(" | ").slice(0, 300);

  const OriginalNumber = g.Number;
  g.Number = new Proxy(OriginalNumber, {
    apply(t, thisArg, args: unknown[]) {
      if (suspect(args[0])) floats.push(`Number(${show(args[0])}) @ ${at()}`);
      return Reflect.apply(t as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
  }) as NumberConstructor;

  const originalParseFloat = g.parseFloat;
  g.parseFloat = (v: string) => {
    if (suspect(v)) floats.push(`parseFloat(${show(v)}) @ ${at()}`);
    return originalParseFloat(v);
  };

  const numberToLocale = Number.prototype.toLocaleString;
  Number.prototype.toLocaleString = function (this: number, ...a: unknown[]) {
    locale.push(`Number#toLocaleString(${this}) @ ${at()}`);
    return numberToLocale.apply(this, a as []);
  };
  const bigintToLocale = BigInt.prototype.toLocaleString;
  BigInt.prototype.toLocaleString = function (this: bigint, ...a: unknown[]) {
    locale.push(`BigInt#toLocaleString(${this}) @ ${at()}`);
    return bigintToLocale.apply(this, a as []);
  };
  const OriginalNumberFormat = Intl.NumberFormat;
  Intl.NumberFormat = new Proxy(OriginalNumberFormat, {
    apply(t, thisArg, args: unknown[]) {
      locale.push(`Intl.NumberFormat(${show(args[0])}) @ ${at()}`);
      return Reflect.apply(t as unknown as (...a: unknown[]) => unknown, thisArg, args);
    },
    construct(t, args: unknown[]) {
      locale.push(`new Intl.NumberFormat(${show(args[0])}) @ ${at()}`);
      return Reflect.construct(t as unknown as new (...a: unknown[]) => object, args);
    },
  }) as typeof Intl.NumberFormat;

  // reading the browser's language is the step BEFORE formatting through it, so
  // it is recorded too, and made settable so a test can change the answer
  // halfway through a flow. a wallet that never asks cannot be wrong about it.
  if (typeof navigator !== "undefined") {
    g.__pocketQaLang = navigator.language;
    try {
      Object.defineProperty(navigator, "language", {
        configurable: true,
        get() {
          locale.push(`navigator.language @ ${at()}`);
          return g.__pocketQaLang;
        },
      });
      Object.defineProperty(navigator, "languages", {
        configurable: true,
        get() {
          locale.push(`navigator.languages @ ${at()}`);
          return [g.__pocketQaLang as string];
        },
      });
    } catch {
      locale.push("navigator.language could not be instrumented");
    }
  }
};

const COLLECT = (): Recording => {
  const g = globalThis as unknown as {
    __pocketQaFloats?: string[];
    __pocketQaLocale?: string[];
  };
  return {
    alive: Array.isArray(g.__pocketQaFloats),
    floats: g.__pocketQaFloats ?? [],
    locale: g.__pocketQaLocale ?? [],
  };
};

/* ----------------------------------------------------------------- reading */

/**
 * every figure the popup states EXACTLY, read from the dom rather than matched.
 *
 * the exact value lives in an off-screen span that carries `${value} ${code}`,
 * because reading a balance out of the three visual runs gives a screen reader
 * "nine thousand, point, zero zero zero". that span is the value; everything
 * visual is a presentation of it, and a test comparing the two is checking the
 * presentation has not moved a digit.
 */
async function exactFigures(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("span")]
      .map((s) => (s.textContent ?? "").trim())
      .filter((t) => /^-?[\d.]+(\s+[A-Za-z]{1,12})?$/.test(t)),
  );
}

/** every figure the popup DRAWS: the grouped, aria-hidden runs. */
async function visualFigures(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll("span[aria-hidden]")]
      .map((s) => (s.textContent ?? "").trim())
      .filter((t) => /^-?[\d,]+(\.\d+)?$/.test(t)),
  );
}

/** drop trailing zeros from the FRACTION only. "100.0000000" is 100, not 1. */
function trimZeros(s: string): string {
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/** the canonical seven-place form of what a user typed. */
function canonical(typed: string): string {
  const [whole = "0", frac = ""] = typed.split(".");
  return `${whole}.${frac.padEnd(7, "0")}`;
}

/**
 * onboard, fund, and wait until the home screen is showing a NON-ZERO balance.
 *
 * the non-zero part is the whole point and it cost this file a wrong green.
 * friendbot's payment lands after the home screen has already read the ledger
 * and nothing re-reads it on a timer, so the hero sits at 0.0000000 with "this
 * account does not exist on the network yet" underneath it. that figure matches
 * every "a seven-place number is on screen" wait, so the first version of this
 * helper returned on an unfunded wallet, the reserve caption never rendered,
 * and the one piece of arithmetic the ui does on a balance was never executed
 * while the recorder was watching. the send itself still worked, because the
 * WORKER re-reads the ledger when it builds, which is exactly what made the
 * mistake invisible.
 */
async function funded(page: Page): Promise<void> {
  await onboard(page);
  await fund(await receiveAddress(page));
  await expect
    .poll(
      async () => {
        const hero = page.getByText(/^[\d,]+\.\d{7}$/).first();
        // "" for BOTH "no figure yet" and "a figure of zero": they are the same
        // answer to the only question being asked, and treating the first as a
        // different one is what let the shimmer satisfy this.
        const shown =
          (await hero.count()) > 0
            ? (await hero.innerText()).replace(/\D/g, "").replace(/^0+/, "")
            : "";
        if (shown !== "") return true;
        // check BEFORE reloading and then leave the next read a whole interval
        // away, or the reload aborts the ledger call it is waiting for and the
        // screen never gets far enough to answer.
        await page.reload();
        return false;
      },
      {
        timeout: 90_000,
        intervals: [4000],
        message: "the home screen never showed a funded balance",
      },
    )
    .toBe(true);
}

/**
 * float wreckage, by the shapes it leaves behind.
 *
 * two things this had to learn the hard way, both from a random keypair.
 *
 * a stellar address is base32 over [A-Z2-7], so "GA7E2..." contains "7E2" and
 * an exponent pattern of `\d[eE][+-]?\d` matches roughly one address in three.
 * that made this check fail on about a third of runs for a reason that had
 * nothing to do with amounts. the sign is not optional: javascript writes
 * exponential form as "1e+21" or "1e-7", always with it, and base32 has no
 * sign character, so requiring it separates the two exactly. addresses are
 * stripped as well, so a future pattern cannot rediscover the same trap.
 */
function assertNoFloatArtefact(body: string, where: string): void {
  const withoutAddresses = body.replace(/[A-Z2-7]{20,}/g, "«address»");
  expect(withoutAddresses, `${where}: an exponent reached the screen`).not.toMatch(
    /\d[eE][+-]\d/,
  );
  expect(withoutAddresses, `${where}: more than seven decimal places`).not.toMatch(/\d\.\d{8,}/);
  for (const artefact of ["NaN", "Infinity", "[object "]) {
    expect(withoutAddresses, `${where}: "${artefact}" on a screen about money`).not.toContain(
      artefact,
    );
  }
}

/* ------------------------------------------------------------------- tests */

test("nothing in the running popup or worker turns an amount into a float", async ({
  harness,
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  await page.addInitScript(RECORDER);
  // the harness navigated this popup already, so the recorder goes in and the
  // document starts again; otherwise the first render is unwatched and the
  // first render is where the balance is drawn.
  await page.reload();
  const worker = await harness.worker();
  await worker.evaluate(RECORDER);

  // one whole public send, which touches every amount surface the wallet has on
  // the way to a signature: the hero, the reserve caption, the compose field,
  // the review panel's figure and its effects list.
  await funded(page);
  await compose(page, { to: valid(), amount: "1.2345678" });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");

  const inPopup: Recording = await page.evaluate(COLLECT);
  const inWorker: Recording = await worker.evaluate(COLLECT);

  expect(inPopup.alive, "the popup recorder was lost, so its silence proves nothing").toBe(true);
  expect(
    inWorker.alive,
    "the service worker restarted and took the recorder with it, so its silence proves nothing",
  ).toBe(true);

  expect(
    [...inPopup.floats, ...inWorker.floats],
    "a money string was converted to a floating-point number in the running wallet",
  ).toEqual([]);
  expect(
    [...inPopup.locale, ...inWorker.locale],
    "an amount was formatted through the browser's locale, so what is on screen depends on " +
      "which language the browser happens to be in",
  ).toEqual([]);
});

test("changing the browser's language between typing and confirming moves no digit", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  await page.addInitScript(RECORDER);
  await page.reload();
  await funded(page);

  const typed = "1.2345678";
  await compose(page, { to: valid(), amount: typed });

  // the language changes AFTER the amount is typed and BEFORE it is confirmed.
  // this is the real sequence, not a contrivance: a user switches their browser
  // language, or the popup is reopened on a profile that reports a different
  // one, between composing and approving. a wallet that read the language at
  // render time would show one number in the field and another on the confirm
  // screen, and both would look right on their own.
  const setLanguage = (lang: string) =>
    page.evaluate((l) => {
      (globalThis as unknown as { __pocketQaLang?: string }).__pocketQaLang = l;
    }, lang);

  await setLanguage("de-DE");
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");

  expect(await exactFigures(page), "the confirm screen must state the typed amount exactly").toContain(
    `${typed} XLM`,
  );
  await expect(page.getByText(`Send ${typed} XLM to this address`)).toBeVisible();
  const afterGerman = await surfaceText(page);

  await setLanguage("ar-EG");
  // give a language-dependent component the chance to redraw before this is
  // read again; otherwise a stale paint would pass the comparison for free.
  await page.evaluate(() => globalThis.dispatchEvent(new Event("resize")));
  await expect(page.getByText(`Send ${typed} XLM to this address`)).toBeVisible();
  expect(
    await surfaceText(page),
    "the confirm screen changed when the browser's reported language did",
  ).toBe(afterGerman);

  // and nothing ever asked what the language was, which is WHY it cannot
  // matter. the comparison above could pass by luck on a screen that had not
  // repainted; this cannot.
  const recorded: Recording = await page.evaluate(COLLECT);
  expect(recorded.alive).toBe(true);
  expect(recorded.locale, "the wallet consulted the browser's locale while showing an amount").toEqual(
    [],
  );
  // `recorded.floats` is deliberately NOT asserted here. the float question
  // belongs to the test above, which owns it and reports it once; repeating it
  // would turn one defect into two red lines and tell a reader nothing new
  // about the language change this test is actually about.
  assertNoFloatArtefact(afterGerman, "confirm screen");
});

/**
 * the same send, in a browser that really is in another language.
 *
 * separate from the tests above because it needs its OWN chromium: the shared
 * harness launches one browser per test with no locale set, and a locale is
 * fixed at launch. de-DE is the comma-decimal case R7 is named after; ar-EG is
 * in the list for its digits, which are not the ones this wallet writes, and
 * for the direction it lays text out in.
 */
for (const locale of ["de-DE", "ar-EG"]) {
  test(`an amount reads the same in a ${locale} browser as in an en-US one`, async () => {
    test.slow();
    const dir = mkdtempSync(join(tmpdir(), "pocket-qa-locale-"));
    let context: BrowserContext | null = null;
    try {
      context = await chromium.launchPersistentContext(dir, {
        channel: "chromium",
        locale,
        args: [
          `--disable-extensions-except=${EXTENSION_PATH}`,
          `--load-extension=${EXTENSION_PATH}`,
          `--lang=${locale}`,
        ],
        timeout: 300_000,
      });
      let [sw] = context.serviceWorkers();
      if (!sw) sw = await context.waitForEvent("serviceworker");
      const id = new URL(sw.url()).host;
      const page = await context.newPage();
      await page.goto(`chrome-extension://${id}/popup.html`);

      // the browser really is in this locale, or the rest of this is about
      // nothing. asserted from INSIDE the page rather than from the launch
      // options, which are a request and not a fact.
      const reported = await page.evaluate(() => ({
        language: navigator.language,
        decimal:
          new Intl.NumberFormat(undefined, { minimumFractionDigits: 1 })
            .formatToParts(1.5)
            .find((p) => p.type === "decimal")?.value ?? "?",
      }));
      expect(
        reported.language.toLowerCase(),
        "the browser did not take the locale, so this test would prove nothing",
      ).toContain(locale.slice(0, 2));

      await funded(page);

      // 1. this locale's own way of writing one and a half. it must be refused
      //    AS AN AMOUNT, and it must never become fifteen.
      if (reported.decimal !== ".") {
        const typedComma = `1${reported.decimal}5`;
        await compose(page, { to: valid(), amount: typedComma });
        const refused = await review(page);
        expect(refused.stage, `"${typedComma}" reached the confirm screen in ${locale}`).toBe(
          "error",
        );
        const said = refused.stage === "error" ? refused.message : "";
        expect(said, "a decimal comma must not be reported as a connection problem").not.toMatch(
          /check your connection/i,
        );
        expect(said, "the refusal must name the amount, which is the thing to fix").toMatch(
          /amount|decimal|digits/i,
        );
        await closeSend(page);
      }

      // 2. a well-formed amount shows the digits that were typed, in the digits
      //    this wallet writes, whichever digits the locale would prefer.
      const typed = "1.2345678";
      await compose(page, { to: valid(), amount: typed });
      const out = await review(page);
      expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");
      expect(await exactFigures(page), `${locale}: the typed amount is not stated exactly`).toContain(
        `${typed} XLM`,
      );

      const body = await surfaceText(page);
      // no other script's digits anywhere on a screen about money. if the
      // locale reached a formatter, an ar-EG build would draw ١٫٢ here and a
      // user comparing it with what they typed would have nothing to compare.
      expect(
        body.match(/[٠-٩۰-۹०-९０-９]/g) ?? [],
        `${locale}: a non-ASCII digit reached a screen showing money`,
      ).toEqual([]);
      assertNoFloatArtefact(body, locale);
    } finally {
      await context?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("the largest balance Stellar can hold reads as itself on a 384px screen", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;

  // R14's top boundary, on a real surface.
  //
  // the approval screen renders the network fee through the popup's OWN
  // stroops-to-XLM conversion (`feeInXlm` in DappApproval.tsx), which is a
  // second implementation of `formatAmount` living in the ui. nothing else in
  // the suite exercises it, and a second implementation of a money function is
  // exactly where the two drift apart. the request is parked the way the worker
  // parks a real one; everything after that is the shipped component.
  await page.addInitScript(() => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    (chrome.runtime as unknown as { sendMessage: unknown }).sendMessage = async (msg: {
      type?: string;
    }) => {
      // read per call, so one init script serves every case and a reload picks
      // up the next one. stacking four init scripts would leave the first one
      // answering for all four.
      const fee = localStorage.getItem("pocket-qa-fee");
      if (msg?.type === "pendingDappRequest" && fee) {
        return {
          ok: true,
          data: {
            id: "req-amount",
            origin: "https://example.test",
            summary: {
              decoded: true,
              source: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
              fee,
              network: "testnet",
              effects: ["1. Send 922337203685.4775807 XLM to somewhere"],
            },
          },
        };
      }
      return send(msg);
    };
  });
  await wallet.createWallet(PASSWORD);

  const fees = [
    { stroops: "1", xlm: "0.0000001" },
    { stroops: "9999999", xlm: "0.9999999" },
    { stroops: "10000000", xlm: "1.0000000" },
    { stroops: I64_MAX_STROOPS, xlm: I64_MAX_TEXT },
  ];

  for (const fee of fees) {
    await page.evaluate((f) => localStorage.setItem("pocket-qa-fee", f), fee.stroops);
    await page.reload();
    await expect(page.getByText("Network fee")).toBeVisible({ timeout: SLOW });

    expect(
      await exactFigures(page),
      `a fee of ${fee.stroops} stroops must read as ${fee.xlm} XLM`,
    ).toContain(`${fee.xlm} XLM`);

    const body = await surfaceText(page);
    assertNoFloatArtefact(body, `fee ${fee.stroops}`);
    // the visible, grouped run has to reduce to the same digits. an accessible
    // string that is right beside a visible one that is wrong is the worst of
    // both, because only one of them is ever read.
    const visual = await visualFigures(page);
    expect(
      visual.map((v) => trimZeros(v.replace(/,/g, ""))),
      `fee ${fee.stroops}: the drawn figure is not the value. drawn: ${visual.join(" | ")}`,
    ).toContain(trimZeros(fee.xlm));
  }

  // the maximum is fifteen whole digits and seven more. the component's own
  // comment says a hero at full size would be 390px of digits in a 348px
  // column, which is why it measures itself. so the last question is whether
  // it actually fits, measured rather than taken from the type scale.
  const frame = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(
    frame.scroll,
    `the approval screen scrolls sideways at ${frame.scroll}px in a ${frame.client}px frame, so ` +
      "part of the largest figure is off the side of the one screen whose job is to state it",
  ).toBeLessThanOrEqual(frame.client + 1);
  expect(await surfaceText(page), "a money figure was truncated with an ellipsis").not.toMatch(
    /\d…|…\d/,
  );
});

test("what the confirm screen draws re-parses to the stroops that were typed", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  await funded(page);

  // both ends of the format in one flow. the existing edge suite asserts the
  // refusals; this asserts that the figure reaching the confirm screen still IS
  // the amount, in both the exact run and the grouped one. a display bug breaks
  // this without changing any refusal, so no existing test would notice.
  for (const typed of ["0.0000001", "1.2345678", "1.5", "0.1000000", "1000.0000001"]) {
    await compose(page, { to: valid(), amount: typed });
    const out = await review(page);
    expect(out.stage, `${typed}: ${out.stage === "error" ? out.message : ""}`).toBe("confirm");

    const want = canonical(typed);
    expect(await exactFigures(page), `${typed}: the exact figure is not ${want}`).toContain(
      `${want} XLM`,
    );
    await expect(page.getByText(`Send ${want} XLM to this address`)).toBeVisible();

    const visual = await visualFigures(page);
    expect(
      visual.map((v) => trimZeros(v.replace(/,/g, ""))),
      `${typed}: no drawn figure equals the value. drawn: ${visual.join(" | ")}`,
    ).toContain(trimZeros(want));

    assertNoFloatArtefact(await surfaceText(page), typed);
    await closeSend(page);
  }
});

