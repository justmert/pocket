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

  await page.getByRole("button", { name: /private pocket/i }).click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/home-private.png` });
});
