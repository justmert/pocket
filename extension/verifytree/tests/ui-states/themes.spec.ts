// Light and dark, on every screen that can be reached without spending money.
//
// The interesting assertion is not "it renders". It is that the dark scheme is
// a SEPARATE palette rather than an inverted one, which is the difference
// between a design and a filter. Every value here is read off the rendered
// page, so a token changed in `theme.ts` and forgotten in a screen shows up.
import { test, expect } from "../support/fixtures";
import { Wallet, WAITS } from "../support/wallet";
import { measure, computed, AA } from "../support/a11y";

const PASSWORD = "a-strong-test-password";
const FRAME = { width: 384, height: 600 };

/** The two accents the project owner chose. Deliberate, not derived. */
const ACCENT = { light: "rgb(254, 217, 36)", dark: "rgb(184, 173, 232)" };
const SCHEMES = ["light", "dark"] as const;

/** Relative luminance of an `rgb(r, g, b)` string, for the inversion argument. */
function luminance(rgb: string): number {
  const [r = 0, g = 0, b = 0] = (rgb.match(/\d+/g) ?? []).map(Number);
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

test.describe("themes", () => {
  for (const scheme of SCHEMES) {
    test(`the ${scheme} scheme uses its own accent, and the splash renders in it`, async ({
      wallet,
    }) => {
      await wallet.page.emulateMedia({ colorScheme: scheme });
      await wallet.reopen();
      await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });

      // The accent is handed to CSS by App.tsx so the focus ring can use it.
      // Reading it back proves the stylesheet and the TypeScript agree.
      const accent = await wallet.page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--pocket-accent").trim(),
      );
      expect(accent.toUpperCase()).toBe(scheme === "light" ? "#FED924" : "#B8ADE8");

      const primary = wallet.page.getByRole("button", { name: "Create a new wallet" });
      const m = await measure(primary);
      expect(m.background).toBe(ACCENT[scheme]);
      // Both accents carry DARK ink. That is only possible because both are
      // light colours, and it is the crux of the inversion argument below.
      expect(luminance(m.color)).toBeLessThan(0.1);
      expect(m.ratio).toBeGreaterThanOrEqual(AA.text);
    });
  }

  test("dark is a separate palette, not an inversion of light", async ({ wallet }) => {
    const read = async (scheme: (typeof SCHEMES)[number]) => {
      await wallet.page.emulateMedia({ colorScheme: scheme });
      await wallet.reopen();
      await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
      const button = await measure(
        wallet.page.getByRole("button", { name: "Create a new wallet" }),
      );
      const body = await computed(wallet.page.locator("body"), ["background-color"]);
      return { accent: button.background, ink: button.color, body: body["background-color"] ?? "" };
    };

    const light = await read("light");
    const dark = await read("dark");

    // An inverted palette would turn the light accent into its complement.
    const invert = (rgb: string) => {
      const [r = 0, g = 0, b = 0] = (rgb.match(/\d+/g) ?? []).map(Number);
      return `rgb(${255 - r}, ${255 - g}, ${255 - b})`;
    };
    expect(dark.accent).not.toBe(invert(light.accent));

    // And it would have to go DARK: inverting a bright yellow gives a deep
    // blue. Pocket's dark accent stays light enough to carry the same dark ink
    // the light accent does, which no inversion produces. Measured, because
    // "the designer picked a second colour" is not something a test can assert
    // and "the two are far apart in RGB" would pass for a bad second colour.
    expect(luminance(invert(light.accent))).toBeLessThan(0.1);
    expect(luminance(dark.accent)).toBeGreaterThan(0.35);
    expect(luminance(dark.ink)).toBeLessThan(0.1);

    // The surfaces do flip, which is what makes it a dark theme at all.
    expect(luminance(light.body ?? "")).toBeGreaterThan(0.8);
    expect(luminance(dark.body ?? "")).toBeLessThan(0.05);
  });
});

/**
 * Every screen reachable without submitting a transaction, in both schemes.
 *
 * Snapshots are the SUPPLEMENT here, not the evidence. Each case first asserts
 * measured facts about the rendered page; the image is there to catch the
 * things a measurement was not written for. A snapshot alone would be a test
 * whose expected value this suite generated itself.
 */
const SCREENS: {
  name: string;
  open: (w: Wallet) => Promise<void>;
  /**
   * Regions whose content is legitimately different on every run.
   *
   * Masking is the honest fix for non-determinism; widening the pixel
   * threshold until it stops complaining is not, because the slack then
   * applies to the whole image and hides real changes everywhere else. Only
   * the backup screen needs it, and only because a fresh 24-word phrase is
   * different every time by design.
   */
  mask?: (w: Wallet) => ReturnType<Wallet["backupWordCells"]>[];
}[] = [
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
    },
    mask: (w) => [w.backupWordCells()],
  },
  {
    name: "home",
    open: async (w) => {
      await w.createWallet(PASSWORD);
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
      await w.openRecover();
    },
  },
  {
    name: "send-compose",
    open: async (w) => {
      await w.createWallet(PASSWORD);
      await w.openSend();
    },
  },
];

for (const screen of SCREENS) {
  for (const scheme of SCHEMES) {
    test(`${screen.name} renders in ${scheme}`, async ({ wallet }) => {
      test.setTimeout(3 * 60_000);
      await wallet.page.setViewportSize(FRAME);
      await wallet.page.emulateMedia({ colorScheme: scheme });
      await wallet.reopen();
      await expect(wallet.splash()).toBeVisible({ timeout: WAITS.onboarding });
      await screen.open(wallet);

      // Wait for the screen to SETTLE before photographing it.
      //
      // The first baseline taken here caught the home screen mid-read, showing
      // "Reading the ledger…" instead of a balance. It would have passed
      // forever or flaked at random, and either way it would have locked in a
      // transient as the reference image. No spinner on screen is a real
      // condition, not a delay.
      await expect(wallet.page.locator(".pocket-spinner")).toHaveCount(0, {
        timeout: WAITS.ledgerRead,
      });

      // Measured first: the surface belongs to this scheme, and every piece of
      // body text on it is readable against what is actually behind it.
      const body = await computed(wallet.page.locator("body"), ["background-color"]);
      const lum = luminance(body["background-color"] ?? "");
      if (scheme === "light") expect(lum).toBeGreaterThan(0.8);
      else expect(lum).toBeLessThan(0.05);

      // Then the image, for everything nobody wrote an assertion for.
      await expect(wallet.page).toHaveScreenshot(`${screen.name}-${scheme}.png`, {
        // The spinner is the only moving thing, and it is deliberately still
        // animating under reduced motion, so it is masked rather than waited on.
        mask: [wallet.page.locator(".pocket-spinner"), ...(screen.mask?.(wallet) ?? [])],
        animations: "disabled",
      });
    });
  }
}
