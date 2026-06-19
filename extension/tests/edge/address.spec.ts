// Recipient field: every shape of address a user can produce.
//
// The governing fact (core/chain/address.ts): matching a G-address's first and
// last four characters costs about an hour on a laptop. So a recipient is only
// safe if the wallet both refuses the wrong ones for a NAMED reason and shows
// the accepted one in full.
import { Account, Keypair, MuxedAccount } from "@stellar/stellar-sdk/base";
import { test, expect, onboard, receiveAddress, fund, compose, SLOW } from "./launch";
import { review, BLAMES_THE_NETWORK } from "./probe";

const CHECKSUM = /bad checksum/i;
const NOT_AN_ADDRESS = /does not look like a Stellar address/i;
/** The wallet's own account is unfunded, so a VALID recipient gets this far. */
const REACHED_THE_LEDGER = /does not exist on this network|more than you can send/i;

const valid = () => Keypair.random().publicKey();

/** One character changed, so the shape is right and the checksum is not. */
function flipOne(address: string): string {
  const i = 10;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const next = alphabet[(alphabet.indexOf(address[i]!) + 1) % alphabet.length]!;
  return address.slice(0, i) + next + address.slice(i + 1);
}

test("each kind of bad recipient is named for what is wrong with it", async ({ pocket }) => {
  const page = await pocket.popup();
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
  for (const c of cases) {
    await compose(page, { to: c.to, amount: "1" });
    const out = await review(page);
    const said = out.stage === "error" ? out.message : `ACCEPTED, reached ${out.stage}`;
    if (!c.expect.test(said)) wrong.push(`${c.name}: got "${said}"`);
    await page.getByRole("button", { name: "Close" }).click();
    await expect(page.getByText("PUBLIC POCKET")).toBeVisible();
  }
  expect(wrong, `recipients reported wrongly:\n${wrong.join("\n")}`).toEqual([]);
});

test("a whitespace-padded address is accepted, not rejected for the padding", async ({
  pocket,
}) => {
  const page = await pocket.popup();
  await onboard(page);
  await compose(page, { to: `  ${valid()}\n`, amount: "1" });
  const out = await review(page);
  const said = out.stage === "error" ? out.message : "accepted";
  expect(said).toMatch(REACHED_THE_LEDGER);
});

test("a contract address is refused with a reason, not a network error", async ({ pocket }) => {
  const page = await pocket.popup();
  await onboard(page);
  // The live confidential token from core/config.ts: a real C-address.
  await compose(page, {
    to: "CDMXZEFOM5DN2GSHQKNOOW242RJZGCEM5LOOAPGRQE35GGHB7ALDK2Y6",
    amount: "1",
  });
  const out = await review(page);
  expect(out.stage).toBe("error");
  const said = out.stage === "error" ? out.message : "";
  // Refusing is correct: a classic PaymentOp cannot pay a C-address. Telling
  // the user their connection is at fault is not.
  expect(said, "a contract address must not be reported as a connection problem").not.toMatch(
    BLAMES_THE_NETWORK,
  );
  // And it must not be conflated with a string that is not an address at all.
  expect(said, "a contract address is a valid address of the wrong kind").not.toMatch(
    NOT_AN_ADDRESS,
  );
});

test("a muxed address is either accepted or refused for a stated reason", async ({ pocket }) => {
  const page = await pocket.popup();
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

test("Review stays disabled until both a recipient and an amount exist", async ({ pocket }) => {
  const page = await pocket.popup();
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

test("an accepted recipient is shown back in full, chunked, never truncated", async ({
  pocket,
}) => {
  test.slow();
  const page = await pocket.popup();
  await onboard(page);
  await fund(await receiveAddress(page));

  const to = valid();
  await compose(page, { to, amount: "1.5" });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");

  const block = page.locator("div[style*='break-all']").first();
  await expect(block).toBeVisible({ timeout: SLOW });
  const shown = (await block.innerText()).replace(/\s/g, "");
  expect(shown).toBe(to);
  expect(shown).not.toContain("…");
});
