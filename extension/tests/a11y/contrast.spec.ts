// Contrast, measured on every visible text node of every reachable screen, in
// both palettes.
//
// A sweep rather than a list of hand-picked selectors. The pairs somebody
// thinks to check are the pairs the designer already looked at; the ones that
// fail are the tint-behind-a-tint combinations nobody drew on purpose --
// `exposed` amber on its own 11% wash, `faint` grey on a field, a caption on
// the canvas gradient.
//
// Every colour is composited from the root down before the ratio is taken,
// because this palette is full of translucent layers and reading
// `backgroundColor` off the element alone gives `rgba(0,0,0,0)` and a
// meaningless number.
//
// WHICH PALETTE IS WHICH CHANGED. There is no `prefers-color-scheme` following
// any more: the POCKET is the theme. Public is light on `#FED924`, private is
// dark on `#B8ADE8`, and both carry the same near-black `#14151A` ink, which is
// why one ink token works on two accents. `emulateMedia({colorScheme})` now
// changes nothing at all, so a screen is opened in the pocket whose palette is
// under test rather than emulated into it.
import { test, expect } from "../support/fixtures";
import { Wallet, WAITS } from "../support/wallet";
import * as ledger from "../support/testnet";
import { measure, AA } from "../support/a11y";
import { contrastFailures } from "./paint";
import { offline, RPC_HOST } from "../support/stub";
import { stubReadyPrivatePocket } from "../support/private-pocket";

const PASSWORD = "a-strong-test-password";

/** The two accents the project owner chose, and the one ink both carry. */
const ACCENT = { public: "#FED924", private: "#B8ADE8" } as const;
const INK = "rgb(20, 21, 26)";
/** `theme.ts`'s `bg` for each pocket: what the frame settles on after a flip. */
const SURFACE = { public: "rgb(250, 250, 247)", private: "rgb(11, 10, 20)" } as const;
const POCKETS = ["public", "private"] as const;
type PocketName = (typeof POCKETS)[number];

const report = (violations: Awaited<ReturnType<typeof contrastFailures>>) =>
  violations
    .map(
      (v) =>
        `"${v.text}" ${v.ratio}:1 (needs ${v.required}) ` +
        `${v.color} on ${v.background} @ ${v.fontSizePx}px/${v.fontWeight}`,
    )
    .join("\n  ");

/**
 * The recovery screen, opened without the page object.
 *
 * `Wallet.openRecover` waits for a heading named "Erase and restore" and there
 * is no heading on that screen: `Header` renders its title as a styled `div`.
 * That is a real finding, reported separately, and it is in `tests/support/`,
 * which this pass does not own -- so the screen is opened here by the sentence
 * it actually shows and the heading is asserted where it belongs, in
 * `semantics.spec.ts`.
 */
async function openRecover(w: Wallet): Promise<void> {
  await w.page.getByRole("button", { name: "Forgot your password?" }).click();
  await expect(w.page.getByText("This erases the wallet on this device.")).toBeVisible();
}

/**
 * Screens with no pocket, and therefore only one palette.
 *
 * Onboarding, unlock and recover all run before or outside a pocket choice, and
 * `lock()` resets the pocket to public, so these render in the light palette and
 * there is no dark variant of them to test. Asserting one would be asserting
 * against a state the wallet cannot be in.
 */
const POCKETLESS: { name: string; open: (w: Wallet) => Promise<void> }[] = [
  { name: "onboarding", open: async () => {} },
  {
    name: "create-form",
    open: async (w) => {
      await w.page.getByRole("button", { name: "Create a new wallet" }).click();
      // Both notices on screen at once: the short-password rule and the
      // mismatch rule, which are the two `invalid` hints.
      await w.page.getByLabel("Password", { exact: true }).fill("short");
      await w.page.getByLabel("Confirm password").fill("different");
      await expect(w.page.getByText("Use at least eight characters.")).toBeVisible();
    },
  },
  {
    name: "backup",
    open: async (w) => {
      await w.page.getByRole("button", { name: "Create a new wallet" }).click();
      await w.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
      await w.page.getByLabel("Confirm password").fill(PASSWORD);
      await w.page.getByRole("button", { name: "Create wallet" }).click();
      await expect(w.page.getByText("Write this down")).toBeVisible({ timeout: WAITS.onboarding });
    },
  },
  {
    name: "unlock",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.lock();
    },
  },
  {
    name: "recover-warning",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.lock();
      await openRecover(w);
    },
  },
  {
    name: "recover-form",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.lock();
      await openRecover(w);
      await w.page.getByRole("button", { name: "I understand, continue" }).click();
      await w.page.getByLabel(/Recovery phrase/).fill("one two three");
      await expect(w.page.getByText(/A recovery phrase is 12 or 24 words/)).toBeVisible();
    },
  },
];

/**
 * Screens that exist inside a pocket, and so have to hold up in both palettes.
 *
 * `open` is handed the pocket it is being opened in, because reaching the same
 * surface differs: the centre control is `Send` in the public pocket and `Send
 * privately` in the private one, and the private pocket's home is a different
 * body entirely.
 */
const POCKETED: {
  name: string;
  /** the private half of this screen only exists once the pocket is open. */
  needsOpenPrivatePocket?: boolean;
  open: (w: Wallet, pocket: PocketName) => Promise<void>;
}[] = [
  { name: "home", open: async () => {} },
  {
    name: "home-funded",
    open: async (w, pocket) => {
      await ledger.fund(await w.revealAddress());
      // Reopening is a reload, and the pocket is popup state rather than
      // storage, so it resets to public and has to be chosen again.
      await w.reopen();
      await w.waitForHome(WAITS.ledgerRead);
      if (pocket === "private") await w.openPrivatePocket();
      await settled(w, pocket);
    },
  },
  {
    name: "settings",
    open: async (w) => {
      await w.nav("Settings").click();
      await expect(w.page.getByRole("heading", { name: "Settings" })).toBeVisible();
    },
  },
  {
    name: "receive-sheet",
    open: async (w) => {
      await w.nav("Receive").click();
      await expect(w.page.getByRole("dialog", { name: "Receive" })).toBeVisible();
    },
  },
  {
    name: "send-refusal",
    // a refusal from the compose form needs a compose form, and the private one
    // exists only for an open pocket. before D-002 this was reachable without.
    needsOpenPrivatePocket: true,
    open: async (w, pocket) => {
      await w.nav(pocket === "private" ? "Send privately" : "Send").click();
      await w.composePayment({ to: "not-an-address", amount: "1" });
      // Waited on by ROLE, not by wording. What this case is for is the danger
      // tint over the sheet's fill; which sentence the worker chose is asserted
      // in `ui-states/async-states.spec.ts`, and the private path can refuse
      // for its own reasons before it ever looks at the address.
      await expect(w.page.getByRole("alert").first()).toBeVisible({ timeout: WAITS.ledgerRead });
    },
  },
  {
    name: "move-sheet",
    open: async (w) => {
      await w.openMove();
    },
  },
];

/**
 * Wait for the pocket crossfade to finish before reading any colour.
 *
 * Switching pockets is the one deliberately slow moment in the product: the
 * frame crossfades its background over 450ms while the accent washes across it
 * for 620ms. Sweeping during that window reads the NEW ink on the OLD surface
 * and reports every string on screen as a failure -- the first run of this file
 * produced 16 "violations" on Settings alone, all of them the light surface
 * caught two thirds of the way to dark. The measurement was wrong, not the
 * palette.
 */
async function settled(w: Wallet, pocket: PocketName): Promise<void> {
  await expect
    .poll(
      () =>
        w.page.evaluate(() => {
          const frame = document.querySelector("#root > div");
          return frame ? getComputedStyle(frame).backgroundColor : "";
        }),
      { timeout: 10_000 },
    )
    .toBe(SURFACE[pocket]);
}

/** Put the wallet in a pocket, from a freshly created wallet on home. */
async function enter(w: Wallet, pocket: PocketName): Promise<void> {
  await w.waitForHome(WAITS.ledgerRead);
  if (pocket === "private") {
    await w.openPrivatePocket();
    // The private body only settles once the pocket state has been read; before
    // that the hero is a shimmer and half the tints under test are not drawn.
    await expect(w.page.getByRole("button", { name: "Private pocket" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  }
  await settled(w, pocket);
}

for (const screen of POCKETLESS) {
  test(`${screen.name} meets AA contrast`, async ({ wallet }) => {
    test.setTimeout(4 * 60_000);
    await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
    await screen.open(wallet);

    const violations = await contrastFailures(wallet.page);
    expect(
      violations,
      `contrast failures on ${screen.name}:\n  ${report(violations)}`,
    ).toEqual([]);
  });
}

for (const screen of POCKETED) {
  for (const pocket of POCKETS) {
    test(`${screen.name} meets AA contrast in the ${pocket} pocket`, async ({ wallet }) => {
      test.setTimeout(4 * 60_000);
      const needsPocket =
        pocket === "private" && "needsOpenPrivatePocket" in screen && screen.needsOpenPrivatePocket;
      if (needsPocket) await stubReadyPrivatePocket(wallet.page);
      await wallet.createWallet(PASSWORD);
      if (needsPocket) await wallet.page.reload();
      await enter(wallet, pocket);
      await screen.open(wallet, pocket);

      const violations = await contrastFailures(wallet.page);
      expect(
        violations,
        `contrast failures on ${screen.name} in the ${pocket} pocket:\n  ${report(violations)}`,
      ).toEqual([]);
    });
  }
}

test("the sweep can fail, and it reads gradients", async ({ wallet }) => {
  // Twenty screens came back clean the first time this ran with gradients
  // composited, which is exactly the shape of an assertion that has quietly
  // stopped looking. So the checker is shown working before its silence is
  // believed: three planted pairs, one that must be reported and two that must
  // not, including the case the sweep in `support/a11y.ts` gets wrong.
  await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
  await wallet.page.evaluate(() => {
    const add = (id: string, style: string, text: string) => {
      const el = document.createElement("div");
      el.id = id;
      el.setAttribute("style", `${style};font-size:14px;padding:4px`);
      el.textContent = text;
      document.body.appendChild(el);
    };
    // Grey on white. Unreadable, and nothing about it is subtle.
    add("probe-bad", "color:#BBBBBB;background:#FFFFFF", "planted unreadable text");
    // Near-black on the public fill. Readable, and only measurable if the
    // gradient is composited: `background-color` here is transparent.
    add(
      "probe-gradient-ok",
      "color:#14151A;background:linear-gradient(180deg,#FFE45C,#F5C400)",
      "planted readable text on a gradient",
    );
    // Near-black on a dark gradient. Unreadable, and invisible to a checker
    // that only reads `background-color`, which would see the white body
    // behind it and call it fine.
    add(
      "probe-gradient-bad",
      "color:#14151A;background:linear-gradient(180deg,#1B1733,#0B0A14)",
      "planted unreadable text on a gradient",
    );
  });

  const found = await contrastFailures(wallet.page);
  const texts = found.map((v) => v.text);
  expect(texts, "the sweep did not report obviously unreadable text").toContain(
    "planted unreadable text",
  );
  expect(texts, "the sweep looked through a gradient and saw the page behind it").toContain(
    "planted unreadable text on a gradient",
  );
  expect(texts, "the sweep failed readable ink on a light gradient").not.toContain(
    "planted readable text on a gradient",
  );

  await wallet.page.evaluate(() => {
    for (const id of ["probe-bad", "probe-gradient-ok", "probe-gradient-bad"]) {
      document.getElementById(id)?.remove();
    }
  });
  expect((await contrastFailures(wallet.page)).map((v) => v.text)).not.toContain(
    "planted unreadable text",
  );
});

test("the accent carries its ink at AA in both pockets", async ({ wallet }) => {
  test.setTimeout(4 * 60_000);
  // The pair the sweep is least able to judge, and the one the whole palette
  // turns on: near-black ink on the accent. Both accents are light enough to
  // take the same dark ink, which is what lets one `onAccent` token serve a
  // yellow pocket and a lilac one.
  //
  // Measured against the accent as a FLAT colour, not the button's gradient
  // fill: the fill runs from a lighter stop to a darker one, and the flat token
  // sits between them, so this is the pair the design actually promises.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);

  for (const pocket of POCKETS) {
    if (pocket === "private") await wallet.openPrivatePocket();
    await settled(wallet, pocket);
    const accent = await wallet.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--pocket-accent").trim(),
    );
    expect(accent.toUpperCase(), `the ${pocket} pocket is not wearing its accent`).toBe(
      ACCENT[pocket],
    );

    const ratio = await wallet.page.evaluate((hex: string) => {
      const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
      const lum = (c: number[]) => {
        const f = (v: number) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
        };
        return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
      };
      const a = lum(rgb(hex));
      const ink = lum([20, 21, 26]);
      return (Math.max(a, ink) + 0.05) / (Math.min(a, ink) + 0.05);
    }, ACCENT[pocket]);
    expect(ratio, `${INK} on ${ACCENT[pocket]} in the ${pocket} pocket`).toBeGreaterThanOrEqual(
      AA.text,
    );
  }
});

test("the danger tint is readable in both pockets", async ({ harness, wallet }) => {
  test.setTimeout(4 * 60_000);
  // The danger tint is the one a user reads while deciding whether their money
  // is safe, and it is a wash over a surface, so it is exactly the kind of pair
  // a spot check misses. Both pockets get their own danger colour, so both are
  // measured on the surface they are actually drawn on.
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome(WAITS.ledgerRead);
  await offline(harness.context, RPC_HOST);
  await wallet.reopen();
  await wallet.waitForHome(WAITS.ledgerRead);

  for (const pocket of POCKETS) {
    if (pocket === "private") await wallet.openPrivatePocket();
    await settled(wallet, pocket);
    const alert = wallet.page.getByRole("alert").first();
    await expect(alert).toBeVisible({ timeout: WAITS.ledgerRead });
    const m = await measure(alert);
    expect(
      m.ratio,
      `the ${pocket} pocket's failure notice: ${m.color} on ${m.background}`,
    ).toBeGreaterThanOrEqual(AA.text);

    const violations = await contrastFailures(wallet.page);
    expect(
      violations,
      `failure-state contrast in the ${pocket} pocket:\n  ${report(violations)}`,
    ).toEqual([]);
  }
  expect(AA.text).toBe(4.5);
});
