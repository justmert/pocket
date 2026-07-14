// What "Go back to it" is allowed to answer, and what the caller must be able
// to learn from it.
//
// `raiseOnboardingTab` used to return `Promise<void>`. It knew perfectly well
// when the tab had gone and threw that away, so `FinishOnboarding`'s single
// button called it, nothing happened, and the screen stayed. That screen stands
// in front of the whole wallet and its marker lives in `chrome.storage.session`,
// so "nothing happened" lasted until the browser was quit.
//
// The other half is why the answer cannot be "does a tab with this id exist".
// A tab NAVIGATED somewhere else keeps its id, so `tabs.update` succeeds and the
// wallet would close itself on top of an unrelated web page. `runtime.getContexts`
// is asked instead, because it lists this extension's own live documents and a
// tab appears there only while one of our pages is still loaded in it.
import { describe, it, expect, beforeEach, vi } from "vitest";

const OPEN_TAB_KEY = "pocket:onboarding-tab";

interface Harness {
  session: Map<string, unknown>;
  /** tab ids that still hold one of OUR documents. */
  ours: Set<number>;
  /** tab ids chrome will accept an update for, ours or not. */
  alive: Set<number>;
  closed: number;
  updated: number[];
}

let h: Harness;

function install(): void {
  h = { session: new Map(), ours: new Set(), alive: new Set(), closed: 0, updated: [] };
  const chrome = {
    runtime: {
      ContextType: { TAB: "TAB", OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      getContexts: (filter: { tabIds?: number[] }) =>
        Promise.resolve((filter.tabIds ?? []).filter((id) => h.ours.has(id)).map((id) => ({ id }))),
    },
    storage: {
      session: {
        get: (k: string) => Promise.resolve({ [k]: h.session.get(k) }),
        set: (o: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(o)) h.session.set(k, v);
          return Promise.resolve();
        },
        remove: (k: string) => {
          h.session.delete(k);
          return Promise.resolve();
        },
      },
    },
    tabs: {
      update: (id: number) => {
        h.updated.push(id);
        return h.alive.has(id)
          ? Promise.resolve({ id, windowId: 1 })
          : Promise.reject(new Error("No tab with id"));
      },
    },
    windows: { update: () => Promise.resolve({}) },
  };
  vi.stubGlobal("chrome", chrome);
  vi.stubGlobal("window", { close: () => void h.closed++ });
}

beforeEach(() => {
  install();
  vi.resetModules();
});

const load = async () => await import("./onboardingTab");

describe("raiseOnboardingTab answers whether the phrase is now in front of the user", () => {
  it("raises the tab and closes this window when our page is still in it", async () => {
    h.session.set(OPEN_TAB_KEY, 7);
    h.ours.add(7);
    h.alive.add(7);

    const { raiseOnboardingTab } = await load();
    await expect(raiseOnboardingTab()).resolves.toBe(true);
    expect(h.updated, "the tab was never raised").toEqual([7]);
    expect(h.closed, "this window should be closing behind the raise").toBe(1);
  });

  it("answers false when the tab has been closed", async () => {
    h.session.set(OPEN_TAB_KEY, 7);
    // neither ours nor alive: the ordinary case of someone closing the tab.

    const { raiseOnboardingTab } = await load();
    await expect(raiseOnboardingTab()).resolves.toBe(false);
    expect(h.closed, "the wallet must not dismiss itself when nothing was raised").toBe(0);
  });

  it("answers false when the tab is alive but has been NAVIGATED away from us", async () => {
    // The case a tab-id check cannot see, and the reason `getContexts` is asked.
    // `tabs.update` would succeed here, so an id-only implementation would focus
    // an unrelated page and then close the wallet on top of it.
    h.session.set(OPEN_TAB_KEY, 7);
    h.alive.add(7);

    const { raiseOnboardingTab } = await load();
    await expect(raiseOnboardingTab()).resolves.toBe(false);
    expect(h.updated, "a tab that is no longer ours must not even be raised").toEqual([]);
    expect(h.closed).toBe(0);
  });

  it("answers false when the raise itself fails after the context check passed", async () => {
    // The race: `getContexts` and `tabs.update` are two round trips, and the tab
    // can be closed between them. Without this the `raise` result could be
    // discarded and the window would close on a raise that never happened.
    h.session.set(OPEN_TAB_KEY, 7);
    h.ours.add(7);
    // not in `alive`, so `tabs.update` rejects.

    const { raiseOnboardingTab } = await load();
    await expect(raiseOnboardingTab()).resolves.toBe(false);
    expect(h.updated, "the raise should have been attempted").toEqual([7]);
    expect(h.closed, "a failed raise must not dismiss the wallet").toBe(0);
  });

  it("answers false when no tab was ever remembered", async () => {
    const { raiseOnboardingTab } = await load();
    await expect(raiseOnboardingTab()).resolves.toBe(false);
    expect(h.closed).toBe(0);
  });

  it("answers false rather than throwing when chrome refuses the read", async () => {
    // A rejection here must reach the caller as "I could not", not as an
    // unhandled rejection inside an onClick.
    vi.stubGlobal("chrome", {
      ...(globalThis as unknown as { chrome: Record<string, unknown> }).chrome,
      storage: { session: { get: () => Promise.reject(new Error("no")) } },
    });
    const { raiseOnboardingTab } = await load();
    await expect(raiseOnboardingTab()).resolves.toBe(false);
  });
});

describe("the marker the way out has to clear", () => {
  it("clearOnboardingUnfinished removes it, so the wallet is reachable again", async () => {
    const { markOnboardingUnfinished, onboardingUnfinished, clearOnboardingUnfinished } =
      await load();

    await markOnboardingUnfinished();
    await expect(onboardingUnfinished()).resolves.toBe(true);

    await clearOnboardingUnfinished();
    await expect(onboardingUnfinished()).resolves.toBe(false);
  });
});
