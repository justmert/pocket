// Quitting the browser at the phrase step must not skip the backup check.
//
// `create` installs the vault BEFORE the words are ever drawn, so from the
// instant it resolves the wallet is complete on disk. The "onboarding is
// unfinished" flag lived only in session storage, which dies with the browser
// exactly as the tab does. So quitting Chrome at the phrase screen left a
// working wallet whose recovery phrase was never confirmed, and reopening
// showed Home with an address and a balance, no notice, and no confirm step
// ever again.
//
// The one gate that asserts the phrase was recorded, skipped permanently, by an
// action as ordinary as closing a laptop.
import { describe, it, expect, beforeEach, vi } from "vitest";

const session = new Map<string, unknown>();
const local = new Map<string, unknown>();
const area = (m: Map<string, unknown>) => ({
  get: async (k: string) => (m.has(k) ? { [k]: m.get(k) } : {}),
  set: async (o: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(o)) m.set(k, v);
  },
  remove: async (k: string) => {
    m.delete(k);
  },
});
vi.stubGlobal("chrome", { storage: { session: area(session), local: area(local) } });

const {
  markOnboardingUnfinished,
  clearOnboardingUnfinished,
  dismissUnfinishedTab,
  onboardingUnfinished,
  phraseNeverConfirmed,
  clearPhraseNeverConfirmed,
} = await import("./onboardingTab");

/** What quitting the browser does: session storage goes, local storage stays. */
function browserRestart() {
  session.clear();
}

beforeEach(() => {
  session.clear();
  local.clear();
});

describe("a phrase that was never confirmed", () => {
  it("is still known about after the browser has been closed", async () => {
    await markOnboardingUnfinished();
    browserRestart();

    expect(await onboardingUnfinished(), "there is no tab to go back to").toBe(false);
    expect(await phraseNeverConfirmed(), "the wallet forgot the check was skipped").toBe(true);
  });

  it("is forgotten once the check is actually passed", async () => {
    await markOnboardingUnfinished();
    await clearOnboardingUnfinished();

    expect(await onboardingUnfinished()).toBe(false);
    expect(await phraseNeverConfirmed()).toBe(false);
  });

  it("survives dismissing the gone-tab screen, which confirms nothing", async () => {
    // "That tab is gone, continue to the wallet" removes the blocker because
    // there is nothing to return to. It is not the user saying they wrote the
    // words down, and clearing both flags there is how this became silent.
    await markOnboardingUnfinished();
    await dismissUnfinishedTab();

    expect(await onboardingUnfinished()).toBe(false);
    expect(await phraseNeverConfirmed(), "dismissing the blocker also cleared the fact").toBe(true);
  });

  it("goes away when the user has been sent to the words", async () => {
    await markOnboardingUnfinished();
    await clearPhraseNeverConfirmed();
    expect(await phraseNeverConfirmed()).toBe(false);
  });

  it("is not set for a wallet that never onboarded here", async () => {
    // An imported wallet, or a second install. Neither ever drew a phrase, so
    // neither is owed this notice.
    expect(await phraseNeverConfirmed()).toBe(false);
  });
});
