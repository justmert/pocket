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
 * is our onboarding page still the thing living in that tab?
 *
 * a remembered tab id answers only "does a tab with this id exist", and that is
 * the wrong question twice over: the tab can have been closed, and it can have
 * been navigated somewhere else with the id still perfectly alive. `tabs.update`
 * succeeds in the second case, so raising by id alone could focus a tab showing
 * an unrelated web page and then close the wallet on top of it.
 *
 * `runtime.getContexts` answers the right question directly: it enumerates this
 * extension's OWN live documents, so a tab appears here only while one of our
 * pages is still loaded in it. it needs no permission (the prover already uses
 * it, core/prover/client.ts:27), which matters because reading `Tab.url` instead
 * would need "tabs" or a host permission and D12 committed to adding neither.
 */
async function stillOurs(id: number): Promise<boolean> {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.TAB],
      tabIds: [id],
    });
    return contexts.length > 0;
  } catch {
    return false;
  }
}

/**
 * bring the tab holding the phrase to the front, from a window that is not it.
 *
 * exported for the second-window case: a toolbar click during an unfinished
 * backup should take the user back to the words rather than show them a wallet.
 *
 * TRUE means this window is closing because the words are now in front of the
 * user. FALSE means they are not, and the caller owes them a different screen:
 * the old signature was `Promise<void>`, so the one control on that screen did
 * nothing at all whenever the tab had gone, on a screen that stands in front of
 * the whole wallet until the browser is quit. "the phrase went with it" was true
 * and was never the user's whole problem.
 */
export async function raiseOnboardingTab(): Promise<boolean> {
  try {
    const remembered = (await chrome.storage.session.get(OPEN_TAB_KEY))[OPEN_TAB_KEY] as unknown;
    if (typeof remembered !== "number") return false;
    if (!(await stillOurs(remembered))) return false;
    if (!(await raise(remembered))) return false;
    window.close();
    return true;
  } catch {
    return false;
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

/**
 * onboarding is past the point of no return and has not finished.
 *
 * `create` installs the vault before the phrase is ever drawn, so from the
 * instant it resolves `status()` reports a complete, unlocked wallet. Every
 * window except the one holding the words agrees: which meant that a user who
 * clicked the toolbar icon mid-transcription was shown a working wallet with an
 * address and a balance: the most authoritative statement the product can make
 * that setup is done, made while the only copy of the recovery phrase was still
 * on a screen somewhere else and had never been written down.
 *
 * that is worse than the failure the tab was built to fix. the old one was
 * silence; this one affirmatively tells the user they are finished.
 *
 * session storage, so it dies with the browser exactly as the tab does.
 */
const UNFINISHED_KEY = "pocket:onboarding-unfinished";

export async function markOnboardingUnfinished(): Promise<void> {
  try {
    await chrome.storage.session.set({ [UNFINISHED_KEY]: true });
  } catch {
    // a browser that will not remember this is one where the second window
    // shows the wallet, which is the behaviour this replaces. not worth failing
    // the flow the user is in the middle of.
  }
}

export async function clearOnboardingUnfinished(): Promise<void> {
  try {
    await chrome.storage.session.remove(UNFINISHED_KEY);
  } catch {
    // nothing reads it once the wallet is initialised and verified.
  }
}

/** true while a phrase is on a screen somewhere and has not been confirmed. */
export async function onboardingUnfinished(): Promise<boolean> {
  try {
    return Boolean((await chrome.storage.session.get(UNFINISHED_KEY))[UNFINISHED_KEY]);
  } catch {
    return false;
  }
}
