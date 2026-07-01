// What T9 measures with, installed in the popup page before the app runs.
//
// The whole slice hangs on one rule from the orchestrator: assert a BOUND,
// never print a duration and call it evidence. That only works if the numbers
// come from inside the page rather than from the test runner's clock. A
// Playwright round trip is tens of milliseconds of noise on a measurement whose
// interesting range starts around a hundred, and node's clock cannot see the
// frame the browser actually painted.
//
// So everything here runs in the popup:
//   marks     - when a piece of text FIRST reached a painted frame
//   frames    - every rAF timestamp, which is the only honest test of "the
//               popup did not freeze"
//   samples   - what the screen said, every 100ms, so a wait can be asked
//               whether anything on it ever changed
//   shifts    - layout-shift entries, with the text of whatever moved
//   positions - where the named controls are, so "the balance arriving moved
//               the Send button" is measured rather than inferred
//
// Nothing here selects on a class, an id or a test hook. The marks are visible
// TEXT, the tracked controls are named by their LABEL, and shift sources report
// their own text, so a restyle cannot break it and a change to the words is
// supposed to.
import type { Page } from "@playwright/test";

/** A moment the screen first said something, in page time (ms since navigation). */
export interface Marks {
  [name: string]: number;
}

export interface Sample {
  t: number;
  text: string;
}

export interface Shift {
  t: number;
  value: number;
  /** Text of each node that moved, and by how much. */
  sources: { text: string; dy: number; dx: number }[];
}

/** Where a named control was, at a moment. Absent controls are not recorded. */
export interface Position {
  t: number;
  name: string;
  top: number;
}

export interface Probe {
  marks: Marks;
  frames: number[];
  samples: Sample[];
  shifts: Shift[];
  positions: Position[];
  /** Set when the probe itself could not install. Never left to look like zero. */
  installError?: string;
  /** Set when this browser has no layout-shift entry type. */
  noLayoutShiftApi?: boolean;
}

/**
 * The patterns the probe watches for, by name.
 *
 * Source strings rather than RegExp because the whole probe is serialised into
 * the page and a RegExp does not survive the trip.
 */
export const WATCH: Record<string, string> = {
  // The app shell. "Pocket" is the header of every screen and the title of the
  // boot frame, so this is the first moment the popup looks like the wallet
  // rather than a blank rectangle. First meaningful paint.
  shell: "Pocket",
  // The named wait the boot frame shows while the worker answers `status`.
  starting: "Starting…",
  // Interactive, unlocked: Send and Receive are on screen.
  home: "PUBLIC POCKET",
  // Interactive, locked: the password field is on screen. This is what a
  // returning user sees, because an evicted MV3 worker is a lock.
  locked: "Locked\\. Enter your password",
  // The real balance, seven decimals, from the ledger.
  balance: "\\d+\\.\\d{7}\\s*XLM",
  // Onboarding's first screen.
  splash: "A Stellar wallet with two pockets",
};

/** Controls whose position is followed, by the text on them. */
export const TRACK = ["Send", "Receive", "Unlock"];

/**
 * Install the probe. Must be called before the navigation being measured.
 *
 * `addInitScript` runs before any page script, so the marks are on the same
 * clock the browser uses for paint timing and start at navigation.
 */
export async function installProbe(
  page: Page,
  watch: Record<string, string> = WATCH,
  trackNames: string[] = TRACK,
): Promise<void> {
  await page.addInitScript(
    ([patterns, tracked]: [Record<string, string>, string[]]) => {
      const state: Probe & { armed: boolean } = {
        marks: {},
        frames: [],
        samples: [],
        shifts: [],
        positions: [],
        armed: false,
      };
      (window as unknown as { __t9: typeof state }).__t9 = state;

      const res: [string, RegExp][] = Object.entries(patterns).map(([k, p]) => [k, new RegExp(p)]);

      // An init script runs before the page's own scripts, and at that moment
      // `document.documentElement` can still be null. Observing it threw, the
      // throw took the rAF loop and the samplers down with it, and every
      // measurement came back a confident zero: no frames, no marks, no shifts.
      // A silently empty measurement is the worst failure mode this slice has,
      // so the Document node is observed instead (it always exists) and
      // anything that still goes wrong is recorded for a test to assert on.
      const failed = (e: unknown) => {
        state.installError = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      };

      // Stamped on the frame AFTER the text appeared, not on the mutation. The
      // mutation is when React wrote the DOM; the user sees nothing until the
      // next frame is painted, and the gap between those two is exactly what a
      // blocked main thread makes large.
      const stampOnNextFrame = (name: string) => {
        if (state.marks[name] !== undefined) return;
        state.marks[name] = -1; // claimed, so a second mutation does not queue a second rAF
        requestAnimationFrame((t) => {
          state.marks[name] = t;
        });
      };

      const scan = () => {
        const text = document.body?.textContent ?? "";
        for (const [name, re] of res) {
          if (state.marks[name] === undefined && re.test(text)) stampOnNextFrame(name);
        }
      };

      // getBoundingClientRect forces layout. On a 360x600 popup with a few
      // dozen nodes that is microseconds, and it is paid identically in every
      // condition being compared, so it cannot bias a comparison.
      const track = () => {
        const t = performance.now();
        for (const el of Array.from(document.querySelectorAll("button"))) {
          const name = (el.textContent ?? "").trim();
          if (!tracked.includes(name)) continue;
          state.positions.push({ t, name, top: Math.round(el.getBoundingClientRect().top) });
        }
        if (state.positions.length > 50_000) state.positions.splice(0, 25_000);
      };

      try {
        new MutationObserver(() => {
          scan();
          track();
        }).observe(document, { subtree: true, childList: true, characterData: true });
        scan();
      } catch (e) {
        failed(e);
      }

      const tick = (t: number) => {
        state.frames.push(t);
        // A popup left open for minutes would otherwise grow this without bound.
        if (state.frames.length > 200_000) state.frames.splice(0, 100_000);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      // innerText, not textContent: it is what a person can READ. textContent
      // would include text in a hidden branch, and "the screen changed" has to
      // mean the visible screen changed.
      setInterval(() => {
        if (!state.armed) return;
        const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
        state.samples.push({ t: performance.now(), text });
        track();
      }, 100);

      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries()) {
            const entry = e as PerformanceEntry & {
              value: number;
              hadRecentInput: boolean;
              sources?: {
                node?: Node;
                previousRect: DOMRectReadOnly;
                currentRect: DOMRectReadOnly;
              }[];
            };
            // A shift the user caused by clicking is not the kind being hunted;
            // this slice is about the screen moving under a still finger.
            if (entry.hadRecentInput) continue;
            state.shifts.push({
              t: entry.startTime,
              value: entry.value,
              sources: (entry.sources ?? []).map((s) => ({
                text: ((s.node as Element | undefined)?.textContent ?? "")
                  .replace(/\s+/g, " ")
                  .trim()
                  .slice(0, 60),
                dy: Math.round(s.currentRect.top - s.previousRect.top),
                dx: Math.round(s.currentRect.left - s.previousRect.left),
              })),
            });
          }
        }).observe({ type: "layout-shift", buffered: true });
      } catch {
        // Reported by the test as "this browser has no layout-shift entries",
        // never silently as "there were no shifts".
        state.noLayoutShiftApi = true;
      }
    },
    [watch, trackNames] as [Record<string, string>, string[]],
  );
}

/**
 * Start recording what the screen says.
 *
 * The page is brought to the front first, and that is not cosmetic: Chrome
 * throttles requestAnimationFrame in a background tab to roughly 1Hz and stops
 * it in a hidden one. A throttled measurement looks exactly like a frozen popup
 * and would be a false HIGH finding.
 */
export async function arm(page: Page): Promise<void> {
  await page.bringToFront();
  await page.evaluate(() => {
    const s = (window as unknown as { __t9: Probe & { armed: boolean } }).__t9;
    s.samples.length = 0;
    s.armed = true;
  });
}

export async function disarm(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { __t9: { armed: boolean } }).__t9.armed = false;
  });
}

export async function read(page: Page): Promise<Probe> {
  // One frame first, and it is load-bearing. A mark is CLAIMED synchronously on
  // the mutation and STAMPED in the rAF that follows, so a test that sees an
  // element with Playwright and reads immediately can catch the claim (-1) and
  // never the time. That produced a red run on a screen that had painted
  // perfectly well. Waiting for a frame lets every pending stamp land.
  const p = await page.evaluate(async () => {
    // Raced against a timer, because a backgrounded page never fires rAF at all
    // and an unbounded wait here would surface as a test timeout with no clue
    // in it. The check below turns that case into a sentence instead.
    await Promise.race([
      new Promise((r) => requestAnimationFrame(() => r(null))),
      new Promise((r) => setTimeout(r, 2000)),
    ]);
    const s = (window as unknown as { __t9?: Probe }).__t9;
    return s ? (JSON.parse(JSON.stringify(s)) as Probe) : null;
  });
  if (!p) throw new Error("the probe did not install: window.__t9 is absent");
  if (p.installError) throw new Error(`the probe failed to install: ${p.installError}`);
  const unstamped = Object.entries(p.marks).filter(([, v]) => v === -1).map(([k]) => k);
  if (unstamped.length) {
    throw new Error(
      `these marks were claimed but never painted: ${unstamped.join(", ")}. ` +
        "The page is probably backgrounded, which stops requestAnimationFrame.",
    );
  }
  return p;
}

/**
 * When a mark was painted, or a refusal.
 *
 * `p.marks.balance` is `number | undefined`, and every caller was reading it as
 * a number. A mark that never landed would arithmetic into NaN, and every
 * comparison against NaN is false, so a budget assertion would PASS on a screen
 * that never rendered. A missing mark is a broken measurement, not a fast one.
 */
export function at(p: Probe, name: string): number {
  const t = p.marks[name];
  if (t === undefined) {
    throw new Error(
      `the mark "${name}" was never painted, so there is nothing to measure. ` +
        `painted: ${Object.keys(p.marks).join(", ") || "none"}`,
    );
  }
  return t;
}

/** Page time, on the same clock as every mark and frame. */
export async function now(page: Page): Promise<number> {
  return page.evaluate(() => performance.now());
}

/**
 * The longest gap between painted frames, in ms.
 *
 * This is the number that says whether the popup froze. Callers must keep the
 * page in the foreground; see `arm`.
 */
export function longestFrameGap(frames: number[]): number {
  let worst = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1];
    const b = frames[i];
    if (a === undefined || b === undefined) continue;
    worst = Math.max(worst, b - a);
  }
  return worst;
}

export function framesBetween(frames: number[], from: number, to: number): number[] {
  return frames.filter((f) => f >= from && f <= to);
}

/** Distinct consecutive screens, in order, from the 100ms samples. */
export function screens(samples: Sample[]): { text: string; from: number; to: number }[] {
  const out: { text: string; from: number; to: number }[] = [];
  for (const s of samples) {
    const last = out[out.length - 1];
    if (last && last.text === s.text) last.to = s.t;
    else out.push({ text: s.text, from: s.t, to: s.t });
  }
  return out;
}

/**
 * The longest stretch in which the screen said exactly the same thing.
 *
 * The spinner is deliberately invisible to this: it rotates, it carries no
 * information, and what is being measured is how long a person watched an
 * unchanging screen. A moving pixel is not feedback.
 */
export function longestStaticMs(samples: Sample[]): number {
  return screens(samples).reduce((worst, s) => Math.max(worst, s.to - s.from), 0);
}

/** How far a tracked control moved between two page times, in pixels. */
export function moved(positions: Position[], name: string, from: number, to: number): number {
  const seen = positions.filter((p) => p.name === name && p.t >= from && p.t <= to);
  if (seen.length === 0) return NaN;
  const tops = seen.map((p) => p.top);
  return Math.max(...tops) - Math.min(...tops);
}

/** Every distinct position a tracked control held in a window. Evidence, not a claim. */
export function trackOf(positions: Position[], name: string, from: number, to: number): number[] {
  const tops = positions.filter((p) => p.name === name && p.t >= from && p.t <= to).map((p) => p.top);
  return [...new Set(tops)];
}
