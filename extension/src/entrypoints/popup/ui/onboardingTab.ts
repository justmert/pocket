// where onboarding runs.
//
// chrome dismisses a toolbar popup the moment the window loses focus, and it is
// the popup that shows the recovery phrase. someone who follows the screen's own
// instruction and opens a password manager to write down 24 words closes the
// only window holding them. the vault is already installed by then, so the
// wallet still opens and nothing looks wrong until the day the phrase is the
// only way back.
//
// so the one flow that shows a secret does not run in a window that can be
// dismissed by looking away. it runs in a tab.
//
// neither `tabs.getCurrent`, `tabs.create`, `tabs.update` nor `windows.update`
// needs the "tabs" permission. without it the returned Tab omits url, title and
// favIconUrl, and nothing here reads any of them.
const OPEN_TAB_KEY = "pocket:onboarding-tab";

/**
 * where onboarding ended up.
 *
 * `stuck` is separate from `tab` because the phrase screen has to say something
 * different in each: a tab survives losing focus and a popup does not, and the
 * screen may not claim the wrong one.
 */
export type Placement = "tab" | "handedOff" | "stuck";

/**
 * hand onboarding to a tab, if this is not already one.
 *
 * `handedOff` means this window is closing, so the caller paints nothing
 * further.
 *
 * it never rejects. a browser that refuses to open a tab is one where onboarding
 * runs in the popup after all, which is the behaviour this replaces: worse, but
 * still a wallet someone can create. leaving them at a window that never renders
 * would be the only outcome worse than the bug. it reports itself as `stuck` so
 * that the window at least says what it is.
 */
export async function placeOnboarding(): Promise<Placement> {
  try {
    // undefined in a toolbar popup, a Tab anywhere else.
    if (await chrome.tabs.getCurrent()) return "tab";

    // a second click on the toolbar icon raises the tab already open rather than
    // opening another, so a phrase mid-transcription is never buried under a
    // duplicate. session storage is cleared when the browser is, which is
    // exactly when that tab goes too.
    const remembered = (await chrome.storage.session.get(OPEN_TAB_KEY))[OPEN_TAB_KEY] as unknown;
    if (typeof remembered === "number" && (await raise(remembered))) {
      window.close();
      return "handedOff";
    }

    const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    if (typeof tab.id === "number") await chrome.storage.session.set({ [OPEN_TAB_KEY]: tab.id });
    window.close();
    return "handedOff";
  } catch {
    return "stuck";
  }
}

/**
 * bring an already-open onboarding tab to the front.
 *
 * false when it is gone, which is the ordinary case of someone having closed it.
 * activating a tab does not focus the window holding it, and a tab raised in a
 * window behind this one looks exactly like a click that did nothing.
 */
async function raise(id: number): Promise<boolean> {
  try {
    const tab = await chrome.tabs.update(id, { active: true });
    if (tab && typeof tab.windowId === "number") {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
    return true;
  } catch {
    return false;
  }
}
