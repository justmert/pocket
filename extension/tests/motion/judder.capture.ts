// diagnostic: does the background actually MOVE while a sheet opens?
//
// "jigger" is a claim about geometry, so it is measured as geometry: sample the
// bounding rect of elements that are BEHIND the sheet, at every animation frame
// while the sheet comes up. a background that is merely blurred keeps its rect;
// a background that jigs does not.
//
// not part of any gate. run with:
//   npx playwright test -c playwright.motion.config.ts tests/motion/judder.capture.ts
import { test } from "../support/fixtures";
import { WAITS } from "../support/wallet";

const PASSWORD = "a-strong-test-password";

type Sample = { t: number; rects: Record<string, [number, number, number, number]> };

test("what moves while a sheet opens", async ({ wallet }) => {
  test.setTimeout(WAITS.onboarding + 120_000);
  const page = wallet.page;
  // the real frame. above 800px the stylesheet centres a 384px frame instead,
  // which is the TAB layout and not what a user sees from the toolbar.
  await page.setViewportSize({ width: 384, height: 600 });
  await wallet.createWallet(PASSWORD);
  await wallet.waitForHome();

  // watch the title and the frame itself. both sit behind the sheet, so neither
  // should move by a pixel while it comes up.
  await page.evaluate(async () => {
    // resolve ONCE, before the sheet exists, and keep the nodes. re-running
    // querySelector each frame silently retargets: the sheet header is also an
    // h1, so "the title moved 482px" was really two different elements.
    const title = document.querySelector("h1");
    const frame = document.querySelector("main") ?? document.body.firstElementChild;
    const nav = document.querySelector("nav");
    const watched = { title, frame, nav };

    const pick = (): Record<string, [number, number, number, number]> => {
      const out: Record<string, [number, number, number, number]> = {};
      for (const [k, el] of Object.entries(watched)) {
        if (!el || !el.isConnected) continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        out[k] = [
          Math.round(r.x * 100) / 100,
          Math.round(r.y * 100) / 100,
          Math.round(r.width * 100) / 100,
          Math.round(r.height * 100) / 100,
        ];
      }
      return out;
    };

    const collected: {
      t: number;
      rects: Record<string, [number, number, number, number]>;
      sheetTop: number | null;
    }[] = [];
    const t0 = performance.now();
    let stop = false;
    const loop = () => {
      const sheet = document.querySelector<HTMLElement>('[role="dialog"]');
      collected.push({
        t: Math.round((performance.now() - t0) * 100) / 100,
        rects: pick(),
        sheetTop: sheet ? Math.round(sheet.getBoundingClientRect().top * 100) / 100 : null,
      });
      if (!stop) requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
    (window as unknown as { __stop: () => void }).__stop = () => {
      stop = true;
    };
    (window as unknown as { __samples: typeof collected }).__samples = collected;
  });

  // click through Playwright, so the control is found the way a spec finds it
  // rather than by guessing at the DOM.
  await page.getByRole("button", { name: "Receive", exact: true }).click();
  await page.waitForTimeout(700);
  const samples = await page.evaluate(() => {
    (window as unknown as { __stop: () => void }).__stop();
    return (
      window as unknown as {
        __samples: {
          t: number;
          rects: Record<string, [number, number, number, number]>;
          sheetTop: number | null;
        }[];
      }
    ).__samples;
  });

  const first = (samples as Sample[])[0]!;
  const keys = Object.keys(first.rects);
  // eslint-disable-next-line no-console
  console.log(`\nframes captured: ${samples.length}\n`);
  const AXIS = ["x", "y", "w", "h"];
  for (const k of keys) {
    const base = first.rects[k]!;
    let maxDelta = 0;
    let at = 0;
    let worst = base;
    let axis = 0;
    for (const s of samples as Sample[]) {
      const r = s.rects[k];
      if (!r) continue;
      for (let i = 0; i < 4; i++) {
        const d = Math.abs(r[i]! - base[i]!);
        if (d > maxDelta) {
          maxDelta = d;
          at = s.t;
          worst = r;
          axis = i;
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log(
      `${k.padEnd(6)} [${base.join(", ")}] -> [${worst.join(", ")}]` +
        `   ${AXIS[axis]} moved ${Math.round(maxDelta * 10) / 10}px at t=${at}ms`,
    );
  }

  // frame pacing while the sheet slides. a smooth 60Hz slide steps ~16.7ms and
  // moves a little each frame; a stutter shows up as a long gap or as several
  // frames where the sheet did not move at all.
  const present = (samples as (Sample & { sheetTop: number | null })[]).filter(
    (s) => s.sheetTop !== null,
  );
  // only the window where the sheet is actually travelling. sampling past the
  // end counts every settled frame as a "frozen" one, which said the animation
  // stuttered when it had simply finished.
  const lastMoving = present.findLastIndex(
    (s, i) => i > 0 && s.sheetTop !== present[i - 1]!.sheetTop,
  );
  const slide = lastMoving > 0 ? present.slice(0, lastMoving + 1) : present;
  if (slide.length > 1) {
    const gaps: number[] = [];
    let frozen = 0;
    for (let i = 1; i < slide.length; i++) {
      gaps.push(Math.round((slide[i]!.t - slide[i - 1]!.t) * 10) / 10);
      if (slide[i]!.sheetTop === slide[i - 1]!.sheetTop) frozen++;
    }
    const sorted = [...gaps].sort((a, b) => a - b);
    // eslint-disable-next-line no-console
    console.log(
      `\nsheet slide: ${slide.length} frames, top ${slide[0]!.sheetTop} -> ${slide[slide.length - 1]!.sheetTop}\n` +
        `  frame gaps  median ${sorted[Math.floor(sorted.length / 2)]}ms  worst ${sorted[sorted.length - 1]}ms\n` +
        `  long frames (>25ms): ${gaps.filter((g) => g > 25).length}\n` +
        `  frames where the sheet did not move: ${frozen}/${gaps.length}`,
    );
  }
});
