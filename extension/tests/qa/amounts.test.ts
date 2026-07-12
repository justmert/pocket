// amounts, at the unit and the property level: R7 (an amount misparsed by a
// factor of a thousand) and R14 (dust and precision at int64 boundaries).
//
// the existing suites already ask whether a bad amount is REFUSED and whether
// the refusal NAMES the amount (tests/edge/amount.spec.ts) and whether one
// round trip is exact (src/core/chain/amount.test.ts). this file asks the two
// questions neither of them can:
//
//   1. is there a floating-point number ANYWHERE in the value path, ever? that
//      is not answerable by example, because a float is exact for almost every
//      value you would think to try. it is answerable by trapping the
//      conversions themselves and by reading the source, and both are done
//      here.
//   2. does a locale change the number? "1,5" must be 1.5 or a refusal and
//      never 15, in every locale, on entry, on display, and across a change of
//      locale between the two. this is the single most common silent loss in
//      wallets and it is a PARSING question, so it is asked here rather than on
//      screen; the screen half lives in amounts-ui.spec.ts.
//
// fast-check is not a dependency and adding one to a wallet for a test is not a
// trade worth making, so the generators below are hand written, seeded, and
// print their seed on every failure. QA_SEED overrides.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  Account,
  Asset,
  Keypair,
  MuxedAccount,
  Networks,
  Operation,
  Transaction,
  TransactionBuilder,
} from "@stellar/stellar-sdk/base";
import {
  formatAmount,
  parseAmount,
  InvalidAmountError,
  STROOPS_PER_UNIT,
} from "../../src/core/chain/balances";
import {
  parseAddress,
  isValidAddress,
  chunkAddress,
  InvalidAddressError,
} from "../../src/core/chain/address";
import { buildPayment, MEMO_TEXT_MAX_BYTES, MemoTooLongError } from "../../src/core/chain/payment";
import { moveBody, DefindexError } from "../../src/core/integrations/defindex";
import { outgoingNative } from "../../src/core/provider/describe-tx";
import { splitAmount } from "../../src/entrypoints/popup/ui/Amount";

/* ------------------------------------------------------------------ seeded */

/**
 * one seed for the whole file, printed with every generated failure.
 *
 * a property test that cannot be replayed is an anecdote. every message that
 * reports a generated counterexample carries the seed AND the value, so the
 * failure is reproducible from the log alone without rerunning anything.
 */
const SEED = Number(process.env.QA_SEED ?? 0x50cce7);
const seeded = (label: string) => `seed=${SEED} (QA_SEED=${SEED}) case=${label}`;

/** mulberry32: 32 bits of state, no dependency, identical run to run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** a bigint in [0, n), built from bytes so the range is not a float. */
function below(r: () => number, n: bigint): bigint {
  if (n <= 0n) return 0n;
  const bits = n.toString(2).length;
  const chunks = Math.ceil(bits / 16);
  for (;;) {
    let v = 0n;
    for (let i = 0; i < chunks; i++) v = (v << 16n) | BigInt(Math.floor(r() * 65536));
    v %= n;
    return v;
  }
}

const I64_MAX = 9223372036854775807n;
const I64_MIN = -9223372036854775808n;
const I64_MAX_TEXT = "922337203685.4775807";

/**
 * every boundary that has ever cost anyone money, plus a seeded spread.
 *
 * the fixed half is not decoration: a purely random corpus over 2^63 almost
 * never lands on zero, on one stroop, or on 2^53, and those are exactly the
 * three a float implementation gets wrong.
 */
function corpus(count = 400): bigint[] {
  const fixed = [
    0n,
    1n, // one stroop, the dust boundary
    -1n,
    9_999_999n, // one stroop under a whole unit
    STROOPS_PER_UNIT,
    STROOPS_PER_UNIT + 1n,
    10_000_000_000n,
    9007199254740991n, // Number.MAX_SAFE_INTEGER, in stroops
    9007199254740992n, // 2^53: the first integer a double cannot count past
    9007199254740993n, // 2^53+1: a double rounds this DOWN to 2^53
    -9007199254740993n,
    I64_MAX,
    I64_MAX - 1n,
    I64_MIN,
    I64_MIN + 1n,
    4611686018427387904n, // 2^62
    1234567890123456789n,
  ];
  const r = rng(SEED);
  const generated: bigint[] = [];
  for (let i = 0; i < count; i++) {
    // three magnitudes on purpose: dust, human, and the top of the range. a
    // uniform draw over 2^63 is all top-of-range and would never exercise the
    // fraction padding at all.
    const scale = i % 3 === 0 ? 10_000_000n : i % 3 === 1 ? 10_000_000_000_000n : I64_MAX;
    const v = below(r, scale);
    generated.push(i % 5 === 0 ? -v : v);
  }
  return [...fixed, ...generated];
}

/**
 * an independent, exact stroops formatter written by hand.
 *
 * the point of a differential test is that the two implementations do not share
 * a mistake, so this one does no bigint division: it works on the DIGIT STRING,
 * which is the one representation that cannot round.
 */
function refFormat(v: bigint): string {
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(8, "0");
  const whole = digits.slice(0, digits.length - 7).replace(/^0+(?=\d)/, "");
  const frac = digits.slice(digits.length - 7);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

/** the same, in reverse. returns null for anything it refuses. */
function refParse(text: string): bigint | null {
  const s = text.trim();
  const m = /^(-?)([0-9]+)(?:\.([0-9]*))?$/.exec(s);
  if (!m) return null;
  const [, sign, whole, frac = ""] = m;
  if (frac.length > 7) return null;
  const joined = `${whole}${frac.padEnd(7, "0")}`.replace(/^0+(?=\d)/, "");
  const v = BigInt(joined);
  return sign === "-" ? -v : v;
}

/* --------------------------------------------------- no float, by trapping */

interface Trap {
  hits: string[];
  restore(): void;
}

/**
 * record every conversion of a value into a floating-point number.
 *
 * a Proxy rather than a replacement function, because `formatAmount` calls
 * `Number.isInteger` on its `decimals` argument and a bare function would have
 * no such property. `get` forwards, `apply` records: the distinction is exactly
 * the one that matters, since reading `Number.isInteger` is not a conversion
 * and `Number(x)` is.
 *
 * what counts as a violation is deliberately narrow, so this cannot be dodged
 * by argument and cannot cry wolf:
 *   - a STRING carrying a decimal point. that is a money string and nothing
 *     else in this wallet looks like one; a ledger sequence or a unix time is
 *     an integer.
 *   - a BIGINT outside the safe integer range, where the conversion provably
 *     changes the number.
 */
function trapFloats(): Trap {
  const hits: string[] = [];
  const OriginalNumber = globalThis.Number;
  const originalParseFloat = globalThis.parseFloat;
  const originalNumberToLocale = Number.prototype.toLocaleString;
  const originalBigIntToLocale = BigInt.prototype.toLocaleString;
  const originalNumberFormat = Intl.NumberFormat;

  const suspect = (v: unknown): boolean => {
    if (typeof v === "string") return /^\s*-?\d+\.\d+\s*$/.test(v);
    if (typeof v === "bigint") return v > 9007199254740991n || v < -9007199254740991n;
    return false;
  };
  const note = (what: string, v: unknown) => {
    hits.push(`${what}(${typeof v === "string" ? JSON.stringify(v) : String(v)})`);
  };

  globalThis.Number = new Proxy(OriginalNumber, {
    apply(target, thisArg, args: unknown[]) {
      if (suspect(args[0])) note("Number", args[0]);
      return Reflect.apply(target as (...a: unknown[]) => unknown, thisArg, args);
    },
  }) as NumberConstructor;
  globalThis.parseFloat = ((v: string) => {
    note("parseFloat", v);
    return originalParseFloat(v);
  }) as typeof parseFloat;
  // toLocaleString is the other half of the same question: a number that is
  // never converted to a float can still be RENDERED through the locale, and
  // then the digits on screen are not the digits in the value.
  Number.prototype.toLocaleString = function (this: number, ...a: unknown[]) {
    note("Number.prototype.toLocaleString", this);
    return originalNumberToLocale.apply(this, a as []);
  };
  BigInt.prototype.toLocaleString = function (this: bigint, ...a: unknown[]) {
    note("BigInt.prototype.toLocaleString", this);
    return originalBigIntToLocale.apply(this, a as []);
  };
  Intl.NumberFormat = new Proxy(originalNumberFormat, {
    apply(t, thisArg, args: unknown[]) {
      hits.push("Intl.NumberFormat()");
      return Reflect.apply(t as (...a: unknown[]) => unknown, thisArg, args);
    },
    construct(t, args: unknown[]) {
      hits.push("new Intl.NumberFormat()");
      return Reflect.construct(t as new (...a: unknown[]) => object, args);
    },
  }) as typeof Intl.NumberFormat;

  return {
    hits,
    restore() {
      globalThis.Number = OriginalNumber;
      globalThis.parseFloat = originalParseFloat;
      Number.prototype.toLocaleString = originalNumberToLocale;
      BigInt.prototype.toLocaleString = originalBigIntToLocale;
      Intl.NumberFormat = originalNumberFormat;
    },
  };
}

describe("no floating point in the value path", () => {
  it("parsing, formatting and splitting a value convert nothing to a float", () => {
    const values = corpus(200);
    const trap = trapFloats();
    try {
      for (const v of values) {
        const text = formatAmount(v);
        parseAmount(text);
        splitAmount(text);
        for (let d = 0; d <= 7; d++) formatAmount(v, d);
      }
    } finally {
      trap.restore();
    }
    expect(
      [...new Set(trap.hits)],
      `${seeded("value-path trap")}: an amount went through a floating-point conversion`,
    ).toEqual([]);
  });

  it("the trap itself can see a float, so its silence means something", () => {
    // a test that cannot fail is decoration. this is the naive implementation
    // the trap exists to catch, run through the same instrument.
    const trap = trapFloats();
    try {
      const naive = Number("922337203685.4775807") * 1e7;
      expect(naive).toBeGreaterThan(0);
    } finally {
      trap.restore();
    }
    expect(trap.hits, "the trap must record a Number() on a money string").toContain(
      'Number("922337203685.4775807")',
    );
  });

  it("parseAmount returns a bigint for every value it accepts, never a number", () => {
    for (const v of corpus(120)) {
      const back = parseAmount(formatAmount(v));
      expect(typeof back, `${seeded(String(v))}: parseAmount must return bigint`).toBe("bigint");
    }
  });

  it("a double loses the values this wallet must hold, which is why bigint is not a style choice", () => {
    // stated as an assertion rather than a comment so the premise of every
    // other test in this file is itself checked. if a future JS engine made
    // these exact, the argument would need rewriting, not assuming.
    //
    // the comparison has to be made in bigint. writing the expected value as a
    // numeric LITERAL would compare two doubles, both rounded the same way,
    // and the test would pass while proving nothing: 9223372036854775807 is
    // not a JS number, it is 9223372036854775808 wearing its name.
    const viaFloat = BigInt(Number(I64_MAX_TEXT) * 1e7);
    expect(viaFloat).not.toBe(I64_MAX);
    // one stroop over, and over the int64 ceiling entirely: the float lands on
    // 2^63, which no ledger entry can hold.
    expect(viaFloat - I64_MAX).toBe(1n);
    expect(viaFloat).toBe(1n << 63n);
    expect(Number(9007199254740993n)).toBe(9007199254740992);
    expect(0.1 + 0.2).not.toBe(0.3);
    // and the exact path holds every one of them.
    expect(parseAmount(I64_MAX_TEXT)).toBe(I64_MAX);
    expect(parseAmount("900719925.4740993")).toBe(9007199254740993n);
    expect(parseAmount("0.1") + parseAmount("0.2")).toBe(parseAmount("0.3"));
  });
});

/* ------------------------------------------- precision, rounding, the range */

describe("precision across the whole representable range", () => {
  it("round-trips every value in the corpus, exactly", () => {
    for (const v of corpus()) {
      const text = formatAmount(v);
      expect(parseAmount(text), `${seeded(String(v))}: round trip changed the value`).toBe(v);
    }
  });

  it("agrees digit for digit with an independent implementation", () => {
    // two implementations that share no arithmetic. a mistake has to be made
    // twice, in two different ways, to survive this.
    for (const v of corpus()) {
      const mine = formatAmount(v);
      expect(mine, `${seeded(String(v))}: formatAmount disagrees with the reference`).toBe(
        refFormat(v),
      );
      expect(parseAmount(mine), `${seeded(String(v))}: parseAmount disagrees`).toBe(refParse(mine));
    }
  });

  it("the maximum representable balance survives a full round trip unchanged", () => {
    expect(formatAmount(I64_MAX)).toBe(I64_MAX_TEXT);
    expect(parseAmount(I64_MAX_TEXT)).toBe(I64_MAX);
    expect(formatAmount(parseAmount(I64_MAX_TEXT))).toBe(I64_MAX_TEXT);
    // and through the display split, which is what a person actually reads.
    const { whole, fraction } = splitAmount(I64_MAX_TEXT);
    expect(whole).toBe("922,337,203,685");
    expect(fraction).toBe("4775807");
    expect(parseAmount(`${whole.replace(/,/g, "")}.${fraction}`)).toBe(I64_MAX);
  });

  it("the maximum survives the XDR the ledger will actually see", () => {
    // the SDK boundary is the one place a decimal string becomes an int64 and
    // comes back. everything above is our own code agreeing with itself; this
    // is the wire.
    const source = Keypair.random().publicKey();
    const tx = buildPayment(
      new Account(source, "1"),
      { from: source, to: Keypair.random().publicKey(), asset: Asset.native(), amount: I64_MAX },
      Networks.TESTNET,
    );
    const back = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET);
    const op = back.operations[0];
    expect(op?.type).toBe("payment");
    const shown = (op as { amount: string }).amount;
    expect(shown, "the maximum must come back off the wire unchanged").toBe(I64_MAX_TEXT);
    expect(parseAmount(shown)).toBe(I64_MAX);
  });

  it("one stroop above the maximum cannot be built into a payment", () => {
    // `parseAmount` has no int64 bound of its own: it is a decimal parser and
    // bigint has no width, so 922337203685.4775808 parses cleanly. the bound
    // therefore has to be held further down, and this is where.
    //
    // recorded while writing this, because the test does not assert it and a
    // reader should not have to rediscover it: what the builder throws here is
    // the sdk's bare TypeError, whose NAME is not on `describeError`'s
    // allowlist, so a caller sees "Something went wrong. Try again, and check
    // your connection." for an amount that is simply too large. through the
    // popup that never happens, because `doBuildPayment` checks the balance
    // first and refuses with a sentence that names the amount -- but that check
    // is inside `if (asset.isNative())`, and `assetId` comes off the message
    // channel, so a non-native `CODE:ISSUER` reaches the builder unchecked.
    // reported as a finding rather than asserted: the popup only ever sends
    // "native", so no user can reach it today.
    const source = Keypair.random().publicKey();
    const over = I64_MAX + 1n;
    expect(formatAmount(over)).toBe("922337203685.4775808");
    expect(() =>
      buildPayment(
        new Account(source, "1"),
        { from: source, to: Keypair.random().publicKey(), asset: Asset.native(), amount: over },
        Networks.TESTNET,
      ),
    ).toThrow();
  });

  it("dust is dust and never zero", () => {
    expect(formatAmount(1n)).toBe("0.0000001");
    expect(parseAmount("0.0000001")).toBe(1n);
    // the display split keeps it too: a hero that drops the fraction here shows
    // a balance of nothing to somebody who has something.
    expect(splitAmount("0.0000001")).toEqual({ whole: "0", fraction: "0000001" });
    // and truncating the display to fewer places must not invent a zero
    // balance silently: it states the truncation by being a different call.
    expect(formatAmount(1n, 2)).toBe("0.00");
  });

  it("truncates for display and never rounds, at every width", () => {
    for (const v of corpus(150)) {
      const full = formatAmount(v);
      for (let d = 0; d <= 7; d++) {
        const cut = formatAmount(v, d);
        // truncation towards zero means the shown string is a literal prefix of
        // the full one. rounding 1.2345678 to 1.23 at width 2 would be a
        // DIFFERENT number presented as this one.
        const expected = d === 0 ? full.split(".")[0] : full.slice(0, full.indexOf(".") + 1 + d);
        expect(cut, `${seeded(`${v} @ ${d}dp`)}: display width rounded instead of truncating`).toBe(
          expected,
        );
      }
    }
  });

  it("refuses a decimals width it cannot honour rather than silently clamping", () => {
    for (const d of [-1, 8, 1.5, NaN, Infinity]) {
      expect(() => formatAmount(1n, d), `decimals=${d}`).toThrow(/decimals must be/);
    }
  });

  it("keeps trailing zeros as value and rejects a place past the seventh even when it is a zero", () => {
    expect(parseAmount("1.5000000")).toBe(15_000_000n);
    expect(parseAmount("1.5")).toBe(15_000_000n);
    expect(parseAmount("1.50")).toBe(15_000_000n);
    // the stated rule is REJECT, not truncate. a zero in the eighth place
    // carries no value and is still refused, and that is the right trade: a
    // parser that quietly drops "the ones that do not matter" is one edit away
    // from quietly dropping one that does.
    for (const eight of ["1.50000000", "1.23456780", "0.00000000", "1.00000000"]) {
      expect(() => parseAmount(eight), eight).toThrow(InvalidAmountError);
      expect(() => parseAmount(eight), eight).toThrow(/7 decimal/);
    }
  });

  it("has no negative zero", () => {
    // bigint has one zero, which is the point: a display that can show "-0" is
    // a display that has been through a float.
    for (const z of ["-0", "-0.0", "-0.0000000", "0", "0.0000000"]) {
      expect(parseAmount(z), z).toBe(0n);
      expect(formatAmount(parseAmount(z)), z).toBe("0.0000000");
      expect(formatAmount(parseAmount(z)).startsWith("-"), z).toBe(false);
    }
    expect(splitAmount(formatAmount(0n))).toEqual({ whole: "0", fraction: "" });
  });

  it("holds the sum of the corpus without overflow or drift", () => {
    // R14 in one line: a running total is where an int64 assumption usually
    // breaks. bigint has no width, so the total is exact even where it exceeds
    // what one ledger entry could hold, and the formatter still round-trips it.
    let total = 0n;
    for (const v of corpus()) total += v;
    expect(parseAmount(formatAmount(total))).toBe(total);
  });

  it("sums a dApp envelope's payments exactly, not through the headline's float", () => {
    // outgoingNative is the headline figure on the approval screen and it adds
    // several operations together. the amounts are decoded from XDR, so this is
    // the one place a hostile site chooses the numbers, and it picks three that
    // straddle 2^53 stroops on purpose.
    const source = Keypair.random().publicKey();
    const parts = ["0.0000001", "900719925.4740993", "1.0000001"];
    const xdr = buildEnvelope(source, Keypair.random().publicKey(), parts);
    const total = parts.reduce((a, p) => a + parseAmount(p), 0n);
    expect(total).toBe(9007199264740995n);
    expect(outgoingNative(xdr, Networks.TESTNET, source)).toBe(formatAmount(total));
    // the float answer, for contrast: one stroop too many, from three
    // additions of entirely ordinary-looking numbers.
    const viaFloat = BigInt(Math.trunc(parts.reduce((a, p) => a + Number(p), 0) * 1e7));
    expect(viaFloat).not.toBe(total);
    expect(viaFloat - total).toBe(1n);
  });
});

/* --------------------------------------------------------------------- xdr */

/** several native payments from one source, as a site would send them. */
function buildEnvelope(source: string, dest: string, amounts: string[]): string {
  let b = new TransactionBuilder(new Account(source, "1"), {
    fee: "100",
    networkPassphrase: Networks.TESTNET,
  });
  for (const amount of amounts) {
    b = b.addOperation(Operation.payment({ destination: dest, asset: Asset.native(), amount }));
  }
  return b.setTimeout(300).build().toXDR();
}

/* ------------------------------------------------------------------ locale */

const LOCALES = [
  "en-US",
  "de-DE",
  "fr-FR",
  "ar-EG",
  "es-ES",
  "pt-BR",
  "ru-RU",
  "tr-TR",
  "de-CH",
  "hi-IN",
  "en-IN",
  "fa-IR",
  "nb-NO",
  "cs-CZ",
];

/** what a locale writes between the thousands and before the fraction. */
function separators(locale: string): { group: string; decimal: string } {
  const parts = new Intl.NumberFormat(locale, { minimumFractionDigits: 1 }).formatToParts(12345.6);
  return {
    group: parts.find((p) => p.type === "group")?.value ?? "",
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
  };
}

/** the ten digits this locale writes by default, ASCII or not. */
function digitsOf(locale: string): string[] {
  const f = new Intl.NumberFormat(locale, { useGrouping: false });
  return [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((d) => f.format(d));
}

/** rewrite an ASCII figure in another script's digits. */
function inScript(text: string, digits: string[]): string {
  return text.replace(/[0-9]/g, (d) => digits[Number(d)]!);
}

describe("locale: an amount is the same number in every language, or it is refused", () => {
  it("names the locales whose separators differ from the one format the wallet reads", () => {
    // a premise check. if every locale in the table used "." and no grouping,
    // every assertion below would pass while testing nothing.
    const differing = LOCALES.filter((l) => separators(l).decimal !== ".");
    expect(
      differing.length,
      "the locale table must contain comma-decimal locales or this suite is vacuous",
    ).toBeGreaterThanOrEqual(6);
  });

  it("a comma decimal is 1.5 or a refusal, never 15 and never 1000x", () => {
    // the exact shape of R7. every locale's own way of writing one and a half.
    for (const locale of LOCALES) {
      const { decimal } = separators(locale);
      const typed = `1${decimal}5`;
      let got: bigint | "refused";
      try {
        got = parseAmount(typed);
      } catch (e) {
        expect(e, `${locale}: ${typed} must be refused as an AMOUNT`).toBeInstanceOf(
          InvalidAmountError,
        );
        got = "refused";
      }
      expect(got, `${locale}: "${typed}" became ${String(got)} stroops`).toSatisfy(
        (v: bigint | "refused") => v === "refused" || v === 15_000_000n,
      );
      // stated separately and positively: the two wrong answers by name.
      expect(got, `${locale}: "${typed}" was read as fifteen`).not.toBe(150_000_000n);
      expect(got, `${locale}: "${typed}" was read as fifteen hundred`).not.toBe(15_000_000_000n);
    }
  });

  it("a grouped figure is refused rather than silently regrouped", () => {
    for (const locale of LOCALES) {
      const { group, decimal } = separators(locale);
      if (!group) continue;
      const typed = `1${group}234${decimal}5`;
      let got: bigint | "refused";
      try {
        got = parseAmount(typed);
      } catch {
        got = "refused";
      }
      // the only acceptable outcomes are a refusal or the exact value the
      // locale's own reader would give it. anything else is money moved by a
      // separator.
      expect(got, `${locale}: "${typed}" parsed to ${String(got)}`).toSatisfy(
        (v: bigint | "refused") => v === "refused" || v === 12_345_000_000n,
      );
    }
  });

  it("a bare thousands group is read as a decimal, and what is shown is what is signed", () => {
    // the one comma-decimal shape the wallet CANNOT refuse, pinned so it is a
    // decision rather than an accident.
    //
    // in de-DE, es-ES, pt-BR and id-ID, "1.500" means fifteen hundred. this
    // parser reads it as one and a half, and it is right to: with no locale
    // signal anywhere in the wallet (proved by the trap above) "1.500" is a
    // decimal, and refusing every value with exactly three places after the
    // point would refuse ordinary money.
    //
    // so the property that has to hold is the OTHER one: whatever it decides,
    // the confirm screen must restate it, in full, before anything is signed.
    // 1.5 XLM is a thousandth of what that user meant, and the only thing
    // standing between them and it is that the review step says 1.5000000.
    expect(parseAmount("1.500")).toBe(15_000_000n);
    expect(parseAmount("1.500")).not.toBe(15_000_000_000n);
    expect(formatAmount(parseAmount("1.500"))).toBe("1.5000000");
    // and the figure that gets restated re-parses to the same stroops, so the
    // user is shown the number that will move and not a rendering of it.
    expect(parseAmount(formatAmount(parseAmount("1.500")))).toBe(parseAmount("1.500"));
  });

  it("every locale rendering of a value parses back to that value or is refused", () => {
    // the general property, over the corpus rather than over one figure. a
    // locale may not turn a number into a DIFFERENT number, only into a
    // refusal. this is the invariant that "1,5 -> 15" would break.
    const sample = corpus(60);
    const wrong: string[] = [];
    for (const locale of LOCALES) {
      const { group, decimal } = separators(locale);
      const digits = digitsOf(locale);
      for (const v of sample) {
        const canonical = formatAmount(v);
        const renderings = [
          canonical.replace(".", decimal),
          inScript(canonical, digits),
          inScript(canonical.replace(".", decimal), digits),
          group ? canonical.replace(/\B(?=(\d{3})+\.)/g, group) : canonical,
        ];
        for (const text of renderings) {
          let got: bigint | "refused";
          try {
            got = parseAmount(text);
          } catch {
            got = "refused";
          }
          if (got !== "refused" && got !== v) {
            wrong.push(`${locale}: ${JSON.stringify(text)} -> ${got}, wanted ${v} or a refusal`);
          }
        }
      }
    }
    expect(wrong, `${seeded("locale renderings")}\n${wrong.slice(0, 20).join("\n")}`).toEqual([]);
  });

  it("refuses every non-ASCII digit script rather than reading it as a number", () => {
    // if any of these were accepted the value would be whatever the parser
    // happened to make of them, and BigInt refuses them too, so the failure
    // would be a crash rather than a wrong amount. either way it must not get
    // past the boundary.
    const scripts: Record<string, string> = {
      "arabic-indic": "١٢٣", // ١٢٣
      "extended-arabic-indic": "۱۲۳", // ۱۲۳
      devanagari: "१२३",
      bengali: "১২৩",
      thai: "๑๒๓",
      fullwidth: "１２３",
      "arabic-indic with arabic decimal": "١٫٥", // ١٫٥
      "fullwidth with fullwidth stop": "１．５",
    };
    for (const [name, text] of Object.entries(scripts)) {
      expect(() => parseAmount(text), `${name}: ${JSON.stringify(text)}`).toThrow(
        InvalidAmountError,
      );
    }
  });

  it("refuses invisible and directional characters inside a figure", () => {
    // a memo, a chat window or a right-to-left page can carry these invisibly.
    // the digits look like an amount and are not the amount.
    const invisibles = [
      "​", // zero width space
      "‎", // left-to-right mark
      "‏", // right-to-left mark
      "؜", // arabic letter mark
      "⁦", // first strong isolate
      "⁩", // pop directional isolate
      "‮", // right-to-left override
      "­", // soft hyphen
    ];
    for (const ch of invisibles) {
      const hidden = `1${ch}5`; // reads as "15", is not 15
      expect(() => parseAmount(hidden), JSON.stringify(hidden)).toThrow(InvalidAmountError);
      const trailing = `1.5${ch}`;
      expect(() => parseAmount(trailing), JSON.stringify(trailing)).toThrow(InvalidAmountError);
    }
  });

  it("accepts the whitespace a paste carries, and changes nothing by accepting it", () => {
    // the other side of the coin. refusing a value because the clipboard put a
    // non-breaking space around it would be a defect of its own, and accepting
    // it must not change the number.
    for (const pad of [" ", "\t", "\n", "\r\n", " ", " ", "﻿", "  \n\t "]) {
      expect(parseAmount(`${pad}1.5${pad}`), JSON.stringify(pad)).toBe(15_000_000n);
    }
  });

  it("formats without consulting the locale at all, so a locale change cannot move a digit", () => {
    // the display half of R7, and the reason a change of locale BETWEEN entry
    // and confirmation cannot alter what is shown: there is nothing locale
    // aware in the path to change its mind. proven by trapping the locale APIs
    // rather than by reading the code.
    const trap = trapFloats();
    let rendered: string[] = [];
    try {
      rendered = corpus(80).map((v) => {
        const text = formatAmount(v);
        const { whole, fraction } = splitAmount(text);
        return `${whole}|${fraction}`;
      });
    } finally {
      trap.restore();
    }
    expect(trap.hits, "formatting consulted the locale").toEqual([]);
    // and the bytes are ASCII, which is the observable consequence.
    for (const r of rendered) {
      expect(r, `${seeded(r)}: a non-ASCII character reached a rendered amount`).toMatch(
        /^[-0-9,.|]*$/,
      );
    }
  });

  it("the grouped display reduces to the exact value by removing separators only", () => {
    // splitAmount is what a person reads. it may group and it may drop trailing
    // zeros; it may not move, add or lose a significant digit. the check is a
    // reconstruction, so a grouping bug shows up as a changed VALUE rather than
    // as a changed string nobody compares.
    for (const v of corpus(200)) {
      const text = formatAmount(v);
      const { whole, fraction } = splitAmount(text);
      const rebuilt = `${whole.replace(/,/g, "")}.${fraction.padEnd(7, "0")}`;
      expect(parseAmount(rebuilt), `${seeded(String(v))}: the display changed the value`).toBe(v);
      // grouping is in threes from the right, always, so a reader counting
      // groups counts the same number the parser holds.
      const digitsOnly = whole.replace(/^-/, "");
      for (const chunk of digitsOnly.split(",").slice(1)) {
        expect(chunk.length, `${seeded(String(v))}: ragged grouping in "${whole}"`).toBe(3);
      }
    }
  });
});

/* -------------------------------------------------------------- validation */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

describe("addresses: every identifier a user can produce", () => {
  it("accepts each kind and never mistakes one for another", () => {
    const g = Keypair.random().publicKey();
    const m = new MuxedAccount(new Account(g, "0"), "1").accountId();
    const c = "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6";
    expect(parseAddress(g)).toEqual({ kind: "account", value: g });
    expect(parseAddress(m)).toEqual({ kind: "muxed", value: m });
    expect(parseAddress(c)).toEqual({ kind: "contract", value: c });
  });

  it("refuses every single-character substitution in a valid address", () => {
    // exhaustive over positions, seeded over replacements. the checksum's whole
    // job is this case and it is the one an attacker gets for free by sitting
    // next to a keyboard.
    const r = rng(SEED ^ 0x1234);
    const survivors: string[] = [];
    for (const address of [Keypair.random().publicKey(), Keypair.random().publicKey()]) {
      for (let i = 1; i < address.length; i++) {
        for (let k = 0; k < 3; k++) {
          const original = address[i]!;
          let replacement = original;
          while (replacement === original) {
            replacement = BASE32[Math.floor(r() * BASE32.length)]!;
          }
          const mutated = address.slice(0, i) + replacement + address.slice(i + 1);
          if (isValidAddress(mutated)) survivors.push(`${seeded(mutated)} at ${i}`);
        }
      }
    }
    expect(survivors, `a one-character change was accepted:\n${survivors.join("\n")}`).toEqual([]);
  });

  it("refuses every adjacent transposition in a valid address", () => {
    const survivors: string[] = [];
    for (const address of [Keypair.random().publicKey(), Keypair.random().publicKey()]) {
      for (let i = 1; i < address.length - 1; i++) {
        if (address[i] === address[i + 1]) continue;
        const mutated = address.slice(0, i) + address[i + 1]! + address[i]! + address.slice(i + 2);
        if (isValidAddress(mutated)) survivors.push(`${mutated} (swap at ${i})`);
      }
    }
    expect(survivors, `a transposition was accepted:\n${survivors.join("\n")}`).toEqual([]);
  });

  it("refuses confusable and invisible characters spliced into a valid address", () => {
    const address = Keypair.random().publicKey();
    const confusables = [
      "А", // cyrillic capital A
      "Α", // greek capital alpha
      "Ａ", // fullwidth A
      "⁰", // superscript zero
      "​", // zero width space
      "‎",
      "‮",
      " ",
      " ",
    ];
    const accepted: string[] = [];
    for (const ch of confusables) {
      for (const i of [1, 10, 28, 55]) {
        const swapped = address.slice(0, i) + ch + address.slice(i + 1);
        const inserted = address.slice(0, i) + ch + address.slice(i);
        for (const bad of [swapped, inserted]) {
          if (isValidAddress(bad)) accepted.push(`${JSON.stringify(ch)} at ${i}`);
        }
      }
    }
    expect(accepted, `a non-base32 character was accepted:\n${accepted.join("\n")}`).toEqual([]);
  });

  it("never throws anything but InvalidAddressError, whatever it is handed", () => {
    // parseAddress sits directly behind an untrusted message boundary, so an
    // unexpected throw type is a different failure mode from a refusal: it is
    // the one that reaches the user as "check your connection".
    const r = rng(SEED ^ 0xbeef);
    const inputs: string[] = [
      "",
      " ",
      "G",
      "G".repeat(56),
      "G".repeat(100_000),
      " ".repeat(56),
      "\uD800", // a lone surrogate
      "GA" + "😀".repeat(27),
      Keypair.random().secret(),
      "javascript:alert(1)",
    ];
    for (let i = 0; i < 400; i++) {
      const len = 1 + Math.floor(r() * 80);
      let s = "";
      for (let j = 0; j < len; j++) s += String.fromCharCode(Math.floor(r() * 0x2200));
      inputs.push(s);
      inputs.push("G" + s);
    }
    const wrong: string[] = [];
    for (const input of inputs) {
      try {
        const parsed = parseAddress(input);
        // an acceptance is allowed, and then it must be the trimmed input and
        // nothing else: a parser that returns a DIFFERENT string than it was
        // given is an address substitution with extra steps.
        if (parsed.value !== input.trim()) {
          wrong.push(`${seeded(JSON.stringify(input.slice(0, 40)))}: rewrote the address`);
        }
      } catch (e) {
        if (!(e instanceof InvalidAddressError)) {
          wrong.push(
            `${seeded(JSON.stringify(input.slice(0, 40)))}: threw ${(e as Error)?.name ?? typeof e}`,
          );
        }
      }
    }
    expect(wrong, wrong.slice(0, 10).join("\n")).toEqual([]);
  });

  it("distinguishes a bad checksum from a string that is not an address", () => {
    const good = Keypair.random().publicKey();
    const flipped = good.slice(0, 10) + (good[10] === "A" ? "B" : "A") + good.slice(11);
    expect(() => parseAddress(flipped)).toThrow(
      expect.objectContaining({ reason: "checksum" }) as Error,
    );
    expect(() => parseAddress("not-an-address")).toThrow(
      expect.objectContaining({ reason: "malformed" }) as Error,
    );
    // lowercase is base32's other spelling of the same bytes in some libraries.
    // here it must be malformed, not quietly upcased into an acceptance.
    expect(isValidAddress(good.toLowerCase())).toBe(false);
  });

  it("chunking for the confirm step loses nothing", () => {
    for (let i = 0; i < 40; i++) {
      const a = Keypair.random().publicKey();
      for (const size of [3, 4, 5, 8]) {
        expect(chunkAddress(a, size).join(""), `${a} @ ${size}`).toBe(a);
      }
    }
  });
});

describe("amounts: fuzzing the field a user types money into", () => {
  it("either refuses or returns the exact value an independent parser computes", () => {
    const r = rng(SEED ^ 0xa11);
    const alphabet = "0123456789.,-+eE xX0abf٠ ​";
    const inputs: string[] = [
      "",
      ".",
      "-",
      "+",
      "-.",
      ".5",
      "5.",
      "1e5",
      "1E5",
      "0x10",
      "1_000",
      "Infinity",
      "-Infinity",
      "NaN",
      "1/2",
      "1 000",
      "٠.٥",
      "9".repeat(400),
      `${"9".repeat(400)}.9999999`,
      "0".repeat(400) + "1",
    ];
    for (let i = 0; i < 3000; i++) {
      const len = 1 + Math.floor(r() * 14);
      let s = "";
      for (let j = 0; j < len; j++) s += alphabet[Math.floor(r() * alphabet.length)]!;
      inputs.push(s);
    }
    const wrong: string[] = [];
    for (const input of inputs) {
      let got: bigint | "refused";
      try {
        got = parseAmount(input);
      } catch (e) {
        if (!(e instanceof InvalidAmountError)) {
          wrong.push(`${seeded(JSON.stringify(input))}: threw ${(e as Error)?.name ?? typeof e}`);
        }
        got = "refused";
      }
      const reference = refParse(input);
      const want: bigint | "refused" = reference === null ? "refused" : reference;
      if (got !== want) {
        wrong.push(
          `${seeded(JSON.stringify(input))}: got ${String(got)}, reference ${String(want)}`,
        );
      }
      // and whatever was accepted must survive a round trip.
      if (typeof got === "bigint" && parseAmount(formatAmount(got)) !== got) {
        wrong.push(`${seeded(JSON.stringify(input))}: accepted but does not round-trip`);
      }
    }
    expect(wrong, `${wrong.length} disagreements:\n${wrong.slice(0, 15).join("\n")}`).toEqual([]);
  });

  it("refuses a 100,000-character field without hanging on it", () => {
    // the field is a plain text input, so this is one paste away. a catastrophic
    // backtrack here would freeze the popup rather than refuse the amount.
    const started = process.hrtime.bigint();
    expect(() => parseAmount("9".repeat(50_000) + "." + "9".repeat(50_000))).toThrow(
      InvalidAmountError,
    );
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    expect(ms, `parsing a 100k field took ${ms}ms`).toBeLessThan(1000);
  });

  it("a 400-digit amount is a number, not a crash", () => {
    // above every bound but still well formed, so it must be refused by SIZE
    // somewhere downstream rather than by the parser mangling it.
    const huge = "9".repeat(400);
    const v = parseAmount(huge);
    expect(v).toBe(BigInt(huge) * STROOPS_PER_UNIT);
    expect(formatAmount(v)).toBe(`${huge}.0000000`);
    expect(v > I64_MAX).toBe(true);
  });
});

describe("memos: a byte limit measured in bytes", () => {
  const build = (memo: string) => {
    const source = Keypair.random().publicKey();
    return buildPayment(
      new Account(source, "1"),
      {
        from: source,
        to: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: STROOPS_PER_UNIT,
        memo,
      },
      Networks.TESTNET,
    );
  };

  it("accepts a memo if and only if its UTF-8 length fits, for every generated string", () => {
    const r = rng(SEED ^ 0x111e);
    const pieces = ["a", "é", "€", "😀", "́", "ب", "中", " ", "​"];
    const wrong: string[] = [];
    for (let i = 0; i < 600; i++) {
      const len = 1 + Math.floor(r() * 20);
      let memo = "";
      for (let j = 0; j < len; j++) memo += pieces[Math.floor(r() * pieces.length)]!;
      const bytes = new TextEncoder().encode(memo).length;
      let ok = true;
      try {
        build(memo);
      } catch (e) {
        ok = false;
        if (bytes <= MEMO_TEXT_MAX_BYTES && !(e instanceof MemoTooLongError)) {
          wrong.push(`${seeded(JSON.stringify(memo))}: ${bytes}B rejected as ${(e as Error).name}`);
        }
      }
      if (ok !== bytes <= MEMO_TEXT_MAX_BYTES) {
        wrong.push(`${seeded(JSON.stringify(memo))}: ${bytes} bytes, accepted=${ok}`);
      }
    }
    expect(wrong, wrong.slice(0, 10).join("\n")).toEqual([]);
  });

  it("carries a memo to the wire byte for byte, never truncated mid-codepoint", () => {
    // 24 ASCII bytes plus one 4-byte emoji is exactly 28: the last byte of the
    // limit lands inside a character, which is where a length check that counted
    // characters, or one that truncated, would corrupt it.
    const memo = "a".repeat(24) + "😀";
    expect(new TextEncoder().encode(memo).length).toBe(MEMO_TEXT_MAX_BYTES);
    const tx = build(memo);
    const back = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET);
    // fromXDR's return type admits a fee bump, which carries no memo. narrowing
    // rather than casting, so a change that made this a fee bump would fail
    // here rather than read `undefined.value`.
    expect(back).toBeInstanceOf(Transaction);
    expect(String((back as Transaction).memo.value)).toBe(memo);
    expect(() => build(memo + "a")).toThrow(MemoTooLongError);
  });
});

describe("the one deliberate float conversion, at its stated boundary", () => {
  it("converts exactly up to the safe integer and refuses past it", () => {
    // defindex's DTO declares amounts as JSON numbers, so this module must
    // convert. it is the only place in the wallet that may, and it holds the
    // boundary explicitly rather than hoping.
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    const body = moveBody({ caller: "G", amounts: [safe] }, "deposit");
    expect(BigInt(body.amounts[0]!), "the boundary value must convert exactly").toBe(safe);
    expect(() => moveBody({ caller: "G", amounts: [safe + 1n] }, "deposit")).toThrow(DefindexError);
    expect(() => moveBody({ caller: "G", amounts: [-1n] }, "withdraw")).toThrow(DefindexError);
  });

  it("every accepted amount survives JSON, with no exponent and no drift", () => {
    // the conversion is only half of it: the value then goes through
    // JSON.stringify, which writes 1e21 in exponent form and would be a
    // different number to a server reading it as an integer.
    const r = rng(SEED ^ 0xdef1);
    const safe = BigInt(Number.MAX_SAFE_INTEGER);
    const values = [0n, 1n, safe, safe - 1n, 10_000_000n];
    for (let i = 0; i < 200; i++) values.push(below(r, safe));
    for (const v of values) {
      const body = moveBody({ caller: "GABC", amounts: [v] }, "deposit");
      const wire = JSON.parse(JSON.stringify(body)) as { amounts: number[] };
      expect(String(wire.amounts[0]), `${seeded(String(v))}: exponent or drift on the wire`).toBe(
        v.toString(),
      );
      expect(BigInt(wire.amounts[0]!), `${seeded(String(v))}`).toBe(v);
    }
  });
});

/* ------------------------------------------- the properties, shown failing */

/**
 * every property above, run against an implementation that has the defect it
 * exists to catch.
 *
 * a green suite is only evidence if its tests can go red, and the usual way to
 * show that is to break the source and watch. this lane may not edit src/, and
 * a temporary edit is a race against every other lane's run anyway. so the
 * defect is injected into a LOCAL implementation and the same predicate is
 * pointed at it: if the predicate cannot see the bug here, it could not have
 * seen it in the real code either, and the passing run above means nothing.
 */
describe("each property, pointed at an implementation that has the defect", () => {
  /** a wallet that took the obvious route: numbers are numbers. */
  const floatParse = (text: string): bigint => BigInt(Math.round(Number(text.trim()) * 1e7));
  const floatFormat = (v: bigint): string => (Number(v) / 1e7).toFixed(7);

  it("the round trip catches a float parser", () => {
    const broken = corpus(400).filter((v) => floatParse(floatFormat(v)) !== v);
    expect(broken.length, "a float round trip must lose at least one corpus value").toBeGreaterThan(
      0,
    );
    // named, so the reader can see it is not an exotic value.
    expect(floatParse(floatFormat(I64_MAX))).not.toBe(I64_MAX);
    expect(floatParse("900719925.4740993")).not.toBe(9007199254740993n);
  });

  it("the truncation property catches a display that rounds", () => {
    // the same shape as formatAmount, with `.slice` replaced by a rounding
    // step. 1.2345678 shown as "1.24" is a different number.
    const rounding = (raw: bigint, decimals: number): string => {
      const scale = 10n ** BigInt(7 - decimals);
      const rounded = (raw + scale / 2n) / scale;
      const s = rounded.toString().padStart(decimals + 1, "0");
      return decimals > 0
        ? `${s.slice(0, s.length - decimals)}.${s.slice(s.length - decimals)}`
        : s;
    };
    // .2367 is the interesting one: it truncates to .23 and rounds to .24, so
    // the two implementations disagree by a hundredth of a unit on a value a
    // user would call ordinary.
    const v = parseAmount("1.2367890");
    const full = formatAmount(v);
    const expected = full.slice(0, full.indexOf(".") + 1 + 2);
    expect(expected).toBe("1.23");
    expect(rounding(v, 2), "the mutant must produce a different string").toBe("1.24");
    expect(rounding(v, 2)).not.toBe(expected);
    expect(formatAmount(v, 2)).toBe(expected);
  });

  it("the locale property catches a parser that strips separators", () => {
    // the exact mistake R7 names: a parser that tries to be helpful about
    // punctuation. "1,5" becomes 15, which is ten times the money.
    const helpful = (text: string): bigint => parseAmount(text.trim().replace(/[,  ]/g, ""));
    expect(helpful("1,5")).toBe(150_000_000n);
    expect(helpful("1,5")).not.toBe(15_000_000n);
    // and the property as written rejects it.
    const violates = LOCALES.some((locale) => {
      const { decimal } = separators(locale);
      try {
        return helpful(`1${decimal}5`) !== 15_000_000n;
      } catch {
        return false;
      }
    });
    expect(violates, "the locale property must reject a separator-stripping parser").toBe(true);
  });

  it("the display-reduction property catches grouping that drops a digit", () => {
    // a grouper that regexes on the wrong boundary eats the first digit of the
    // fraction. the value looks plausible and is a tenth of what it was.
    const lossy = (value: string) => {
      const [w = "0", f = ""] = value.split(".");
      return { whole: w.replace(/\B(?=(\d{3})+(?!\d))/g, ","), fraction: f.slice(1) };
    };
    const text = formatAmount(12_345_678n);
    const { whole, fraction } = lossy(text);
    const rebuilt = `${whole.replace(/,/g, "")}.${fraction.padEnd(7, "0")}`;
    expect(parseAmount(rebuilt)).not.toBe(12_345_678n);
    // the real one survives the same check.
    const good = splitAmount(text);
    expect(parseAmount(`${good.whole.replace(/,/g, "")}.${good.fraction.padEnd(7, "0")}`)).toBe(
      12_345_678n,
    );
  });

  it("the address mutation property catches a validator that skips the checksum", () => {
    // shape-only validation. every mutation in the sweep above would survive
    // it, so a green sweep means the checksum is genuinely being checked.
    const shapeOnly = (a: string) => /^G[A-Z2-7]{55}$/.test(a.trim());
    const address = Keypair.random().publicKey();
    const mutated = address.slice(0, 10) + (address[10] === "A" ? "B" : "A") + address.slice(11);
    expect(shapeOnly(mutated), "the mutant must accept a broken checksum").toBe(true);
    expect(isValidAddress(mutated), "the real one must not").toBe(false);
  });

  it("the memo property catches a limit counted in characters", () => {
    const byCharacters = (memo: string) => memo.length <= MEMO_TEXT_MAX_BYTES;
    const emoji = "😀".repeat(10); // 40 bytes, 20 UTF-16 units, 10 characters
    expect(byCharacters(emoji), "the mutant must accept 40 bytes").toBe(true);
    expect(new TextEncoder().encode(emoji).length).toBeGreaterThan(MEMO_TEXT_MAX_BYTES);
    const source = Keypair.random().publicKey();
    expect(() =>
      buildPayment(
        new Account(source, "1"),
        {
          from: source,
          to: Keypair.random().publicKey(),
          asset: Asset.native(),
          amount: STROOPS_PER_UNIT,
          memo: emoji,
        },
        Networks.TESTNET,
      ),
    ).toThrow(MemoTooLongError);
  });

  it("the source inventory catches a new conversion", () => {
    // the scan is a regex over lines, so the thing to prove is that the regex
    // matches what it claims to and that the allowlist is matched by content.
    const injected = [
      "  const xlm = parseFloat(balance);",
      "  return Number(summary.amount) > 0;",
      "  return stroops.toLocaleString();",
      "  const shown = value.toFixed(2);",
      "  new Intl.NumberFormat(navigator.language).format(n);",
    ];
    for (const line of injected) {
      expect(FLOATING.test(line), `the scan must see ${JSON.stringify(line)}`).toBe(true);
      expect(
        JUDGED_HARMLESS.some((j) => line.trim().includes(j.fragment)),
        "and the allowlist must not excuse it",
      ).toBe(false);
    }
  });
});

/* --------------------------------------------------- the source, inventoried */

/**
 * every module through which a user's money passes on its way to a screen or to
 * the wire. the list is the claim; the test below is the evidence.
 */
const VALUE_PATH = [
  "src/core/chain/balances.ts",
  "src/core/chain/payment.ts",
  "src/core/provider/describe-tx.ts",
  "src/core/controller.ts",
  "src/core/integrations/defindex.ts",
  "src/entrypoints/popup/ui/Amount.tsx",
  "src/entrypoints/popup/ui/Held.tsx",
  "src/entrypoints/popup/ui/flow.tsx",
  "src/entrypoints/popup/ui/screens/Home.tsx",
  "src/entrypoints/popup/ui/screens/DappApproval.tsx",
  "src/entrypoints/popup/ui/screens/Send.tsx",
  "src/entrypoints/popup/ui/sheets/MoveSheet.tsx",
  // the value chart and the asset detail. both turn a balance into a dollar
  // estimate, which is the one place a float legitimately enters, so both have
  // to be scanned rather than trusted.
  "src/entrypoints/popup/ui/Chart.tsx",
  "src/entrypoints/popup/ui/sheets/AssetDetailSheet.tsx",
  // the shared amount composer and the one dollar formatter, both extracted from
  // the screens above: the fraction slider and the fiat display now live here, so
  // the scan follows them here rather than trusting them.
  "src/entrypoints/popup/ui/AmountComposer.tsx",
  "src/entrypoints/popup/ui/money.ts",
  "src/core/chain/prices.ts",
  "src/core/chain/portfolio.ts",
  "src/core/chain/balance-history.ts",
];

const FLOATING =
  /\b(?:Number|parseFloat|parseInt)\s*\(|\.to(?:Fixed|Precision|LocaleString)\s*\(|\bIntl\.NumberFormat\b|\bMath\.(?:round|floor|ceil|abs|max|min)\s*\(/;

/**
 * a float touch that has been read and judged harmless, keyed by the exact
 * source text of the line.
 *
 * an allowlist by CONTENT rather than by line number, so moving code does not
 * silently re-admit something, and so each entry carries the reason it is not a
 * money conversion. anything not on this list fails the test and has to be
 * argued for in writing here.
 */
const JUDGED_HARMLESS: { fragment: string; why: string }[] = [
  {
    fragment: "if (!Number.isInteger(decimals) || decimals < 0 || decimals > 7)",
    why: "validates the DISPLAY WIDTH argument, not the value",
  },
  { fragment: "Math.max(fontSizes.small, Math.min(px,", why: "type size in pixels" },
  { fragment: "gap: Math.round(px * GAP_EM)", why: "layout" },
  { fragment: "fontSize: Math.round(px * fractionOf)", why: "layout" },
  { fragment: "fontSize: Math.round(px * codeOf)", why: "layout" },
  { fragment: "minHeight: Math.round(fontSizes.hero * 1.25)", why: "layout" },
  {
    fragment: "Math.round((i * (n - 1)) / (target - 1))",
    why: "an evenly-spaced array INDEX for chart decimation; it selects which points to keep, never touching a value",
  },
  {
    fragment: "<RollDigit key={key} digit={Number(ch)} />",
    why: "one character, 0-9, into a CSS row offset; the value itself is rendered as text",
  },
  { fragment: "expired: e.maxTime > 0 && Math.floor(Date.now() / 1000)", why: "unix seconds" },
  {
    fragment: "Math.floor(Date.now() / 1000) > e.maxTime",
    why: "unix seconds",
  },
  {
    fragment: "const id = `${Date.now()}-${Math.round(Math.random() * 1e9)}`",
    why: "a request id",
  },
  { fragment: "daysRemaining: Math.round(t.daysRemaining)", why: "days, not money" },
  {
    fragment: "if (a > BigInt(Number.MAX_SAFE_INTEGER))",
    why: "the guard on the one deliberate conversion; tested above",
  },
  {
    fragment: "return Number(a);",
    why: "defindex's DTO declares JSON numbers; guarded to the safe range on the line above",
  },
  {
    fragment: "return `${apy.toFixed(2)}% over the last ${windowDays} days",
    why: "an APY is a rate the service reports as a float; it is not a balance",
  },
  {
    fragment: "if (apy === undefined || apy === null || !Number.isFinite(apy))",
    why: "refuses a non-finite rate rather than rendering it",
  },
  // The value chart's dollar figure. A price is a float and always will be, so
  // `balance * price` cannot be exact and there is nothing to protect by
  // pretending otherwise.
  //
  // What matters is that this stays OFF the balance path, and it does: the
  // balance itself is stroops as a bigint from the ledger to the screen, and the
  // XLM figure under the hero is the ledger's own decimal string, formatted by
  // `formatAmount` and never by this. Nothing here is ever signed, submitted, or
  // stored. A wrong last digit in the dollar estimate is a wrong estimate; a
  // wrong last digit in a balance would be a wrong payment.
  {
    fragment: "const places = Math.abs(v) >= 1 || v === 0 ? 2 : 4;",
    why: "picks the decimal places for a USD estimate; the balance beside it is a string from the ledger",
  },
  {
    fragment: "return `$${v.toFixed(places)}`;",
    why: "renders a USD estimate derived from a market price, which is a float by nature and is never signed or stored",
  },
  // ---- the value chart -----------------------------------------------------
  // Chart.tsx is geometry. every float below maps a series into SVG space or
  // turns a pointer position into an array index; none of them touches a
  // balance, and the numbers they produce are pixel coordinates.
  { fragment: "const lo = Math.min(...values);", why: "normalising a curve into svg space" },
  { fragment: "const hi = Math.max(...values);", why: "normalising a curve into svg space" },
  {
    fragment: "const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));",
    why: "where a finger is along the chart, 0..1",
  },
  {
    fragment: "report(Math.round(frac * (values.length - 1)));",
    why: "a scrub position into an array index",
  },
  {
    fragment: '{up ? "▲" : "▼"} {Math.abs(shown).toFixed(2)}%',
    why: "a percentage change, which is a ratio and not a balance",
  },
  // the asset detail's dollar figures. a price is a float by nature, so an
  // estimate derived from one cannot be exact and there is nothing to protect by
  // pretending otherwise. none of this is signed, submitted or stored, and the
  // holdings row beside it renders the ledger's own string through `Amount`.
  {
    fragment: "const places = Math.abs(v) >= 1 || v === 0 ? 2 : 6;",
    why: "decimal places for a USD price estimate",
  },
  {
    fragment: "if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;",
    why: "abbreviates a USD volume for display",
  },
  {
    fragment: "if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;",
    why: "abbreviates a USD volume for display",
  },
  { fragment: "return `$${v.toFixed(2)}`;", why: "renders a USD volume" },
  {
    fragment: 'const n = typeof amount === "string" ? Number(amount) : amount;',
    why: "ui/money.ts parses the decimal-string amount to a number solely to multiply by the price for the display dollar (usdOf); the string is what is transacted",
  },
  // ---- the price feed ------------------------------------------------------
  {
    fragment: "const end = Math.floor(Date.now() / step) * step;",
    why: "snaps a clock to a candle boundary",
  },
  { fragment: "const at = Number(r.timestamp);", why: "a candle timestamp in milliseconds" },
  {
    fragment: "const price = Number(r.close);",
    why: "a market price, which the DEX quotes as a decimal and which is a float by nature",
  },
  { fragment: "const price = Number(today.close);", why: "a market price" },
  {
    fragment: "const volume = Number(today.counter_volume);",
    why: "a traded volume, not a holding",
  },
  {
    fragment: "const prev = yesterday ? Number(yesterday.close) : NaN;",
    why: "yesterday's market price; NaN when absent, which the caller turns into a null change",
  },
  // ---- the value series ----------------------------------------------------
  {
    fragment: "value: (Number(balanceAt(history, t)) / Number(STROOPS_PER_UNIT)) * price,",
    why: "THE deliberate conversion: stroops meet a float price here and nowhere else, once, at the boundary, so every balance upstream stays exact",
  },
  {
    fragment: "const len = Math.min(...usable.map((s) => s.length));",
    why: "the shortest series length, an array count",
  },
  {
    fragment: "const mid = Math.ceil((lo + hi) / 2);",
    why: "a binary search midpoint over array indices",
  },
  {
    fragment: "const cut = active ? Math.min(at, pts.length - 1) : 0;",
    why: "clamps the scrub position to an array index",
  },
  {
    fragment: "const pillX = dot ? Math.max(30, Math.min(w - 30, dot[0])) : 0;",
    why: "keeps the scrub pill off the chart edges, in pixels",
  },
  {
    fragment: "const w = Math.min(measured, width);",
    why: "the chart's drawing width in pixels: the measured container width capped at the passed ceiling, so the curve reflows at high zoom; a layout measure, not a value",
  },
  {
    fragment:
      "active && times && labelAt ? labelAt(times[Math.min(at, times.length - 1)]!) : null;",
    why: "clamps a scrub index into the timestamps array",
  },
  // ---- the auto-lock setting (minutes, never money) ------------------------
  {
    fragment:
      "return Math.min(MAX_AUTO_LOCK_MINUTES, Math.max(MIN_AUTO_LOCK_MINUTES, Math.round(minutes)));",
    why: "clamps the idle-lock window in MINUTES to its allowed range; a preference, not a balance",
  },
  // ---- the history page size (a count, never money) ------------------------
  {
    fragment: "const lim = Math.min(100, Math.max(1, Math.floor(limit)));",
    why: "clamps the history page size to a sane range; a row count, not a balance",
  },
  // ---- home's collapsing hero (pixels and opacity) ------------------------
  {
    fragment: "setP(Math.max(0, Math.min(1, p + e.deltaY / COLLAPSE_DIST)));",
    why: "the header collapse PROGRESS, 0..1, advanced by the wheel; a scroll fraction, not a value",
  },
  // ---- send's amount field, fiat readout and slider -----------------------
  // The amount actually sent is the decimal STRING `amount`, parsed to bigint
  // stroops in the worker. Everything below is the compose screen's own display
  // and slider math; none of it is signed, submitted or stored.
  {
    fragment: 'const fiat = price !== null && amount !== "" ? Number(amount) * price : null;',
    why: "a fiat estimate under the field; the sent amount is the string, parsed to stroops in the worker",
  },
  {
    fragment: "total += Number(p.spendable) * price;",
    why: "the private pocket's dollar hero totals each asset's spendable at its price for display; the spendable strings are what transact, parsed to stroops in the worker",
  },
  {
    fragment: "const a = Number(amount);",
    why: "the slider's position from the typed amount, display only",
  },
  {
    fragment: "const s = Number(spendable);",
    why: "the slider's span from the spendable balance, display only",
  },
  {
    fragment: "return Math.max(0, Math.min(100, Math.round((a / s) * 100)));",
    why: "the slider percentage 0..100; the amount it sets is computed in bigint by fractionOf",
  },
  {
    fragment: "size={Math.max(1, amount.length || 1)}",
    why: "the input width in characters, a string length",
  },
  {
    fragment: "const fitPx = Math.floor(430 / Math.max(1, amount.length));",
    why: "the compose amount's font size in pixels, scaled down so a long figure fits the card; a layout measure, not the value (which stays the string)",
  },
  {
    fragment: "const amountPx = Math.min(fontSizes.hero, Math.max(fontSizes.title, fitPx));",
    why: "clamps that compose font size between the title and hero sizes; still pixels, not a value",
  },
  {
    fragment: "onChange={(e) => onPercent(Number(e.target.value))}",
    why: "the slider's 0..100 value; converted to a bigint fraction before it touches the amount",
  },
  // ---- the chart's resample and morph (array indices, animation) ----------
  { fragment: "const a = Math.floor(x);", why: "a resample index into the source series" },
  {
    fragment: "const b = Math.min(arr.length - 1, a + 1);",
    why: "the next resample index, clamped to the array",
  },
  {
    fragment: "const N = Math.max(prev.length, values.length);",
    why: "the longer of two series lengths, an array count",
  },
  {
    fragment: "const p = Math.min(1, (now - start) / DUR);",
    why: "the morph animation's progress, 0..1",
  },
];

describe("the source of the value path, read rather than assumed", () => {
  const read = (rel: string) =>
    readFileSync(fileURLToPath(new URL(`../../${rel}`, import.meta.url)), "utf8");

  it("contains no floating-point conversion that has not been read and judged", () => {
    const unjudged: string[] = [];
    for (const rel of VALUE_PATH) {
      // block comments are blanked rather than removed, so line numbers still
      // point where a reader expects. a `{/* ... */}` JSX comment explaining why
      // a float is NOT used reads exactly like a float being used, which is how
      // this check reported a fix as the defect it fixed.
      const source = read(rel).replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
      const lines = source.split("\n");
      lines.forEach((line, i) => {
        if (!FLOATING.test(line)) return;
        const trimmed = line.trim();
        // a comment is prose about the code, not the code.
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        if (JUDGED_HARMLESS.some((j) => trimmed.includes(j.fragment))) return;
        unjudged.push(`${rel}:${i + 1}  ${trimmed}`);
      });
    }
    expect(
      unjudged,
      "a floating-point conversion sits in the value path without a written reason. " +
        "either it is a defect or it belongs in JUDGED_HARMLESS with the argument for it:\n" +
        unjudged.join("\n"),
    ).toEqual([]);
  });

  it("the inventory is live: every judged entry still exists in the source", () => {
    // an allowlist nobody prunes eventually excuses code that is gone and
    // shadows code that is not. this fails when an entry goes stale.
    const all = VALUE_PATH.map(read).join("\n");
    const stale = JUDGED_HARMLESS.filter((j) => !all.includes(j.fragment)).map((j) => j.fragment);
    expect(
      stale,
      `these allowlist entries no longer match any source line:\n${stale.join("\n")}`,
    ).toEqual([]);
  });

  it("no module in the value path formats a number through the locale", () => {
    const offenders: string[] = [];
    for (const rel of VALUE_PATH) {
      read(rel)
        .split("\n")
        .forEach((line, i) => {
          if (/toLocaleString|Intl\.NumberFormat|navigator\.language/.test(line)) {
            offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
          }
        });
    }
    expect(
      offenders,
      `a locale-aware formatter in the value path would make the digits on screen depend on ` +
        `the browser's language:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});
