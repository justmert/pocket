// What "the layout holds at this viewport" actually means, written down once.
//
// A layout assertion is the easiest kind to write so that it can never fail,
// and two of the obvious ways to write one are wrong here:
//
//   `toBeVisible()` is true of a button sitting 200px below the bottom of a
//   popup that cannot scroll. Playwright calls an element visible when it has a
//   non-empty box and is not `display: none`, which says nothing about whether
//   anyone can see it.
//
//   `toBeInViewport({ratio: 1})` is the right idea in the wrong unit. Real
//   layout is fractional, so a 46px button entirely on screen reports 0.9963
//   and the test fails for a 0.17px rounding sliver. Measured here in PIXELS,
//   with a one-pixel tolerance that cannot hide a clipped button because
//   clipping a button costs tens of pixels.
//
// Four properties, deliberately different from each other:
//
//   fits horizontally  the document is no wider than the window, nothing hangs
//                      past its right edge, and no element's own content
//                      outruns the box it was given. Three ways to lose text,
//                      and only the first produces a scrollbar.
//   reachable          after scrolling as far as the popup allows, the whole
//                      control is inside the window and unclipped.
//   user-scrollable    only the scrolls a person could have performed count.
//                      `overflow: hidden` is still scriptable, so a container
//                      the audit's own `scrollIntoView` moved but nobody else
//                      can is PUT BACK before anything is measured, and named
//                      in the failure if the control is off screen without it.
//                      That is the difference between "the browser can reach
//                      it" and "the user can".
//   hittable           the topmost element at the control's own centre is the
//                      control. Reachable but covered is still unusable.
//
// Every one of these has been observed red; which mutation did it, and the
// three that could not be reddened, are recorded in _test/T8.md section 4.
//
// Four things the rebuilt popup added, and why each is a carve-out rather than
// a softening. Each one exists because the check would otherwise say something
// FALSE, and a red test that explains itself wrongly is worse than no test:
//
//   the modal layer     sheets are `aria-modal` dialogs over a backdrop, so the
//                       screen behind one is inert on purpose and the backdrop
//                       is what a press lands on. Sweeping through it would
//                       report the modal WORKING as a covered control.
//   the exact figure    every amount carries a visually hidden span holding the
//                       ungrouped number for a screen reader. It is 1px wide and
//                       clipped away by design, so measuring how far its text
//                       runs past that 1px says nothing about anyone's screen.
//                       Only the exact `inset(50%)` idiom is exempt, and the
//                       rendering beside it is measured as normal.
//   decoration          an element that is transparent AND inert AND
//                       `aria-hidden` is not content, and content is the only
//                       thing the horizontal checks are about. All three
//                       together, so the fade over the bar and the dark
//                       pocket's glow are still measured.
//   settling            sheets slide, pages scale in, and the frame's ceiling is
//                       measured from a resize handler rather than resolved in
//                       CSS, so a measurement taken too early is taken somewhere
//                       the layout will not be a frame later.
import { expect, type Locator, type Page } from "@playwright/test";

/**
 * Chrome's ceiling for a toolbar popup, in device-independent pixels.
 * Anything the wallet lays out below this line is not awkward, it is gone.
 */
export const POPUP_CAP = { width: 800, height: 600 } as const;

/** The wallet's own declared frame, from `ui/theme.ts`. */
export const FRAME = { width: 384, height: 600 } as const;

/**
 * The viewport the brief names, and the one every screen is checked at.
 *
 * 360 is narrower than the frame's declared 384 on purpose: it is what the
 * popup gets when the frame has to give ground, and a 24px shortfall is the
 * cheapest way to find out whether the width is fluid or fixed.
 */
export const SMALL = { width: 360, height: 600 } as const;

/**
 * 200% browser zoom, expressed as what the page actually sees.
 *
 * Chrome caps the popup in device-independent pixels, so zoom does not buy the
 * page more room: it halves the CSS pixels that fit inside the same cap. 384
 * CSS px still renders under the 800px width cap at 2x (768 device px), so the
 * width survives and the HEIGHT is what halves.
 */
export const ZOOM_200 = { width: FRAME.width, height: POPUP_CAP.height / 2 } as const;

/**
 * The three every screen is held to. Any red here is a defect at a viewport the
 * product is required to work at: its own declared frame, the brief's floor,
 * and the accessibility requirement.
 */
export const REQUIRED_VIEWPORTS = [
  { name: "384x600 the wallet's own frame", ...FRAME },
  { name: "360x600 the brief's floor", ...SMALL },
  { name: "384x300 what 200% zoom leaves", ...ZOOM_200 },
] as const;

/**
 * Narrower than the frame's own width, which is where it stops being fluid.
 *
 * These are not arbitrary. The frame is `width: 384` inside `#root {display:
 * flex}` with the default `flex-shrink: 1`, so it gives ground rather than
 * holding its width, and how much ground it can give is a real property with a
 * real floor. Each number is derived: at browser zoom Z the popup asks for
 * 384*Z device-independent pixels and Chrome caps it at 800, so the page is
 * left with min(384, 800/Z) CSS pixels of width.
 */
export const NARROW_VIEWPORTS = [
  { name: "320x600 (800px cap at 250% zoom)", width: 320, height: 600 },
  { name: "266x600 (800px cap at 300% zoom)", width: 266, height: 600 },
  { name: "200x600 (800px cap at 400% zoom)", width: 200, height: 600 },
  { name: "160x600 (800px cap at 500% zoom, Chrome's maximum)", width: 160, height: 600 },
] as const;

/**
 * Check every viewport and report ALL of them, rather than stopping at the
 * first red.
 *
 * For the tests that ARE findings this is not a convenience. Stopping at the
 * widest broken viewport hides how much worse it gets: the confirm screen loses
 * one character at 320px and seventeen at 200px, and a report that only ever
 * says "320" invites the reading that this is cosmetic. It also means the later,
 * narrower viewports never run at all, so assertions that only bite down there
 * are never exercised and quietly look verified.
 */
export async function forEachViewport(
  page: Page,
  viewports: readonly { name: string; width: number; height: number }[],
  check: (vp: { name: string; width: number; height: number }) => Promise<void>,
): Promise<void> {
  const failures: string[] = [];
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    try {
      await check(vp);
    } catch (e) {
      failures.push(e instanceof Error ? (e.message.split("\n")[0] ?? e.message) : String(e));
    }
  }
  expect(failures.join("\n"), "layout failures, one per viewport").toBe("");
}

/**
 * Collect the layout failures of a whole flow and report every one of them.
 *
 * `forEachViewport` does this across one matrix; this does it one level up,
 * across the stages of a flow. Same reason, and it matters most when one stage
 * is a known finding: a red stage throws, everything after it never runs, and
 * assertions that only bite later sit unexercised looking verified. In a spec
 * that registers two pockets on chain and shields real money to get where it is
 * going, throwing away the last four stages because the second one is a known
 * defect is throwing away most of what the run paid for.
 *
 * Only the CHECKS go inside `check()`. The navigation between stages stays
 * outside it, so a stage that fails its assertions still leaves the wallet where
 * the next stage expects to find it.
 */
export function collectFailures(where: string): {
  check(fn: () => Promise<void>): Promise<void>;
  report(): void;
} {
  const failures: string[] = [];
  return {
    async check(fn) {
      try {
        await fn();
      } catch (e) {
        failures.push(e instanceof Error ? e.message : String(e));
      }
    },
    report() {
      expect(failures.join("\n\n"), `${where}: every part that did not hold`).toBe("");
    },
  };
}

/** Run one screen's layout contract at every viewport in a matrix. */
export async function atEveryViewport(
  page: Page,
  screen: string,
  viewports: readonly { name: string; width: number; height: number }[],
  settle?: () => Promise<void>,
): Promise<void> {
  for (const vp of viewports) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    if (settle) await settle();
    await expectLayoutHolds(page, `${screen} @ ${vp.name}`);
  }
}

/**
 * Open the erase-and-restore flow from the unlock screen.
 *
 * The one page-object helper this tier had to spell for itself, and it is
 * reported rather than left as a local habit. `Wallet.openRecover()` waits for a
 * `heading` named "Erase and restore", and the rebuilt screen sets its title
 * through `Header`, which renders a styled div carrying no heading role, so the
 * helper never returns. Waited on the acknowledgement button instead: it is the
 * control the warning page exists to gate, so it cannot be present on any other
 * screen.
 */
export async function openRecover(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Forgot your password?" }).click();
  await expect(page.getByRole("button", { name: "I understand, continue" })).toBeVisible();
}

export interface Geometry {
  viewport: { width: number; height: number };
  document: {
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
  };
  /** Every element whose right edge is past the document's client width. */
  spillingRight: { tag: string; text: string; right: number }[];
  /**
   * Every element whose own CONTENT is wider than the box it was given.
   *
   * A separate list from `spillingRight`, and the more dangerous of the two.
   * A block element's bounding box is its container's width no matter how far
   * the text inside runs, so a memo or an effect line too long to wrap has a
   * perfectly well-behaved rectangle and is still cut in half on screen. The
   * frame's `overflow: hidden` swallows the difference and the document never
   * grows, so nothing about the geometry gives it away except this.
   */
  overflowingContent: { tag: string; text: string; scrollWidth: number; clientWidth: number }[];
}

/** Everything a horizontal-overflow assertion needs, read off the live page. */
export async function geometry(page: Page): Promise<Geometry> {
  return page.evaluate(() => {
    const se = document.scrollingElement as HTMLElement;
    const limit = se.clientWidth;
    const spillingRight: Geometry["spillingRight"] = [];
    const overflowingContent: Geometry["overflowingContent"] = [];
    for (const el of Array.from(document.body.querySelectorAll("*")) as HTMLElement[]) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      // An element that is fully transparent, inert AND hidden from assistive
      // technology is not content, and content is the only thing these two
      // lists are about. Nothing can be lost off the edge of a box nobody can
      // see, click or hear. All three conditions together, so the wash a pocket
      // switch leaves behind is exempt while the fade over the bottom bar and
      // the dark pocket's glow, which are both visible, are not.
      const s = getComputedStyle(el);
      if (
        el.getAttribute("aria-hidden") === "true" &&
        s.pointerEvents === "none" &&
        Number(s.opacity) === 0
      ) {
        continue;
      }
      // Round out sub-pixel layout: a 0.4px overhang is a rounding artefact,
      // not a control the user cannot reach.
      if (Math.round(r.right) > limit) {
        spillingRight.push({
          tag: el.tagName,
          text: (el.textContent ?? "").trim().slice(0, 60),
          right: Math.round(r.right),
        });
      }
      // An input scrolls its own value by design and a deliberate scroller is
      // not an overflow, so neither is a finding. Everything else that is wider
      // than its box is losing content off the right-hand side.
      const scrolls = s.overflowX === "auto" || s.overflowX === "scroll";
      const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
      // The screen-reader-only idiom: a 1px box with its content clipped away,
      // which is what every amount uses to carry its exact ungrouped figure.
      // Nothing about it is on screen, so nothing about it can be cut off on
      // one. Matched on the clip itself rather than on a size, so an element
      // that is merely small is still measured. Repeated inside MEASURE_VISIBLE,
      // because each of these runs in the page as its own serialised function.
      const srOnly = s.clipPath.startsWith("inset(50%") || s.clip === "rect(0px, 0px, 0px, 0px)";
      if (!scrolls && !isField && !srOnly && el.scrollWidth > el.clientWidth + 1) {
        // Report it only when what runs over is something a person could have
        // read. `scrollWidth` counts every descendant, decorations included, and
        // this popup mounts one that is deliberately bigger than the frame: the
        // pocket switch leaves a `scale(1.8)` wash behind it. Saying that the
        // frame's CONTENT is "cut off with no way to scroll to it" because of
        // that overlay would be a false sentence, and a red test that explains
        // itself wrongly is worse than no test.
        //
        // Text overflow puts no element past the edge at all, so a box that
        // spills only its own words has an empty list here and is still
        // reported. That is the memo case and the long-heading case, which are
        // the two this check exists for.
        const edge = r.left + el.clientLeft + el.clientWidth;
        const past = (Array.from(el.querySelectorAll("*")) as HTMLElement[]).filter(
          (d) => d.getBoundingClientRect().right > edge + 1,
        );
        const decoration =
          past.length > 0 &&
          past.every((d) => {
            const ds = getComputedStyle(d);
            return (
              d.getAttribute("aria-hidden") === "true" &&
              ds.pointerEvents === "none" &&
              Number(ds.opacity) === 0
            );
          });
        if (!decoration) {
          overflowingContent.push({
            tag: el.tagName,
            text: (el.textContent ?? "").trim().slice(0, 60),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
          });
        }
      }
    }
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      document: {
        scrollWidth: se.scrollWidth,
        clientWidth: se.clientWidth,
        scrollHeight: se.scrollHeight,
        clientHeight: se.clientHeight,
      },
      spillingRight,
      overflowingContent,
    };
  });
}

/**
 * Let the popup's entrance motion finish before anything is measured.
 *
 * Sheets slide up, pages settle in, rows stagger and the pocket switch washes a
 * scaled overlay across the whole frame. Every one of those is a TRANSFORM, and
 * a transformed box counts towards its scroller's overflow, so a frame that is
 * `overflow: hidden` and perfectly full becomes momentarily scrollable while a
 * sheet is still on its way up. Measured mid-slide, the audit duly reports a
 * button in that sheet as "only reached by scrolling a container the user cannot
 * scroll" -- a true statement about a frame 160px into an animation and nothing
 * at all about the layout.
 *
 * Only FINITE animations are waited on. The spinner, the skeleton shimmer and
 * the progress pulse run forever on purpose, and an audit that waited for those
 * would simply hang. Anything still overflowing once the finite ones are done is
 * a real finding and is reported as one.
 */
export async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((a) => Number.isFinite(a.effect?.getTiming().iterations ?? 1))
        // A cancelled animation rejects, and an element that left the page
        // mid-motion is not something to fail a layout audit over.
        .map((a) => a.finished.catch(() => undefined)),
    );

    // And then wait for the layout itself to stop moving.
    //
    // A resize is not the end of the story in this popup. The frame's ceiling
    // is MEASURED from `window.innerHeight` in a resize handler, so it lands one
    // render after the window changes, and in that gap the frame is still its
    // old height, the document is briefly scrollable, and a control measured
    // there is measured somewhere it will not be a frame later. That produced a
    // control reported as reachable and then, one evaluate afterwards, as
    // hitting nothing: the re-render had clamped the scroll out from under it.
    //
    // Two identical frames in a row, on a bounded number of ticks, with a timer
    // racing each one so a page that is not painting can never hang this.
    const tick = () =>
      new Promise<void>((r) => {
        requestAnimationFrame(() => r());
        setTimeout(r, 50);
      });
    const snapshot = () => {
      const se = document.scrollingElement as HTMLElement;
      const frame = document.querySelector("#root > div") as HTMLElement | null;
      const box = frame ? frame.getBoundingClientRect() : null;
      return [
        se.scrollWidth,
        se.scrollHeight,
        se.clientWidth,
        se.clientHeight,
        box ? Math.round(box.width) : 0,
        box ? Math.round(box.height) : 0,
      ].join(",");
    };
    let previous = snapshot();
    for (let i = 0; i < 30; i++) {
      await tick();
      const now = snapshot();
      if (now === previous) return;
      previous = now;
    }
  });
}

/**
 * No horizontal scrolling, nothing hanging off the right edge, and no text cut
 * off inside a box that fits.
 *
 * Three assertions rather than one because they fail for three different
 * reasons, and only the first of them is the one people think of:
 *
 *   a document wider than its window   a sideways scrollbar in a popup
 *   an element past the right edge     clipped by an `overflow: hidden` above
 *   content wider than its own box     clipped with the geometry still tidy
 */
export async function expectNoHorizontalScroll(page: Page, where: string): Promise<void> {
  await settle(page);
  const g = await geometry(page);
  expect(
    g.document.scrollWidth,
    `${where}: the document is ${g.document.scrollWidth}px wide in a ${g.document.clientWidth}px window, so it scrolls sideways`,
  ).toBeLessThanOrEqual(g.document.clientWidth);
  // Both lists are spelled into the MESSAGE as well as compared, because the
  // message is the only part `forEachViewport` keeps: it holds one line per
  // viewport so a finding can say how much worse it gets, and a line reading
  // "content too wide for its box" with the box unnamed is not a report.
  const spilling = g.spillingRight.map((s) => `${s.tag} right=${s.right} "${s.text}"`);
  expect(
    spilling,
    `${where}: content past the right edge of a ${g.document.clientWidth}px window: ${spilling.join(" | ")}`,
  ).toEqual([]);
  const overflowing = g.overflowingContent.map(
    (s) => `${s.tag} needs ${s.scrollWidth}px, has ${s.clientWidth}px "${s.text}"`,
  );
  expect(
    overflowing,
    `${where}: content too wide for the box it was given, so it is cut off with no way to scroll to it: ${overflowing.join(" | ")}`,
  ).toEqual([]);
}

/**
 * How much of a control the user can actually see, in pixels.
 *
 * NOT `toBeVisible`, and not `toBeInViewport({ratio: 1})` either. The ratio
 * form is the right idea and the wrong unit: real layout is fractional, so a
 * 46px button that is entirely on screen reports 0.9963 and a test written
 * against an exact 1 fails for a 0.17px rounding sliver. Measuring the CLIPPED
 * RECT in pixels says the thing that actually matters — how many pixels of this
 * control are missing — and a one-pixel tolerance cannot hide a clipped button,
 * because clipping a button costs tens of pixels.
 *
 * The walk up the ancestors is the load-bearing part. `getBoundingClientRect`
 * happily reports a box for an element sitting outside an `overflow: hidden`
 * frame, which is exactly the shape of this wallet: `Frame` is a fixed 600px
 * box with its overflow hidden, so a control laid out below 600px has a perfect
 * bounding box and is not on screen at all.
 */
const MEASURE_VISIBLE = (el: Element) => {
  // Scroll the way the question is asked: "can the USER get to this".
  //
  // `scrollIntoView` alone cannot answer it, and finding out cost this audit
  // its first honest result. An element with `overflow: hidden` is still
  // scrollable PROGRAMMATICALLY: scrollTop can be set on it, `scrollIntoView`
  // sets it, and the element duly arrives on screen. It has no scrollbar, no
  // wheel response and no drag, so a person sitting in front of it cannot do
  // what the test just did. Mutation S1 turned the wallet's only scrolling
  // column into `overflow: hidden` and fourteen tests stayed green because of
  // exactly this.
  //
  // So: scroll, then PUT BACK every container the user could not have scrolled,
  // and measure where the element sits with only the scrolls a person could
  // have performed still applied.
  //
  // Putting it back rather than failing on the movement itself is the fix for a
  // false positive that arrived with the rebuilt popup. `scrollIntoView` centres
  // its target, so it moves any ancestor with slack whether or not the element
  // needed it, and this frame now has slack it never asked for: the pocket
  // switch leaves a `scale(1.8)` wash mounted, which gives an `overflow: hidden`
  // 600px frame a 994px scroll height. A control sitting perfectly on screen was
  // therefore reported as unreachable because the audit's own scroll shifted the
  // frame under it. Restoring the offset asks the honest question instead: with
  // the frame back where the user's copy of it is, is the control on screen?
  //
  // Nothing is softened. Mutation S1's `overflow: hidden` column still reddens,
  // because a control below the fold is still below the fold once the scroll is
  // undone, and `forced` rides along into the failure message so the report
  // still names the container that stands in the way.
  const watched: [Element, number, number][] = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    watched.push([p, p.scrollTop, p.scrollLeft]);
  }
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });

  const root = document.scrollingElement;
  const forced: string[] = [];
  for (const [p, top, left] of watched) {
    const s = getComputedStyle(p);
    // The scrolling root scrolls the window, which is always a thing a user can
    // do unless someone has pinned it shut.
    const isRoot = p === root || p === document.documentElement || p === document.body;
    const blocked = (axis: string) => axis === "hidden" || axis === "clip";
    if (p.scrollTop !== top && blocked(s.overflowY) && !(isRoot && !blocked(s.overflowY))) {
      forced.push(
        `${p.tagName} would have to scroll ${p.scrollTop - top}px vertically and its overflow-y is ${s.overflowY}`,
      );
      p.scrollTop = top;
    }
    if (p.scrollLeft !== left && blocked(s.overflowX)) {
      forced.push(
        `${p.tagName} would have to scroll ${p.scrollLeft - left}px horizontally and its overflow-x is ${s.overflowX}`,
      );
      p.scrollLeft = left;
    }
  }

  const full = el.getBoundingClientRect();
  let top = full.top;
  let left = full.left;
  let right = full.right;
  let bottom = full.bottom;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const s = getComputedStyle(p);
    if (s.overflowX === "visible" && s.overflowY === "visible") continue;
    // The PADDING box is what clips, not the border box.
    const pr = p.getBoundingClientRect();
    const pt = pr.top + p.clientTop;
    const pl = pr.left + p.clientLeft;
    top = Math.max(top, pt);
    left = Math.max(left, pl);
    right = Math.min(right, pl + p.clientWidth);
    bottom = Math.min(bottom, pt + p.clientHeight);
  }
  top = Math.max(top, 0);
  left = Math.max(left, 0);
  right = Math.min(right, window.innerWidth);
  bottom = Math.min(bottom, window.innerHeight);
  // What the element loses INSIDE its own box, which is a different loss from
  // being off screen and is invisible to every rectangle measurement: a block
  // element is as wide as its container no matter how far its text runs, so a
  // memo or a recovery word too long to wrap has a perfect bounding box and is
  // still cut in half. Fields scroll their own value by design and a deliberate
  // scroller is not a loss, so neither counts.
  const style = getComputedStyle(el);
  const ownScroller = style.overflowX === "auto" || style.overflowX === "scroll";
  const isField = el.tagName === "INPUT" || el.tagName === "TEXTAREA";
  // And the screen-reader-only idiom, for the reason `geometry` gives: a box
  // clipped to nothing on purpose loses nothing a person could have read.
  const srOnly =
    style.clipPath.startsWith("inset(50%") || style.clip === "rect(0px, 0px, 0px, 0px)";
  const spilled =
    ownScroller || isField || srOnly ? 0 : Math.max(0, el.scrollWidth - el.clientWidth);

  return {
    full: { width: full.width, height: full.height, top: full.top, bottom: full.bottom },
    hiddenX: Math.max(0, full.width - Math.max(0, right - left)),
    hiddenY: Math.max(0, full.height - Math.max(0, bottom - top)),
    viewport: { width: window.innerWidth, height: window.innerHeight },
    forced,
    spilled,
    text: (el.textContent ?? "").trim().slice(0, 50),
  };
};

/** Sub-pixel layout only. Anything a user could notice is more than this. */
const SLIVER = 1;

/**
 * The control can be brought fully into the window and clicked.
 *
 * Scroll first, because a popup legitimately scrolls: the question is not "is
 * it on screen now" but "can the user get to it at all". `block: "center"` is
 * the most generous scroll there is, so a control still clipped afterwards is
 * one no amount of scrolling reaches. If nothing scrolls, nothing moves and the
 * measurement below is the unreachable case.
 */
export async function expectReachable(control: Locator, name: string): Promise<void> {
  await expect(control, `${name}: not attached`).toBeAttached();
  await settle(control.page());
  const m = await control.evaluate(MEASURE_VISIBLE);

  // Named when there was one, because "it is off screen" and "it is off screen
  // and the only thing that could have brought it back is a container nobody
  // can scroll" are the same pixels and very different bugs.
  const blocking = m.forced.length
    ? `, and it can only be reached by a scroll the user cannot perform (${m.forced.join("; ")})`
    : "";
  expect(
    m.hiddenY,
    `${name}: ${m.hiddenY.toFixed(1)}px of its ${m.full.height.toFixed(0)}px height is off screen or clipped, after scrolling as far as the popup allows (box ${m.full.top.toFixed(0)}..${m.full.bottom.toFixed(0)} in a ${m.viewport.height}px window)${blocking}`,
  ).toBeLessThanOrEqual(SLIVER);
  expect(
    m.hiddenX,
    `${name}: ${m.hiddenX.toFixed(1)}px of its ${m.full.width.toFixed(0)}px width is off screen or clipped, in a ${m.viewport.width}px window${blocking}`,
  ).toBeLessThanOrEqual(SLIVER);

  expect(
    m.spilled,
    `${name}: ${m.spilled.toFixed(0)}px of its own content runs past its box, so it is cut off in place: "${m.text}"`,
  ).toBeLessThanOrEqual(SLIVER);

  const hit = await control.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const top = document.elementFromPoint(x, y);
    return {
      ok: !!top && (top === el || el.contains(top) || top.contains(el)),
      at: top ? `${top.tagName}.${(top as HTMLElement).className}` : "nothing",
      point: { x: Math.round(x), y: Math.round(y) },
      box: `${Math.round(r.width)}x${Math.round(r.height)} at ${Math.round(r.left)},${Math.round(r.top)}`,
    };
  });
  expect(
    hit.ok,
    `${name}: its own centre ${JSON.stringify(hit.point)} hits ${hit.at} (its box is ${hit.box})`,
  ).toBe(true);
}

/**
 * The layer a press can actually land on.
 *
 * The popup reaches Receive, Send, Move and every settings action through
 * `aria-modal` sheets. While one is up, the screen underneath is inert by
 * design and the sheet's backdrop is the topmost thing at any control behind
 * it, so sweeping the whole document would report a working modal as a screenful
 * of covered buttons. The sweep is therefore scoped to the frontmost live
 * dialog, and to the page when there is none.
 *
 * "Live" rather than "present": a sheet stays mounted through its exit
 * animation, and that copy is `pointer-events: none` precisely because it no
 * longer takes a press. Read off the computed style rather than off the class
 * that sets it, so a renamed animation cannot silently pick the wrong layer.
 */
async function activeLayer(page: Page): Promise<Locator> {
  const dialogs = page.locator("[role='dialog']");
  for (let i = (await dialogs.count()) - 1; i >= 0; i--) {
    const live = await dialogs
      .nth(i)
      .evaluate((el) => getComputedStyle(el).pointerEvents !== "none");
    if (live) return dialogs.nth(i);
  }
  return page.locator("body");
}

/**
 * The box a reader of an amount actually sees.
 *
 * `Wallet.money()` matches the visually hidden span carrying the exact ungrouped
 * figure, which is the only place that form of the number exists and so the only
 * thing a text match can find. That span is 1x1 and clipped away, so it is the
 * wrong thing to measure: what is on screen is its parent, which holds the
 * grouped whole, the fraction and the code.
 */
export function amountBox(money: Locator): Locator {
  return money.locator("xpath=..");
}

/**
 * Every button, link and text field on screen is reachable and hittable.
 *
 * Returns what it checked so a spec can assert the screen was not EMPTY of
 * controls: a loop over nothing passes, and a screen that failed to render is
 * the most likely way to get there.
 */
export async function expectEveryControlReachable(page: Page, where: string): Promise<string[]> {
  const layer = await activeLayer(page);
  const controls = layer.locator("button:visible, a:visible, input:visible, textarea:visible");
  const n = await controls.count();
  const names: string[] = [];
  for (let i = 0; i < n; i++) {
    const c = controls.nth(i);
    const label =
      (await c.evaluate((el) => {
        const t = (el.textContent ?? "").trim();
        if (t) return t.slice(0, 40);
        const l = el.closest("label");
        return (l?.textContent ?? el.tagName).trim().slice(0, 40);
      })) || `#${i}`;
    await expectReachable(c, `${where}: "${label}"`);
    names.push(label);
  }
  return names;
}

/** The whole contract for one screen at one viewport. */
export async function expectLayoutHolds(
  page: Page,
  where: string,
): Promise<{ controls: string[] }> {
  await expectNoHorizontalScroll(page, where);
  const controls = await expectEveryControlReachable(page, where);
  return { controls };
}
