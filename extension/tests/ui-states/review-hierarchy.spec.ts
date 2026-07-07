// A3-01 and A3-03: the confirm step's two most decision-relevant strings were
// the two least prominent things on it.
//
// A3-01. `splitAmount` puts everything before the point in the whole part, so
// any value below one has the whole part "0". The whole part is set at full
// size and weight 800; the fraction is set at half that size and 0.62 opacity.
// Sending 0.5 XLM therefore rendered a meaningless "0" at 34px and the actual
// magnitude at 17px, faded.
//
// A3-03. The recipient address on the same screen was set at a hand-picked 13px
// that is not on the type scale, smaller than the transaction hash on the
// receipt, which is 14, and smaller than the memo line beside it.
//
// The build step is stubbed, because what is being asserted is how the popup
// SETS a summary it has been given, and a real payment would assert the same
// thing at the cost of testnet funds and two minutes.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";
const TO = "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H";

/** `fontSizes.body`. the receipt's hash sits one step below it, at 14. */
const BODY = 16;

async function stubBuild(page: import("@playwright/test").Page, amount: string): Promise<void> {
  await page.evaluate(
    ({ amount, to }) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
        if (msg?.type === "buildPayment") {
          return {
            ok: true,
            data: {
              xdr: "stub",
              summary: {
                decoded: true,
                to,
                amount,
                assetCode: "XLM",
                fee: "100",
                network: "testnet",
                effects: [`Send ${amount} XLM to ${to}`],
              },
            },
          };
        }
        return send(msg);
      };
    },
    { amount, to: TO },
  );
}

test("a sub-one amount is set as one run, not as a giant zero", async ({ wallet }) => {
  test.setTimeout(3 * 60_000);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await stubBuild(wallet.page, "0.5000000");

  await wallet.page.getByRole("button", { name: "Send" }).click();
  await wallet.page.getByRole("textbox", { name: "To", exact: true }).fill(TO);
  await wallet.page.getByRole("textbox", { name: /Amount/ }).fill("0.5");
  await wallet.page.getByRole("button", { name: "Review" }).click();
  await expect(wallet.page.getByText("What this does")).toBeVisible({ timeout: WAITS.proving });

  // The figure is announced whole regardless of how it is drawn, so the visual
  // half is measured on the drawn half: every glyph of a sub-one amount must be
  // set at one size, with nothing faded.
  const sizes = await wallet.page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("[aria-hidden='true']"));
    const amount = nodes.find((n) => /^0[.,]5$/.test((n.textContent ?? "").trim()));
    if (!amount) return null;
    const walk = (el: Element): { size: number; opacity: number; text: string }[] => {
      const s = getComputedStyle(el);
      const own = { size: parseFloat(s.fontSize), opacity: parseFloat(s.opacity), text: el.textContent ?? "" };
      return [own, ...Array.from(el.children).flatMap(walk)];
    };
    return walk(amount);
  });

  expect(sizes, "the review must render a 0.5 amount at all").not.toBeNull();
  const digits = sizes!.filter((s) => /\d/.test(s.text));
  const distinct = new Set(digits.map((s) => s.size));
  expect(
    distinct.size,
    `the "5" must be set at the same size as the "0", and the run used ${[...distinct].join("/")}px`,
  ).toBe(1);
  for (const d of digits) {
    expect(d.opacity, "no part of a sub-one amount may be faded: it is the whole figure").toBe(1);
  }
});

test("the recipient address is no smaller than the type scale allows", async ({ wallet }) => {
  test.setTimeout(3 * 60_000);
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await stubBuild(wallet.page, "1.0000000");

  await wallet.page.getByRole("button", { name: "Send" }).click();
  await wallet.page.getByRole("textbox", { name: "To", exact: true }).fill(TO);
  await wallet.page.getByRole("textbox", { name: /Amount/ }).fill("1");
  await wallet.page.getByRole("button", { name: "Review" }).click();

  const shown = wallet.page.getByText(TO).first();
  await expect(shown).toBeVisible({ timeout: WAITS.proving });
  const size = await shown.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    size,
    `the address someone checks before approving was set at ${size}px, below the ${BODY}px the scale gives ordinary body text`,
  ).toBeGreaterThanOrEqual(BODY);

  // And it is still the whole address: shrinking is not the only way to lose it.
  await expect(shown).toHaveText(TO);
});
