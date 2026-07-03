// Amounts. Stellar carries 7 decimals and integral stroops end to end, so the
// boundaries that matter are the eighth decimal place, zero, negative, and the
// point where a number stops being a number.
//
// Two separate questions, deliberately asked by separate tests: was the bad
// amount REFUSED, and was the user TOLD WHAT WAS WRONG. A wallet can do the
// first perfectly and still answer a misplaced decimal point with "check your
// connection", which sends the user to restart their router over a typo. Fold
// them into one test and the second failure hides behind the first pass.
import { Keypair } from "@stellar/stellar-sdk/base";
import {
  test,
  expect,
  onboard,
  receiveAddress,
  fund,
  compose,
  review,
  closeSend,
  GENERIC_FAILURE,
  SLOW,
  surfaceText,
} from "./edge";

// Every action gets a bound. Playwright's default `actionTimeout` is 0, meaning
// "wait until the test times out", so a `fill()` on a field that never appears
// hangs for the config's 15 minutes (45 with `test.slow()`) instead of failing.
// A mutation run found this the expensive way: a mutation that let every bad
// phrase import left the next `fill()` looking for a field on the home screen,
// and the run sat there for a quarter of an hour. A test that hangs instead of
// failing is a test nobody will run.
test.use({ actionTimeout: SLOW });

const valid = () => Keypair.random().publicKey();

/** The wallet's own account is unfunded, so an ACCEPTED amount gets this far. */
const REACHED_THE_LEDGER = /does not exist on this network/i;
/** i64 max in stroops, as a user would type it. */
const I64_MAX = "922337203685.4775807";
/** MAX_AMOUNT from core/witness/guards.ts: the circuit's range bound, 2^127. */
const RANGE_BOUND = "17014118346046923173168730371588.4105728";

/** Every shape that is not a number this wallet can pay. */
const MALFORMED = [
  { name: "eight decimal places, one too fine", amount: "0.00000001" },
  { name: "exponential form", amount: "1e10" },
  { name: "a thousands separator", amount: "1,000" },
  { name: "a decimal comma", amount: "1,5" },
  { name: "Arabic-Indic digits", amount: "١٢٣" },
  { name: "whitespace only", amount: "   " },
  { name: "Infinity", amount: "Infinity" },
  { name: "NaN", amount: "NaN" },
  { name: "letters", amount: "abc" },
  { name: "hex", amount: "0x10" },
  { name: "a leading plus", amount: "+1" },
  { name: "a bare fraction", amount: ".5" },
  { name: "two dots", amount: "1.2.3" },
  { name: "a lone minus", amount: "-" },
  { name: "an HTML injection payload", amount: "<img src=x onerror=alert(1)>" },
];

test("a malformed amount never reaches the confirm screen or the ledger", async ({ wallet }) => {
  const page = wallet.page;
  await onboard(page);
  const to = valid();

  const accepted: string[] = [];
  for (const c of MALFORMED) {
    await compose(page, { to, amount: c.amount });
    const out = await review(page);
    if (out.stage === "confirm") accepted.push(c.name);
    // Reaching the balance read means parseAmount let it through: on this
    // unfunded wallet that is the next thing that speaks.
    else if (REACHED_THE_LEDGER.test(out.message)) accepted.push(`${c.name} (reached the ledger)`);
    await closeSend(page);
  }
  expect(accepted, `these malformed amounts were not refused: ${accepted.join(", ")}`).toEqual([]);
});

test("a malformed amount is named as an amount problem, not a network one", async ({ wallet }) => {
  const page = wallet.page;
  await onboard(page);
  const to = valid();

  const blamedTheNetwork: string[] = [];
  for (const c of MALFORMED) {
    await compose(page, { to, amount: c.amount });
    const out = await review(page);
    if (out.stage === "error" && GENERIC_FAILURE.test(out.message)) {
      blamedTheNetwork.push(`${c.name}: ${out.message}`);
    }
    await closeSend(page);
  }
  expect(
    blamedTheNetwork,
    "an amount the user typed must not come back as a connection problem, because no amount " +
      `of retrying fixes it:\n${blamedTheNetwork.join("\n")}`,
  ).toEqual([]);
});

test("well-formed amounts at the edges of the format are accepted", async ({ wallet }) => {
  const page = wallet.page;
  await onboard(page);
  const to = valid();

  const wellFormed = [
    { name: "one stroop, the smallest unit", amount: "0.0000001" },
    { name: "surrounding whitespace", amount: "  1.5  " },
    { name: "leading zeros", amount: "00001" },
    { name: "a trailing dot", amount: "1." },
    { name: "seven decimal places exactly", amount: "1.2345678" },
  ];

  const refused: string[] = [];
  for (const c of wellFormed) {
    await compose(page, { to, amount: c.amount });
    const out = await review(page);
    const said = out.stage === "error" ? out.message : "confirm";
    // Unfunded, so the honest end of the road is the ledger read.
    if (!REACHED_THE_LEDGER.test(said) && said !== "confirm") refused.push(`${c.name}: ${said}`);
    await closeSend(page);
  }
  expect(refused, `well-formed amounts refused:\n${refused.join("\n")}`).toEqual([]);
});

test("zero and negative amounts never reach the confirm screen", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  const accepted: string[] = [];
  for (const amount of ["0", "0.0000000", "-1", "-0.0000001", "-0"]) {
    await compose(page, { to, amount });
    const out = await review(page);
    if (out.stage === "confirm") accepted.push(`${amount} reached the confirm screen`);
    await closeSend(page);
  }
  expect(accepted, accepted.join("\n")).toEqual([]);
});

test("zero and negative amounts are named as amounts, not as a network problem", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  const blamedTheNetwork: string[] = [];
  for (const amount of ["0", "0.0000000", "-1", "-0.0000001"]) {
    await compose(page, { to, amount });
    const out = await review(page);
    if (out.stage === "error" && GENERIC_FAILURE.test(out.message)) {
      blamedTheNetwork.push(`${amount}: ${out.message}`);
    }
    await closeSend(page);
  }
  expect(blamedTheNetwork, blamedTheNetwork.join("\n")).toEqual([]);
});

test("amounts past what the account holds are refused by size, and say so", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  // Friendbot funds exactly 10,000 XLM, so each of these is over the balance:
  // just over, at i64 max, one stroop past i64 max, at the circuit's 2^127
  // range bound, and a 400-digit number no format can hold.
  const overSized = ["10001", I64_MAX, "922337203685.4775808", RANGE_BOUND, "9".repeat(400)];
  const bad: string[] = [];
  for (const amount of overSized) {
    await compose(page, { to, amount });
    const out = await review(page);
    if (out.stage === "confirm") {
      bad.push(`${amount.slice(0, 20)} reached the confirm screen`);
    } else if (!/more than you can send/i.test(out.message)) {
      bad.push(`${amount.slice(0, 20)}: ${out.message}`);
    }
    await closeSend(page);
  }
  expect(bad, bad.join("\n")).toEqual([]);
});

test("the amount on the confirm screen is the amount that was typed", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));

  await compose(page, { to: valid(), amount: "  1.2345678  " });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");
  // 7 decimals, no rounding, no float drift, and the whitespace that was typed
  // is not carried into what is about to be signed.
  await expect(page.getByText("1.2345678XLM")).toBeVisible();
  await expect(page.getByText("Send 1.2345678 XLM to this address")).toBeVisible();
});

test("one stroop is stated as one stroop, not rounded away to zero", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));

  // The smallest thing this ledger can move. Rendering it through a float, or
  // through any two-decimal money formatter, produces "0.00" and a user who
  // approves a payment of nothing.
  await compose(page, { to: valid(), amount: "0.0000001" });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");
  await expect(page.getByText("Send 0.0000001 XLM to this address")).toBeVisible();
  const body = await surfaceText(page);
  expect(body, "one stroop must never be shown as zero").not.toContain("0.0000000 XLM");
});
