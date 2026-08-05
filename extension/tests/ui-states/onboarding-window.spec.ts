// A2-01 and A4-01, both S0: the recovery phrase is shown once, in a window
// chrome closes whenever it loses focus.
//
// A user who does what the screen tells them, and opens a password manager to
// record 24 words, dismisses the only window holding them. The vault is already
// installed by then, so the wallet still opens and nothing looks wrong until the
// day the phrase is the only way back. Onboarding therefore hands itself to a
// tab before it paints.
//
// A toolbar popup cannot be opened by a test runner, so what gets driven is the
// discriminator the code actually uses: `chrome.tabs.getCurrent()` resolves to a
// Tab in a tab and to undefined in a popup. Both answers are exercised, the
// first for real and the second by answering as chrome documents a popup does.
import { test, expect } from "../support/fixtures";
import { WAITS } from "../support/wallet";

test("in a tab, onboarding stays where it is", async ({ wallet }) => {
  test.setTimeout(2 * 60_000);
  const page = wallet.page;

  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[] };
    w.__opened = [];
    const create = chrome.tabs.create.bind(chrome.tabs);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.tabs as any).create = (info: { url?: string }) => {
      w.__opened.push(info.url ?? "");
      return create(info);
    };
  });
  await page.reload();

  await expect(page.getByRole("button", { name: "Create a new wallet" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });
  const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
  expect(opened, "a tab must not hand onboarding to another tab").toEqual([]);
});

test("in a popup, onboarding moves to a tab before it shows anything", async ({ wallet }) => {
  test.setTimeout(2 * 60_000);
  const page = wallet.page;

  // Answer as a toolbar popup does, and record rather than perform the two acts
  // that would end this page.
  await page.addInitScript(() => {
    const w = window as unknown as { __opened: string[]; __closed: number };
    w.__opened = [];
    w.__closed = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.tabs as any).getCurrent = async () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.tabs as any).create = async (info: { url?: string }) => {
      w.__opened.push(info.url ?? "");
      return { id: 4242 };
    };
    window.close = () => {
      w.__closed += 1;
    };
  });
  await page.reload();

  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened)).length,
      { timeout: WAITS.ledgerRead },
    )
    .toBe(1);

  const [opened, closed] = await page.evaluate(() => {
    const w = window as unknown as { __opened: string[]; __closed: number };
    return [w.__opened[0], w.__closed] as const;
  });
  expect(opened, "the tab must open this extension's own popup document").toContain("popup.html");
  expect(closed, "the popup must close once the tab has it").toBeGreaterThan(0);

  // And nothing of the flow was painted in the window that was about to close.
  await expect(
    page.getByRole("button", { name: "Create a new wallet" }),
    "a window that is handing off must not render the first step of the flow",
  ).toHaveCount(0);
});

test("in a window wider than any popup, the frame is centred rather than cornered", async ({
  wallet,
}) => {
  test.setTimeout(2 * 60_000);
  const page = wallet.page;

  // Chrome caps a toolbar popup at 800px wide, so this window cannot be one.
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.getByRole("button", { name: "Create a new wallet" })).toBeVisible({
    timeout: WAITS.ledgerRead,
  });

  const wide = await page.evaluate(() => {
    const frame = document.querySelector("#root > *") as HTMLElement | null;
    const box = frame?.getBoundingClientRect();
    return {
      left: box?.left ?? -1,
      right: box?.right ?? -1,
      width: window.innerWidth,
      body: getComputedStyle(document.body).backgroundColor,
    };
  });
  // Centred to within a pixel, and the page around it is painted rather than
  // left as the browser's default white.
  expect(
    Math.abs(wide.left - (wide.width - wide.right)),
    "the frame is not centred in a window far wider than it",
  ).toBeLessThanOrEqual(1);
  expect(wide.left, "the frame is still in the corner").toBeGreaterThan(100);
  expect(
    wide.body,
    "the page around the frame is the browser's default, not the wallet's surface",
  ).not.toBe("rgba(0, 0, 0, 0)");

  // And at the popup's own width nothing moved, which is what keeps every
  // snapshot in the suite valid.
  await page.setViewportSize({ width: 384, height: 600 });
  const narrow = await page.evaluate(() => {
    const frame = document.querySelector("#root > *") as HTMLElement | null;
    return frame?.getBoundingClientRect().left ?? -1;
  });
  expect(narrow, "the popup width picked up the wide-window layout").toBe(0);
});

test("a popup that could not hand off says so on the phrase screen", async ({ wallet }) => {
  test.setTimeout(3 * 60_000);
  const page = wallet.page;

  // A popup whose browser refuses to open a tab. Onboarding still has to work,
  // so the flow runs here, and the phrase screen must go back to warning about
  // the window instead of promising it stays open.
  await page.addInitScript(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.tabs as any).getCurrent = async () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.tabs as any).create = async () => {
      throw new Error("no tabs here");
    };
  });
  await page.reload();

  await page.getByRole("button", { name: "Create a new wallet" }).click();
  await page.getByLabel("Password", { exact: true }).fill("a-strong-test-password");
  await page.getByLabel("Confirm password").fill("a-strong-test-password");
  await page.getByRole("button", { name: "Create wallet" }).click();
  await expect(page.getByText("Save your recovery phrase")).toBeVisible({
    timeout: WAITS.onboarding,
  });

  await expect(
    page.getByText(/this window closes the moment you click anything outside it/i),
    "a window that really does close on blur said nothing about it",
  ).toBeVisible();
  await expect(
    page.getByText(/do not close this tab/i),
    "a popup promised it would stay open",
  ).toHaveCount(0);
});

test("a second click raises the tab that already has the phrase", async ({ wallet }) => {
  test.setTimeout(2 * 60_000);
  const page = wallet.page;

  // The first popup opened tab 4242 and remembered it. This is the next click.
  await page.addInitScript(() => {
    const w = window as unknown as { __raised: number[]; __opened: string[]; __focused: number[] };
    w.__raised = [];
    w.__opened = [];
    w.__focused = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.tabs as any).getCurrent = async () => undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.tabs as any).update = async (id: number) => {
      w.__raised.push(id);
      return { id, windowId: 77 };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.windows as any).update = async (id: number) => {
      w.__focused.push(id);
      return { id };
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (chrome.tabs as any).create = async (info: { url?: string }) => {
      w.__opened.push(info.url ?? "");
      return { id: 9999 };
    };
    window.close = () => {};
    void chrome.storage.session.set({ "pocket:onboarding-tab": 4242 });
  });
  await page.reload();

  await expect
    .poll(
      async () =>
        (await page.evaluate(() => (window as unknown as { __raised: number[] }).__raised)).length,
      { timeout: WAITS.ledgerRead },
    )
    .toBe(1);

  const state = await page.evaluate(() => {
    const w = window as unknown as { __raised: number[]; __opened: string[]; __focused: number[] };
    return { raised: w.__raised, opened: w.__opened, focused: w.__focused };
  });
  expect(state.raised, "the remembered tab is the one raised").toEqual([4242]);
  expect(
    state.opened,
    "a second click opened a duplicate tab, burying a phrase mid-transcription",
  ).toEqual([]);
  expect(state.focused, "raising a tab in a background window looks like nothing").toEqual([77]);
});
