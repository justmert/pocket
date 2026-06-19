// Amounts. Stellar carries 7 decimals and integral stroops end to end, so the
// boundaries that matter are the eighth decimal place, zero, negative, and the
// point where a number stops being a number.
//
// What is under test is not only the refusal but WHAT THE USER IS TOLD. A
// wallet that answers a typo with "check your connection" has sent the user to
// restart their router over a misplaced decimal point.
import { Keypair } from "@stellar/stellar-sdk/base";
import { test, expect, onboard, receiveAddress, fund, compose } from "./launch";
import { review, BLAMES_THE_NETWORK } from "./probe";

const valid = () => Keypair.random().publicKey();
/** The wallet's own account is unfunded, so an ACCEPTED amount gets this far. */
const ACCEPTED = /does not exist on this network/i;
/** i64 max in stroops, as a user would type it. */
const I64_MAX = "922337203685.4775807";
/** MAX_AMOUNT from core/witness/guards.ts: the circuit's range bound, 2^127. */
const RANGE_BOUND = "17014118346046923173168730371588.4105728";

test("a malformed amount is refused as an amount problem, not a network one", async ({
  pocket,
}) => {
  const page = await pocket.popup();
  await onboard(page);
  const to = valid();

  const malformed = [
    { name: "eight decimal places, one too fine", amount: "0.00000001" },
    { name: "exponential form", amount: "1e10" },
    { name: "a thousands separator", amount: "1,000" },
    { name: "a decimal comma", amount: "1,5" },
    { name: "Arabic-Indic digits", amount: "١٢٣" },
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

  const blamedTheNetwork: string[] = [];
  const accepted: string[] = [];
  for (const c of malformed) {
    await compose(page, { to, amount: c.amount });
    const out = await review(page);
    if (out.stage === "confirm") {
      accepted.push(c.name);
    } else {
      if (BLAMES_THE_NETWORK.test(out.message)) blamedTheNetwork.push(`${c.name}: ${out.message}`);
      if (ACCEPTED.test(out.message)) accepted.push(`${c.name} (reached the ledger read)`);
    }
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("PUBLIC POCKET")).toBeVisible();
  }

  expect(accepted, `these malformed amounts were not refused: ${accepted.join(", ")}`).toEqual([]);
  expect(
    blamedTheNetwork,
    `a malformed amount must not be reported as a connection problem:\n${blamedTheNetwork.join("\n")}`,
  ).toEqual([]);
});

test("well-formed amounts at the edges of the format are accepted", async ({ pocket }) => {
  const page = await pocket.popup();
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
    if (!ACCEPTED.test(said) && said !== "confirm") refused.push(`${c.name}: ${said}`);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("PUBLIC POCKET")).toBeVisible();
  }
  expect(refused, `well-formed amounts refused:\n${refused.join("\n")}`).toEqual([]);
});

test("zero and negative amounts are refused as amounts", async ({ pocket }) => {
  test.slow();
  const page = await pocket.popup();
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  const bad: string[] = [];
  for (const amount of ["0", "0.0000000", "-1", "-0.0000001"]) {
    await compose(page, { to, amount });
    const out = await review(page);
    if (out.stage === "confirm") {
      bad.push(`${amount} reached the confirm screen`);
    } else if (BLAMES_THE_NETWORK.test(out.message)) {
      bad.push(`${amount} was reported as a connection problem: ${out.message}`);
    }
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("PUBLIC POCKET")).toBeVisible();
  }
  expect(bad, bad.join("\n")).toEqual([]);
});

test("amounts past what the account holds are refused by size, and say so", async ({ pocket }) => {
  test.slow();
  const page = await pocket.popup();
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  // Friendbot funds exactly 10,000 XLM, so each of these is over the balance
  // and under the range bound, at i64 max, one past it, and at 2^127 stroops.
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
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("PUBLIC POCKET")).toBeVisible();
  }
  expect(bad, bad.join("\n")).toEqual([]);
});

test("the amount on the confirm screen is the amount that was typed", async ({ pocket }) => {
  test.slow();
  const page = await pocket.popup();
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
