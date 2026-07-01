// Recipient field: every shape of address a user can produce.
//
// The governing fact (core/chain/address.ts): matching a G-address's first and
// last four characters costs about an hour on a laptop. So a recipient is only
// safe if the wallet both refuses the wrong ones for a NAMED reason and shows
// the accepted one in full.
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk/base";
import { askWorker } from "../support/fixtures";
import {
  test,
  expect,
  onboard,
  receiveAddress,
  fund,
  compose,
  review,
  closeSend,
  saidBeyond,
  BLAMES_THE_NETWORK,
  GENERIC_FAILURE,
  SLOW,
} from "./edge";

// Every action gets a bound. Playwright's default `actionTimeout` is 0, meaning
// "wait until the test times out", so a `fill()` on a field that never appears
// hangs for the config's 15 minutes (45 with `test.slow()`) instead of failing.
// A mutation run found this the expensive way: a mutation that let every bad
// phrase import left the next `fill()` looking for a field on the home screen,
// and the run sat there for a quarter of an hour. A test that hangs instead of
// failing is a test nobody will run.
test.use({ actionTimeout: SLOW });

const CHECKSUM = /bad checksum/i;
const NOT_AN_ADDRESS = /does not look like a Stellar address/i;

const valid = () => Keypair.random().publicKey();

/** One character changed, so the shape is right and the checksum is not. */
function flipOne(address: string): string {
  const i = 10;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const next = alphabet[(alphabet.indexOf(address[i]!) + 1) % alphabet.length]!;
  return address.slice(0, i) + next + address.slice(i + 1);
}

test("each kind of bad recipient is named for what is wrong with it", async ({ wallet }) => {
  const page = wallet.page;
  await onboard(page);

  const good = valid();
  const cases: { name: string; to: string; expect: RegExp }[] = [
    { name: "empty-ish whitespace only", to: "   ", expect: NOT_AN_ADDRESS },
    { name: "junk", to: "not-an-address", expect: NOT_AN_ADDRESS },
    { name: "one character flipped", to: flipOne(good), expect: CHECKSUM },
    { name: "lowercased", to: good.toLowerCase(), expect: NOT_AN_ADDRESS },
    { name: "55 characters, one short", to: good.slice(0, 55), expect: NOT_AN_ADDRESS },
    { name: "57 characters, one long", to: good + "A", expect: CHECKSUM },
    { name: "an ed25519 SECRET key", to: Keypair.random().secret(), expect: NOT_AN_ADDRESS },
    { name: "emoji", to: "🙂🙂🙂", expect: NOT_AN_ADDRESS },
    { name: "RTL text", to: "مرحبا بالعالم", expect: NOT_AN_ADDRESS },
    {
      name: "an HTML injection payload",
      to: '<img src=x onerror="alert(1)">',
      expect: NOT_AN_ADDRESS,
    },
    { name: "a javascript: URI", to: "javascript:alert(1)", expect: NOT_AN_ADDRESS },
    {
      name: "template syntax",
      to: "${constructor.constructor('alert(1)')()}",
      expect: NOT_AN_ADDRESS,
    },
    { name: "a very long single token", to: "G".repeat(10_000), expect: NOT_AN_ADDRESS },
  ];

  const wrong: string[] = [];
  const said = new Map<string, string>();
  for (const c of cases) {
    await compose(page, { to: c.to, amount: "1" });
    const out = await review(page);
    const message = out.stage === "error" ? out.message : `ACCEPTED, reached ${out.stage}`;
    said.set(c.name, message);
    if (!c.expect.test(message)) wrong.push(`${c.name}: got "${message}"`);
    await closeSend(page);
  }
  expect(wrong, `recipients reported wrongly:\n${wrong.join("\n")}`).toEqual([]);

  // The two reasons are deliberately different (core/chain/address.ts): a bad
  // checksum is a typo or a corrupted paste and is worth re-reading, a
  // malformed string is the wrong kind of value entirely. Collapsing them would
  // pass every assertion above if BOTH regexes matched one message, so pin that
  // they are actually distinct strings.
  expect(
    said.get("one character flipped"),
    "a checksum failure and junk must not read the same",
  ).not.toBe(said.get("junk"));
});

test("a contract address is refused for being a contract, not for the network", async ({
  wallet,
}) => {
  const page = wallet.page;
  await onboard(page);
  // The live confidential token from core/config.ts: a real C-address.
  await compose(page, {
    to: "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6",
    amount: "1",
  });
  const out = await review(page);
  expect(out.stage).toBe("error");
  const said = out.stage === "error" ? out.message : "";
  // Refusing is correct and intended: a classic PaymentOp cannot pay a
  // C-address. Telling the user their connection is at fault is not.
  expect(said, "a contract address must not be reported as a connection problem").not.toMatch(
    BLAMES_THE_NETWORK,
  );
  // And it must not be conflated with a string that is not an address at all.
  expect(said, "a contract address is a valid address of the wrong kind").not.toMatch(
    NOT_AN_ADDRESS,
  );
  // Positively: the refusal has to name the thing the user can act on. The two
  // assertions above only say what it is not, and a message of "no" would pass
  // both of them.
  expect(said, "the refusal must name contract addresses as the reason").toMatch(/contract/i);
});

test("a muxed address is either accepted or refused for a stated reason", async ({ wallet }) => {
  const page = wallet.page;
  await onboard(page);
  const m = new MuxedAccount(new Account(valid(), "0"), "1").accountId();
  expect(m).toMatch(/^M[A-Z2-7]{68}$/);
  await compose(page, { to: m, amount: "1" });
  const out = await review(page);
  const said = out.stage === "error" ? out.message : "accepted";
  expect(said, "an M-address must not be reported as a connection problem").not.toMatch(
    BLAMES_THE_NETWORK,
  );
  expect(said, "an M-address is a real Stellar address").not.toMatch(NOT_AN_ADDRESS);
});

test("Review stays disabled until both a recipient and an amount exist", async ({ wallet }) => {
  const page = wallet.page;
  await onboard(page);
  const button = page.getByRole("button", { name: "Review" });

  await compose(page, {});
  await expect(button).toBeDisabled();
  await compose(page, { to: valid() });
  await expect(button).toBeDisabled();
  await compose(page, { to: "", amount: "1" });
  await expect(button).toBeDisabled();
  await compose(page, { to: valid(), amount: "1" });
  await expect(button).toBeEnabled();
});

test("the recipient on the confirm screen is the typed address, in full, never shortened", async ({
  wallet,
}) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  await fund(await receiveAddress(page));

  const to = valid();
  // Padded on both sides. A paste out of a chat window carries this, and
  // refusing it for the padding would be a defect in its own right.
  await compose(page, { to: `  ${to}\n`, amount: "1.5" });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");

  const block = page.getByText(/^G[A-Z2-7]{55}$/).first();
  await expect(block).toBeVisible({ timeout: SLOW });
  expect(
    (await block.innerText()).replace(/\s/g, ""),
    "the confirm screen must show the address that was typed, with the padding gone",
  ).toBe(to);

  // Independently of the block above: NOTHING anywhere on this screen may show
  // a base32 run cut off with an ellipsis. `shortenForList` exists for lists
  // and is explicitly banned from a confirm step, and an assertion that only
  // reads the first block would not notice a second, shortened one beside it.
  const body = await page.locator("body").innerText();
  expect(body, "a confirm screen must not carry a truncated address anywhere").not.toMatch(
    /[A-Z2-7]{4,}…/,
  );
});

test("a recipient of the wrong TYPE is refused at the message boundary", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  await onboard(page);
  // FUNDED, deliberately. On an unfunded wallet the balance read refuses
  // everything, so "refused for being the wrong type" and "refused because the
  // account does not exist" are the same observation and the test cannot tell
  // a working boundary from a missing one.
  await fund(await receiveAddress(page));

  // The popup can only send a string, so this goes over the same runtime
  // channel the popup uses, carrying the types the union promises and
  // TypeScript erases. Nothing downstream re-checks: an array whose single
  // element is a valid address stringifies straight back into one.
  const shapes: { name: string; to: unknown }[] = [
    { name: "a number", to: 1234 },
    { name: "null", to: null },
    { name: "an object", to: { toString: "G".repeat(56) } },
    { name: "an array holding a valid address", to: [valid()] },
    { name: "absent", to: undefined },
  ];
  const accepted: string[] = [];
  for (const s of shapes) {
    const answer = await askWorker<unknown>(page, {
      type: "buildPayment",
      to: s.to,
      amount: "1",
      assetId: "native",
    }).then(
      () => "ACCEPTED",
      (e: Error) => e.message,
    );
    if (answer === "ACCEPTED") accepted.push(s.name);
  }
  expect(accepted, `a recipient that is ${accepted.join(", ")} was built into a payment`).toEqual(
    [],
  );
});

test("the empty-recipient path never reaches the ledger at all", async ({ wallet }) => {
  const page = wallet.page;
  await onboard(page);
  // Review is disabled with an empty recipient, so the only way in is the
  // message channel. The point is that an empty string is refused as an
  // address rather than being sent to the network to find out.
  const failed = await askWorker<string>(page, {
    type: "buildPayment",
    to: "",
    amount: "1",
    assetId: "native",
  }).then(
    () => "ACCEPTED",
    (e: Error) => e.message,
  );
  expect(failed).toMatch(NOT_AN_ADDRESS);
  expect(failed).not.toMatch(GENERIC_FAILURE);
  // And the screen the user is on has not been told anything went wrong.
  expect(await saidBeyond(page, new Set())).not.toMatch(BLAMES_THE_NETWORK);
});
