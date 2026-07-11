// scratch: screenshot whatever is being worked on, so a visual change is
// checked by looking rather than by asserting it probably worked.
//
// not a gate. run with:
//   npx playwright test -c playwright.motion.config.ts tests/motion/look.capture.ts
import { test } from "../support/fixtures";
import { WAITS } from "../support/wallet";
import { fund } from "../support/testnet";

const PASSWORD = "a-strong-test-password";
const OUT = "/tmp/pocket-look";

test("home, funded, both pockets", async ({ wallet }) => {
  test.setTimeout(WAITS.onboarding + 180_000);
  const page = wallet.page;
  await page.setViewportSize({ width: 384, height: 600 });
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome();

  await page.screenshot({ path: `${OUT}/home-unfunded.png` });

  // a chart needs a history, and a history needs the account to exist.
  const address = await wallet.revealAddress();
  await fund(address);
  // the worker holds the session, so a reload does not lock. it just refetches.
  await wallet.reopen();
  await wallet.waitForHome();
  // the series is fetched after the balance lands.
  await page.waitForTimeout(6000);
  await page.screenshot({ path: `${OUT}/home-funded.png` });

  // home chart with a hover.
  await page.locator('svg[width="384"]').first().waitFor({ timeout: 15000 });
  const homeChart = page.locator('svg[width="384"]').first();
  const hb = await homeChart.boundingBox();
  if (hb) {
    await page.mouse.move(hb.x + hb.width * 0.45, hb.y + hb.height / 2);
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${OUT}/home-hover.png` });
    await page.mouse.move(hb.x - 5, hb.y);
  }

  // asset detail: one shot right as it opens (full height + price skeleton), one after load.
  await page.getByRole("button", { name: /^XLM/ }).first().click();
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}/asset-open.png` });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/asset-detail.png` });
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.waitForTimeout(600);

  // a valid recipient: this wallet's own address, read from the receive sheet.
  const addr = await wallet.revealAddress();

  // send compose + confirm popup.
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/send-compose.png` });
  await page.getByLabel("To", { exact: true }).fill(addr);
  await page.getByLabel("Amount (XLM)").fill("1");
  await page.getByRole("button", { name: "Continue" }).click();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${OUT}/send-confirm.png` });

});