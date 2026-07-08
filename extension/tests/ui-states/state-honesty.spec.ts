// Five S1s that survived the implementation phase, and the assertions that keep
// them closed.
//
// A5-03 / A7-02  the private hero said "Not open yet" for a pocket that exists
//                and merely cannot be read, which is the most frightening
//                available reading of a state that is usually one press from
//                fixed
// A7-03 / A9-06  a null pocket said "Reading the ledger." forever, including on
//                a deployment that has no private pocket to read
// A6-05          a clickable row's accessible name omitted its value, so a
//                screen-reader user could not tell which network was selected
// A6-06          the QR was a fixed 214px in a frame that is narrower at 200%
//                zoom, and a truncated QR is not a QR
// A2-06          the origin wrapped wherever `break-all` chose, and the length
//                that decides where is chosen by whoever chose the hostname
import { test, expect } from "../support/fixtures";
import type { Page } from "@playwright/test";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

async function stub(
  page: Page,
  pocket: Record<string, unknown> | null,
  status: Record<string, unknown> = {},
): Promise<void> {
  await page.addInitScript(
    ([p, st]) => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
        if (msg?.type === "privatePocket") {
          if (p === null) return { ok: false, error: "unreadable" };
          return { ok: true, data: p };
        }
        if (msg?.type === "status") {
          const real = await send(msg);
          if (real?.ok) return { ok: true, data: { ...real.data, privateAvailable: true, ...(st as object) } };
          return real;
        }
        return send(msg);
      };
    },
    [pocket, status] as const,
  );
}

/** the states where the pocket exists and the balance simply cannot be read. */
const UNREADABLE = [
  { state: "archived", says: "Dormant" },
  { state: "needsRecovery", says: "Needs rebuilding" },
  { state: "diverged", says: "Out of step" },
] as const;

for (const c of UNREADABLE) {
  test(`the hero says "${c.says}" rather than claiming a "${c.state}" pocket was never opened`, async ({
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    const page = wallet.page;
    await stub(page, { state: c.state, message: "x" });
    await wallet.createWallet(PASSWORD);
    await page.reload();
    await wallet.waitForHome(WAITS.ledgerRead);
    await wallet.openPocket("Private pocket");

    await expect(
      page.getByText(c.says, { exact: false }).first(),
      "the balance slot must name the state it is actually in",
    ).toBeVisible({ timeout: WAITS.ledgerRead });
    await expect(
      page.getByText("Not open yet"),
      'a pocket that exists and holds money was described as never opened',
    ).toHaveCount(0);
  });
}

test("a network with no private pocket says so instead of reading forever", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  // No pocket, and the deployment does not have one. The read is not slow; it
  // is not happening.
  await stub(page, null, { privateAvailable: false });
  await wallet.createWallet(PASSWORD);
  await page.reload();
  await wallet.waitForHome(WAITS.ledgerRead);
  await wallet.openMove();

  const sheet = page.locator("[role='dialog']");
  await expect(sheet.getByText(/no private pocket/i)).toBeVisible({ timeout: WAITS.ledgerRead });
  await expect(
    sheet.getByText(/reading the ledger/i),
    "a wallet with nothing to read claimed it was reading",
  ).toHaveCount(0);
});

test("a clickable row carries its value in its name, not only in its description", async ({
  wallet,
}) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await page.getByRole("button", { name: "Settings" }).click();

  // "Network" alone leaves a listener unable to tell which network is selected
  // without moving focus again, which is the one thing the row exists to say.
  const row = page.getByRole("button", { name: /Network/i }).first();
  await expect(row).toBeVisible({ timeout: WAITS.ledgerRead });
  const name = await row.evaluate((el) => {
    const ids = (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
    return ids.map((i) => document.getElementById(i)?.textContent?.trim() ?? "").join(" ");
  });
  expect(
    name,
    `the row's accessible name is "${name}", which does not say which network is selected`,
  ).toMatch(/testnet|mainnet/i);
});

test("the QR stays a whole QR in a frame narrower than its natural size", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  // What 200% zoom leaves of an 800px-capped popup.
  await page.setViewportSize({ width: 200, height: 600 });
  await page.getByRole("button", { name: "Receive" }).click();

  const svg = page.locator("svg[role='img'][aria-label*='QR']");
  await expect(svg).toBeVisible({ timeout: WAITS.ledgerRead });
  const box = await svg.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, right: r.right, viewport: window.innerWidth };
  });
  expect(
    Math.round(box.right),
    "the QR runs past the edge of the frame, so a scanner is given a code with a piece missing",
  ).toBeLessThanOrEqual(box.viewport);
  expect(box.width, "the QR collapsed to nothing rather than scaling").toBeGreaterThan(80);
});

test("the origin cannot be made to wrap where its owner chooses", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  const page = wallet.page;

  // A hostname built so a line break would leave a first line reading as a
  // domain the user trusts. The approval screen is reached by answering
  // `pendingDappRequest`, which is how the worker parks a real one.
  const hostile = "https://secure-login.paypal.com.verify-account-session.example.net";
  await page.addInitScript((origin) => {
    const send = chrome.runtime.sendMessage.bind(chrome.runtime);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.runtime as any).sendMessage = async (msg: { type?: string }) => {
      if (msg?.type === "pendingDappRequest") {
        return {
          ok: true,
          data: {
            id: "req-1",
            origin,
            summary: {
              decoded: true,
              source: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
              fee: "100",
              network: "testnet",
              effects: ["Send 1.0000000 XLM"],
            },
          },
        };
      }
      return send(msg);
    };
  }, hostile);
  await wallet.createWallet(PASSWORD);
  await page.reload();

  const shown = page.getByText("verify-account-session.example.net", { exact: false }).first();
  await expect(shown, "the approval screen must show the origin").toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  const box = await shown.evaluate((el) => {
    const holder = el.closest("div") as HTMLElement;
    const s = getComputedStyle(holder);
    const r = el.getBoundingClientRect();
    return {
      white: s.whiteSpace,
      lineHeight: parseFloat(s.lineHeight) || 0,
      height: r.height,
      full: (el.textContent ?? "").trim(),
    };
  });

  // One line, so there is no first line for an attacker to end wherever they
  // like. Measured as height rather than asserted from the style alone.
  expect(box.white, "the origin is allowed to wrap, and its owner chooses where").toBe("nowrap");
  if (box.lineHeight > 0) {
    expect(
      box.height,
      "the origin rendered on more than one line, so part of it can read as a different domain",
    ).toBeLessThan(box.lineHeight * 1.9);
  }

  // And nothing was truncated away: the whole host is present.
  expect(box.full).toContain("verify-account-session.example.net");
});
