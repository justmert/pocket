// The two palettes, on every screen that can be reached without spending money.
//
// THE POCKET IS THE THEME. There is no `prefers-color-scheme` following any
// more: choosing the public pocket makes the whole surface light with a yellow
// accent, choosing the private one makes it dark with a lilac accent, and the
// colour is therefore never decoration -- it always says which pocket you are
// looking at. `emulateMedia({colorScheme})` now changes nothing, and a test
// that still used it would be rendering the same screen twice and calling one
// of them dark.
//
// The interesting assertion is not "it renders". It is that the private palette
// is a SEPARATE design rather than an inverted one, which is the difference
// between a design and a filter. Every value here is read off the rendered
// page, so a token changed in `theme.ts` and forgotten in a screen shows up.
import { test, expect } from "../support/fixtures";
import { Wallet, WAITS } from "../support/wallet";
import { computed, measure, AA } from "../support/a11y";

const PASSWORD = "a-strong-test-password";
const FRAME = { width: 384, height: 600 };

/** The two accents the project owner chose. Deliberate, not derived. */
const ACCENT = { public: "rgb(254, 217, 36)", private: "rgb(184, 173, 232)" } as const;
/** The stops of each pocket's primary fill, which is a gradient, not a colour. */
const FILL = {
  public: ["rgb(255, 228, 92)", "rgb(245, 196, 0)"],
  private: ["rgb(201, 191, 240)", "rgb(164, 147, 221)"],
} as const;
const POCKETS = ["public", "private"] as const;
type PocketName = (typeof POCKETS)[number];

/**
 * One account for every screenshot in this file.
 *
 * Generated once from fixed entropy and checked into the spec, because the home
 * screen now draws an address-derived avatar and a shortened address, and the
 * receive sheet draws a QR of the whole thing. A fresh wallet per test would
 * make three regions of every image different on every run, and the honest
 * choices are a fixed account or three masks. A fixed account is better: a mask
 * over a 238px QR is most of the receive sheet, and a snapshot of the parts
 * nobody looks at is not a snapshot.
 *
 * Deliberately never funded, by this file or any other.
 */
const PHRASE =
  "arctic live gadget display excess mandate sniff autumn people disorder affair hole " +
  "retreat fancy close tip deer village tuition orbit cannon owner maid spare";

test.describe("palettes", () => {
  for (const pocket of POCKETS) {
    test(`the ${pocket} pocket wears its own accent and its own surface`, async ({ wallet }) => {
      test.setTimeout(4 * 60_000);
      await wallet.importPhrase(PHRASE, PASSWORD);
      await wallet.waitForHome(WAITS.ledgerRead);
      if (pocket === "private") await wallet.openPrivatePocket();

      // The accent is handed to CSS by `WalletProvider` so the focus ring can
      // use it. Reading it back proves the stylesheet and the TypeScript agree.
      const accent = await wallet.page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--pocket-accent").trim(),
      );
      expect(accent.toUpperCase()).toBe(pocket === "public" ? "#FED924" : "#B8ADE8");

      // And the surface flips with it, which is what makes the private pocket a
      // dark theme rather than a yellow one wearing lilac.
      const body = await computed(wallet.page.locator("body"), ["background-color"]);
      const lum = luminance(body["background-color"] ?? "");
      if (pocket === "public") expect(lum).toBeGreaterThan(0.8);
      else expect(lum).toBeLessThan(0.05);

      // The centre control is the one primary fill on the home screen.
      const primary = wallet.nav(pocket === "private" ? "Send privately" : "Send");
      const fill = await computed(primary, ["background-image", "color"]);
      for (const stop of FILL[pocket]) expect(fill["background-image"]).toContain(stop);
      // Both accents carry DARK ink. That is only possible because both are
      // light colours, and it is the crux of the inversion argument below.
      expect(luminance(fill.color ?? "")).toBeLessThan(0.1);
    });
  }

  test("the operating system's colour scheme does not decide the palette", async ({ wallet }) => {
    // The regression guard for the whole design. Before the rebuild the wallet
    // followed `prefers-color-scheme`, so a user in the public pocket on a dark
    // machine got the dark surface with the yellow accent -- a combination that
    // says nothing about which pocket is open, which is the one job the colour
    // has.
    await wallet.page.emulateMedia({ colorScheme: "dark" });
    await wallet.importPhrase(PHRASE, PASSWORD);
    await wallet.waitForHome(WAITS.ledgerRead);

    const accent = await wallet.page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--pocket-accent").trim(),
    );
    expect(accent.toUpperCase(), "the OS preference changed the accent").toBe("#FED924");
    const body = await computed(wallet.page.locator("body"), ["background-color"]);
    expect(
      luminance(body["background-color"] ?? ""),
      "the public pocket went dark because the machine is dark",
    ).toBeGreaterThan(0.8);
  });

  test("the private palette is a separate design, not an inversion of the public one", async ({
    wallet,
  }) => {
    test.setTimeout(4 * 60_000);
    await wallet.importPhrase(PHRASE, PASSWORD);
    await wallet.waitForHome(WAITS.ledgerRead);

    const read = async (pocket: PocketName) => {
      // The tab's ink is composited through the frame, so the crossfade has to
      // be over before it means anything.
      await settle(wallet, pocket);
      const bar = wallet.page.getByRole("navigation", { name: "Wallet" });
      const accent = await wallet.page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--pocket-accent").trim(),
      );
      const body = await computed(wallet.page.locator("body"), ["background-color"]);
      // The SELECTED tab, which is the one wearing `t.text`. The other wears
      // `t.faint` in both palettes and would say nothing about the flip.
      const tab = await measure(
        wallet.page.locator('button[aria-pressed="true"]').filter({ hasText: /pocket$/ }),
      );
      return {
        accent: hexToRgb(accent),
        body: body["background-color"] ?? "",
        ink: tab.color,
        barCount: await bar.count(),
      };
    };

    const light = await read("public");
    await wallet.openPrivatePocket();
    const dark = await read("private");

    // An inverted palette would turn the light accent into its complement.
    const invert = (rgb: string) => {
      const [r = 0, g = 0, b = 0] = (rgb.match(/\d+/g) ?? []).map(Number);
      return `rgb(${255 - r}, ${255 - g}, ${255 - b})`;
    };
    expect(dark.accent).not.toBe(invert(light.accent));

    // And it would have to go DARK: inverting a bright yellow gives a deep
    // blue. Pocket's private accent stays light enough to carry the same dark
    // ink the public accent does, which no inversion produces. Measured,
    // because "the designer picked a second colour" is not something a test can
    // assert and "the two are far apart in RGB" would pass for a bad second one.
    expect(luminance(invert(light.accent))).toBeLessThan(0.1);
    expect(luminance(dark.accent)).toBeGreaterThan(0.35);

    // The surfaces do flip, which is what makes it a dark theme at all.
    expect(luminance(light.body)).toBeGreaterThan(0.8);
    expect(luminance(dark.body)).toBeLessThan(0.05);
    // And the ink flips with them, rather than staying put and going unreadable.
    expect(luminance(light.ink)).toBeLessThan(0.1);
    expect(luminance(dark.ink)).toBeGreaterThan(0.5);
  });

  for (const pocket of POCKETS) {
    test(`the ${pocket} pocket's primary fill carries its label at AA`, async ({ wallet }) => {
      test.setTimeout(4 * 60_000);
      await wallet.importPhrase(PHRASE, PASSWORD);
      await wallet.waitForHome(WAITS.ledgerRead);
      if (pocket === "private") await wallet.openPrivatePocket();

      // `measure` composites `background-color`, and a gradient has none, so
      // the ratio is taken against the fill's own stops here. The DARKER stop
      // is the one that decides: if the label clears that it clears the whole
      // sweep.
      const primary = wallet.nav(pocket === "private" ? "Send privately" : "Send");
      const ink = (await computed(primary, ["color"])).color ?? "";
      for (const stop of FILL[pocket]) {
        expect(
          contrast(ink, stop),
          `${ink} on the ${pocket} fill stop ${stop}`,
        ).toBeGreaterThanOrEqual(AA.text);
      }
    });
  }
});

/**
 * Every screen reachable without submitting a transaction.
 *
 * Snapshots are the SUPPLEMENT here, not the evidence. Each case first asserts
 * measured facts about the rendered page; the image is there to catch the
 * things a measurement was not written for. A snapshot alone would be a test
 * whose expected value this suite generated itself.
 */
/**
 * The 24 numbered word cells on the backup screen.
 *
 * Not `Wallet.backupWordCells`, whose regex requires whitespace between the
 * ordinal and the word. The rebuild draws them as flex children with a 6px gap,
 * so the space is layout rather than text and the page object's locator matches
 * nothing -- which would silently produce an EMPTY mask and a baseline of a
 * phrase that is different every run.
 */
function wordCells(w: Wallet) {
  return w.page.locator("span").filter({ hasText: /^\d+\.\s*\w+\s*$/ });
}

interface Shot {
  name: string;
  open: (w: Wallet) => Promise<void>;
  /**
   * Regions whose content is legitimately different on every run.
   *
   * Masking is the honest fix for non-determinism; widening the pixel
   * threshold until it stops complaining is not, because the slack then
   * applies to the whole image and hides real changes everywhere else. Only
   * the backup screen needs it, and only because a fresh 24-word phrase is
   * different every time by design. Every other screen is made deterministic
   * at the source instead, by importing one fixed account.
   */
  mask?: (w: Wallet) => ReturnType<Wallet["backupWordCells"]>[];
}

/** Screens with no pocket, and so only one palette to photograph. */
const POCKETLESS: Shot[] = [
  { name: "onboarding-choose", open: async () => {} },
  {
    name: "onboarding-create",
    open: async (w) => {
      await w.page.getByRole("button", { name: "Create a new wallet" }).click();
      await expect(w.page.getByLabel("Confirm password")).toBeVisible();
    },
  },
  {
    name: "onboarding-import",
    open: async (w) => {
      await w.page.getByRole("button", { name: "I have a recovery phrase" }).click();
      await expect(w.page.getByLabel("Recovery phrase")).toBeVisible();
    },
  },
  {
    name: "backup-phrase",
    open: async (w) => {
      await w.page.getByRole("button", { name: "Create a new wallet" }).click();
      await w.page.getByLabel("Password", { exact: true }).fill(PASSWORD);
      await w.page.getByLabel("Confirm password").fill(PASSWORD);
      await w.page.getByRole("button", { name: "Create wallet" }).click();
      await expect(w.page.getByText("Write this down")).toBeVisible({ timeout: WAITS.onboarding });
  await w.page.getByRole("button", { name: "Show the phrase" }).click();
      await expect(wordCells(w)).toHaveCount(24);
    },
    mask: (w) => [wordCells(w)],
  },
  {
    name: "unlock",
    open: async (w) => {
      await w.importPhrase(PHRASE, PASSWORD);
      await w.lock();
    },
  },
  {
    // This screen reads DIFFERENTLY out of a development build. Its third
    // bullet is chosen by `NETWORKS[network].archiveUrl`, which comes from
    // `VITE_ARCHIVE_URL`, which only `.env.development` sets. A production
    // `npm run build` has no archive, so the screen says the private balances
    // cannot be rebuilt -- which is the truth about a shipped build and is what
    // `npm run test:pass` builds, so it is the right thing to hold a baseline
    // against. A baseline regenerated from `wxt dev` output will differ here
    // and that is the build being wrong, not the image.
    name: "recover-warning",
    open: async (w) => {
      await w.importPhrase(PHRASE, PASSWORD);
      await w.lock();
      // Not `Wallet.openRecover`: it waits for a heading this screen does not
      // have. Reported as a finding; the screen itself is what is photographed.
      await w.page.getByRole("button", { name: "Forgot your password?" }).click();
      await expect(w.page.getByText("This erases the wallet on this device.")).toBeVisible();
    },
  },
];

/** Screens that live inside a pocket, photographed in both. */
const POCKETED: { name: string; open: (w: Wallet, pocket: PocketName) => Promise<void> }[] = [
  { name: "home", open: async () => {} },
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
    name: "send-compose",
    open: async (w, pocket) => {
      await w.nav(pocket === "private" ? "Send privately" : "Send").click();
      await expect(w.page.getByLabel("To", { exact: true })).toBeVisible();
    },
  },
];

/** `theme.ts`'s `bg` per pocket: what the frame settles on after a flip. */
const SURFACE = { public: "rgb(250, 250, 247)", private: "rgb(11, 10, 20)" } as const;

/** Nothing is photographed until it has stopped moving. */
async function settle(w: Wallet, pocket: PocketName = "public"): Promise<void> {
  // The first baseline ever taken here caught the home screen mid-read and
  // locked a transient in as the reference image. A shimmer on screen means a
  // value has not arrived; no shimmer and no spinner is a real condition rather
  // than a delay.
  await expect(w.page.locator(".pocket-skeleton")).toHaveCount(0, { timeout: WAITS.ledgerRead });
  await expect(w.page.locator(".pocket-spinner")).toHaveCount(0, { timeout: WAITS.ledgerRead });
  // And the pocket crossfade is 450ms of background under a 620ms wash, which
  // is long enough that a screenshot taken the instant the tab is pressed
  // catches the new ink on the old surface.
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

for (const screen of POCKETLESS) {
  test(`${screen.name} renders`, async ({ wallet }) => {
    test.setTimeout(4 * 60_000);
    await wallet.page.setViewportSize(FRAME);
    await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
    await screen.open(wallet);
    await settle(wallet);

    // Measured first: the surface is the public palette, which is the only one
    // these screens can be in.
    const body = await computed(wallet.page.locator("body"), ["background-color"]);
    expect(luminance(body["background-color"] ?? "")).toBeGreaterThan(0.8);

    // Then the image, for everything nobody wrote an assertion for.
    await expect(wallet.page).toHaveScreenshot(`${screen.name}.png`, {
      mask: screen.mask?.(wallet) ?? [],
      animations: "disabled",
    });
  });
}

for (const screen of POCKETED) {
  for (const pocket of POCKETS) {
    test(`${screen.name} renders in the ${pocket} pocket`, async ({ wallet }) => {
      test.setTimeout(4 * 60_000);
      await wallet.page.setViewportSize(FRAME);
      await wallet.importPhrase(PHRASE, PASSWORD);
      await wallet.waitForHome(WAITS.ledgerRead);
      if (pocket === "private") await wallet.openPrivatePocket();
      await screen.open(wallet, pocket);
      await settle(wallet, pocket);

      const body = await computed(wallet.page.locator("body"), ["background-color"]);
      const lum = luminance(body["background-color"] ?? "");
      if (pocket === "public") expect(lum).toBeGreaterThan(0.8);
      else expect(lum).toBeLessThan(0.05);

      await expect(wallet.page).toHaveScreenshot(`${screen.name}-${pocket}.png`, {
        animations: "disabled",
      });
    });
  }
}

/* ------------------------------------------------------------------ colour -- */

/** Relative luminance of an `rgb(r, g, b)` string, for the inversion argument. */
function luminance(rgb: string): number {
  const [r = 0, g = 0, b = 0] = (rgb.match(/\d+/g) ?? []).map(Number);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** `#FED924` as the `rgb()` string every other reading here is in. */
function hexToRgb(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const n = parseInt(m[1]!, 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
}
