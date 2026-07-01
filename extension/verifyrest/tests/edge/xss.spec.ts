// Injection payloads through every field that ends up on screen.
//
// React escapes text children by default, so passing is the expected outcome.
// That is exactly why it is asserted rather than assumed: the defence is a
// property of how each value happens to be rendered today, and one
// `dangerouslySetInnerHTML`, one `href={value}` or one `innerHTML` in a helper
// removes it silently. The assertions below are about the DOM the browser
// actually built, not about the string that was passed in.
import { Keypair } from "@stellar/stellar-sdk/base";
import { test, expect, onboard, receiveAddress, fund, compose, review, closeSend } from "./edge";
import type { Page } from "@playwright/test";

const valid = () => Keypair.random().publicKey();

/** 28 bytes exactly, so it survives the memo limit and reaches the screen. */
const IMG_PAYLOAD = "<img src=x onerror=alert(1)>";
const PAYLOADS = [
  { name: "an img/onerror payload", value: IMG_PAYLOAD },
  { name: "a script tag", value: "<script>alert(1)</script>" },
  { name: "a javascript: URI", value: "javascript:alert(1)" },
  { name: "template syntax", value: "${alert(1)}" },
  { name: "handlebars syntax", value: "{{7*7}}" },
  { name: "an svg onload payload", value: "<svg onload=alert(1)>" },
  { name: "a closing-tag break-out", value: '"><b>x</b>' },
];

/** What the payload would have created in the DOM if it had been parsed. */
async function injectedNodes(page: Page): Promise<{
  img: number;
  script: number;
  svg: number;
  bold: number;
  jsHrefs: number;
}> {
  return page.evaluate(() => ({
    img: document.querySelectorAll("img").length,
    // The popup's own bundle is loaded by <script>, so this counts what is
    // there at rest and the test compares against that, not against zero.
    script: document.querySelectorAll("script").length,
    svg: document.querySelectorAll("svg").length,
    bold: document.querySelectorAll("b").length,
    jsHrefs: [...document.querySelectorAll("a")].filter((a) =>
      a.getAttribute("href")?.toLowerCase().startsWith("javascript:"),
    ).length,
  }));
}

test("an injection payload in the memo is rendered as text, not parsed", async ({ wallet }) => {
  test.slow();
  const page = wallet.page;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // An alert would wedge the extension for the rest of the run, so the fact
  // that no dialog is ever opened is itself part of what is asserted.
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });

  await onboard(page);
  await fund(await receiveAddress(page));
  const before = await injectedNodes(page);

  await compose(page, { to: valid(), amount: "1", memo: IMG_PAYLOAD });
  const out = await review(page);
  expect(out.stage, out.stage === "error" ? out.message : "").toBe("confirm");

  // The memo is signed, so it has to be legible on the confirm screen exactly
  // as it will be sent: as those 28 characters, not as an image element.
  await expect(page.getByText(IMG_PAYLOAD, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(`Attach the memo "${IMG_PAYLOAD}"`)).toBeVisible();

  const after = await injectedNodes(page);
  expect(after.img, "the payload must not have become an <img>").toBe(before.img);
  expect(after.script, "the payload must not have become a <script>").toBe(before.script);
  expect(dialogs, "no payload may open a dialog").toBe(0);
  expect(errors, `no payload may raise a page error: ${errors.join(", ")}`).toEqual([]);
});

test("injection payloads in the recipient field are refused without being echoed back", async ({
  wallet,
}) => {
  const page = wallet.page;
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await onboard(page);
  const before = await injectedNodes(page);

  const echoed: string[] = [];
  for (const p of PAYLOADS) {
    await compose(page, { to: p.value, amount: "1" });
    const out = await review(page);
    expect(out.stage, `${p.name} must not reach the confirm screen`).toBe("error");
    const said = out.stage === "error" ? out.message : "";
    // Not echoing is a stronger property than escaping, and it is the one the
    // error taxonomy actually promises: `describeError` authors the sentence
    // and interpolates nothing the user typed. An echoed value is one
    // rendering change away from being live.
    if (said.includes(p.value)) echoed.push(`${p.name}: ${said}`);
    await closeSend(page);
  }
  expect(echoed, `an error message must not repeat what was typed:\n${echoed.join("\n")}`).toEqual(
    [],
  );

  const after = await injectedNodes(page);
  expect(after).toEqual(before);
  expect(dialogs).toBe(0);
});

test("injection payloads in the recovery phrase field are refused without being echoed back", async ({
  wallet,
}) => {
  const page = wallet.page;
  let dialogs = 0;
  page.on("dialog", (d) => {
    dialogs += 1;
    void d.dismiss();
  });
  await page.getByRole("button", { name: "I have a recovery phrase" }).click();
  const before = await injectedNodes(page);

  for (const p of PAYLOADS) {
    await page.getByLabel("Recovery phrase").fill(p.value);
    await page.getByLabel("New password", { exact: true }).fill("a-strong-password");
    await page.getByRole("button", { name: "Import wallet" }).click();
    // Whatever the wallet says, it must not be the phrase read back: a
    // recovery phrase is the one string that must never be re-rendered, and a
    // payload is just the case where that is visible.
    await expect(page.getByText("PUBLIC POCKET")).toBeHidden();
    const body = await page.locator("body").innerText();
    expect(body, `${p.name} must not be echoed into the page`).not.toContain(p.value);
  }

  expect(await injectedNodes(page)).toEqual(before);
  expect(dialogs).toBe(0);
});

test("a very long single token in a field cannot reach the ledger or the DOM", async ({
  wallet,
}) => {
  const page = wallet.page;
  await onboard(page);
  const before = await injectedNodes(page);

  // 100,000 characters with no break opportunity, in every field at once.
  const huge = "A".repeat(100_000);
  await compose(page, { to: huge, amount: huge, memo: huge });
  const out = await review(page);
  expect(out.stage).toBe("error");
  const said = out.stage === "error" ? out.message : "";
  expect(said.length, "the wallet must not render a 100,000-character error").toBeLessThan(1_000);
  expect(await injectedNodes(page)).toEqual(before);
});
