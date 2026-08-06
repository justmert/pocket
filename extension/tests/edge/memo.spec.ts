// The memo, through the screen a user actually sees.
//
// A Stellar text memo is 28 BYTES, not 28 characters. The distinction is
// invisible in ASCII and decisive outside it: a 28-character English memo fits
// and a 10-character emoji memo does not. `src/core/memo-bytes.test.ts` pins
// the boundary at the unit level; this file pins what the user is TOLD, which
// is the half that decides whether a rejected memo is fixable.
//
// The memo check sits after the balance read in `doBuildPayment`, so every test
// here needs a funded account: an unfunded one is refused for the balance
// before the memo is ever looked at.
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
const bytes = (s: string) => new TextEncoder().encode(s).length;

test("a memo that fits in 28 bytes is accepted and shown back exactly", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  const fits = [
    { name: "28 ASCII characters, the limit exactly", memo: "a".repeat(28) },
    { name: "seven emoji, 28 bytes exactly", memo: "🙂".repeat(7) },
    { name: "RTL text", memo: "مرحبا" },
    { name: "a single character", memo: "x" },
  ];

  const refused: string[] = [];
  for (const c of fits) {
    expect(bytes(c.memo), `${c.name} must actually be within the limit`).toBeLessThanOrEqual(28);
    await compose(page, { to, amount: "1", memo: c.memo });
    const out = await review(page);
    if (out.stage !== "confirm") {
      refused.push(`${c.name}: ${out.message}`);
    } else {
      // The memo is signed, so it has to be reviewable character for
      // character. A memo silently altered between the field and the envelope
      // is the usual way an exchange deposit is lost.
      await expect(page.getByText(`Attach the memo "${c.memo}"`)).toBeVisible();
    }
    await closeSend(page);
  }
  expect(refused, `memos within the byte limit were refused:\n${refused.join("\n")}`).toEqual([]);
});

test("a memo past 28 bytes is refused", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  const tooLong = [
    { name: "29 ASCII characters, one over", memo: "a".repeat(29) },
    { name: "ten emoji, 40 bytes and 10 characters", memo: "🙂".repeat(10) },
    { name: "a very long single token", memo: "x".repeat(500) },
  ];

  const accepted: string[] = [];
  for (const c of tooLong) {
    expect(bytes(c.memo), `${c.name} must actually be over the limit`).toBeGreaterThan(28);
    await compose(page, { to, amount: "1", memo: c.memo });
    const out = await review(page);
    if (out.stage === "confirm") accepted.push(`${c.name} reached the confirm screen`);
    await closeSend(page);
  }
  expect(accepted, `an oversized memo must never be signed:\n${accepted.join("\n")}`).toEqual([]);
});

test("an oversized memo is named as the memo, not as a connection problem", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));

  // Ten emoji. Ten characters on screen, forty bytes on the wire, and the one
  // case where a user has no way of guessing what is wrong unless told.
  await compose(page, { to: valid(), amount: "1", memo: "🙂".repeat(10) });
  const out = await review(page);
  expect(out.stage).toBe("error");
  const said = out.stage === "error" ? out.message : "";

  expect(said, "the refusal must name the memo").toMatch(/memo/i);
  expect(
    said,
    "no amount of retrying shortens a memo, so telling the user to check their connection " +
      "sends them to their router over a string they typed",
  ).not.toMatch(GENERIC_FAILURE);
  // And it has to say WHICH limit, because "too long" is not actionable when
  // the memo is visibly ten characters.
  expect(said, "the refusal must say the limit counts bytes").toMatch(/byte/i);
});

test("the byte count in the refusal is the byte count of what was typed", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  // A number in an error message is a promise that the user can act on it: if
  // it says 40 and the limit is 28, twelve bytes have to come out. So the
  // number has to be the byte count of the string in the box, counted the same
  // way the envelope will count it, and the limit has to be the real one.
  const cases = [
    { name: "ten emoji", memo: "🙂".repeat(10), is: 40 },
    // Trailing spaces are bytes too. If anything trimmed the memo before
    // counting, the number in the message and the number the user can see in
    // the field would disagree, and the advice would be wrong by two.
    { name: "28 ASCII plus two trailing spaces", memo: `${"a".repeat(28)}  `, is: 30 },
    { name: "27 ASCII plus one accented character", memo: `${"a".repeat(27)}é`, is: 29 },
  ];

  const wrong: string[] = [];
  for (const c of cases) {
    const used = bytes(c.memo);
    expect(used, `the ${c.name} fixture must be ${c.is} bytes`).toBe(c.is);
    await compose(page, { to, amount: "1", memo: c.memo });
    const out = await review(page);
    const said = out.stage === "error" ? out.message : "ACCEPTED";
    if (!said.includes(String(used))) wrong.push(`${c.name}: ${used} bytes, but it said "${said}"`);
    if (!/\b28\b/.test(said)) wrong.push(`${c.name}: the limit 28 was not stated: "${said}"`);
    await closeSend(page);
  }
  expect(wrong, wrong.join("\n")).toEqual([]);
});

test("the memo limit is 28 bytes, not 27 and not 29", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));
  const to = valid();

  // Both sides of the same boundary in one test, because a guard that is off by
  // one in the SAFE direction still costs a user their memo and no test that
  // only pushes from above would ever see it.
  const boundary = [
    { memo: "a".repeat(27), is: 27, accepted: true },
    { memo: "a".repeat(28), is: 28, accepted: true },
    { memo: "🙂".repeat(7), is: 28, accepted: true },
    { memo: `${"🙂".repeat(6)}abcd`, is: 28, accepted: true },
    { memo: "a".repeat(29), is: 29, accepted: false },
    { memo: `${"a".repeat(27)}é`, is: 29, accepted: false },
  ].map((c) => ({ ...c, name: `${c.is} bytes as ${JSON.stringify(c.memo.slice(0, 12))}…` }));

  const wrong: string[] = [];
  for (const c of boundary) {
    // The fixture is checked before the wallet is: a case that is not the
    // number of bytes it claims tests the boundary next door.
    expect(bytes(c.memo), `${c.name} must actually be ${c.is} bytes`).toBe(c.is);
    await compose(page, { to, amount: "1", memo: c.memo });
    const out = await review(page);
    const reached = out.stage === "confirm";
    if (reached !== c.accepted) {
      wrong.push(
        `${c.name} was ${reached ? "accepted" : "refused"}: ` +
          (out.stage === "error" ? out.message : "reached the confirm screen"),
      );
    }
    await closeSend(page);
  }
  expect(wrong, wrong.join("\n")).toEqual([]);
});

test("a memo that is only whitespace is reviewed as a memo, not as none", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));

  // Whitespace is a real, signed memo and it looks like an empty field. The
  // confirm screen must not describe it as "no memo": that is the one
  // difference between a deposit that credits and one that does not.
  await compose(page, { to: valid(), amount: "1", memo: "   " });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");
  const body = await surfaceText(page);
  expect(body, "a whitespace memo is still a memo and must not be reported as none").not.toContain(
    "Send with NO memo",
  );
});

test("no memo at all is stated as an absence, never left to be inferred", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));

  await compose(page, { to: valid(), amount: "1", memo: "" });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");
  await expect(page.getByText("Send with NO memo")).toBeVisible();
  await expect(
    page.getByText("Exchanges usually need one; a deposit without it can be lost."),
  ).toBeVisible();
});
