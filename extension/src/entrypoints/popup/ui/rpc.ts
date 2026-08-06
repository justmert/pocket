// Popup to background messaging.
import type { WalletRequest, WalletResponse, ResponseMap } from "../../../core/messages";

/**
 * Chrome's own transport failures, in the wallet's words rather than Chrome's.
 *
 * `chrome.runtime.sendMessage` REJECTS on a transport failure, and that path was
 * unguarded: the authored sentence below only ever covered the `!res` case, which
 * is not the one Chrome actually takes. So Chrome's own string reached the screen
 * verbatim, drawn in the danger colour by whichever of the thirty-five call sites
 * caught it (`e instanceof Error ? e.message : String(e)` appears 35 times in
 * `popup/`). The commonest is "Extension context invalidated.", which is what a
 * popup left open across an extension reload says for every press afterwards.
 *
 * `dispatch.ts:describeError` cannot help here: it runs in the WORKER and maps
 * errors the worker threw. Nothing the worker says is involved when the message
 * never reached it, so the popup owns this boundary and this is the only place it
 * can be owned once for every caller.
 *
 * Matched on the message because that is all Chrome gives: these are plain
 * `Error`s with no name and no code. The fallback is deliberately generic rather
 * than an echo, for the same reason the worker's allowlist is by name.
 */
function transportError(e: unknown): Error {
  const raw = e instanceof Error ? e.message : String(e);
  // The extension was reloaded, updated, or disabled while this page stayed open.
  // The page is now orphaned and no message from it will ever arrive.
  if (/context invalidated|Extension context/i.test(raw)) {
    // the cause stays on this one branch: it is the only case where nothing is
    // wrong, so the sentence says why the window has to be reopened.
    return new Error("Pocket was updated or reloaded. Close this window and open it again.");
  }
  // No listener on the other end: the service worker is starting, or has died and
  // not yet been revived. Reopening runs it again.
  if (/Receiving end does not exist|message port closed|Could not establish/i.test(raw)) {
    return new Error("The wallet is not answering right now. Close this window and open it again.");
  }
  return new Error("Pocket could not reach its background service. Try again in a moment.");
}

export async function call<K extends WalletRequest["type"]>(
  msg: Extract<WalletRequest, { type: K }>,
): Promise<ResponseMap[K]> {
  let res: WalletResponse<ResponseMap[K]>;
  try {
    res = (await chrome.runtime.sendMessage(msg)) as WalletResponse<ResponseMap[K]>;
  } catch (e) {
    throw transportError(e);
  }
  if (!res) throw new Error("The wallet did not respond. Try reopening the popup.");
  // The worker's own sentence, already made safe by `dispatch.ts:describeError`,
  // which is an allowlist by error NAME. Passed through untouched on purpose.
  if (!res.ok) throw new Error(res.error);
  return res.data;
}
