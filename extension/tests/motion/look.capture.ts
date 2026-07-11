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

  // scrub the HOME chart: pill + grey-beyond, the thing complaint 1 was about.
  const scrub = async (svg: import("@playwright/test").Locator, name: string) => {
    const b = await svg.boundingBox();
    if (!b) { console.log(name, "no bbox"); return; }
    const x = b.x + b.width * 0.42, y = b.y + b.height / 2;
    const wrapper = svg.locator("xpath=..");
    await wrapper.dispatchEvent("pointerdown", { clientX: x, clientY: y, pointerId: 1, isPrimary: true });
    await wrapper.dispatchEvent("pointermove", { clientX: x + 1, clientY: y, pointerId: 1, isPrimary: true });
    await page.waitForTimeout(350);
    const dots = await svg.locator("circle").count();
    const fired = await page.evaluate(() => (window as unknown as {__scrubFired?:number}).__scrubFired ?? 0);
    console.log(name, "dots:", dots, "trackFired:", fired);
    await page.screenshot({ path: `${OUT}/${name}.png` });
    await wrapper.dispatchEvent("pointerup", { pointerId: 1 });
  };
  await page.locator('svg[width="348"]').first().waitFor({ timeout: 15000 });
  await scrub(page.locator('svg[width="348"]').first(), "home-scrub");

  // the asset detail sheet.
  await page.getByRole("button", { name: /^XLM/ }).first().click();
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/asset-detail.png` });
  // scoped to the dialog, so it is the detail chart and not the home one behind it.
  await page.getByRole("dialog").locator('svg[width="348"]').first().waitFor({ timeout: 15000 });
  await scrub(page.getByRole("dialog").locator('svg[width="348"]').first(), "asset-scrub");
});
