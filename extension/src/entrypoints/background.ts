// Service worker. Owns the encrypted vault and every network call; the popup is
// a thin UI. Keys never leave this worker and are dropped whenever it restarts,
// which makes worker death an automatic lock rather than a bug.
import "../lib/polyfill"; // must run before any stellar-sdk import
import { WalletController } from "../core/controller";
import { dispatch, describeError, isAllowedWhileLocked, isUserActivity } from "../core/dispatch";
import { isUnlocked, clearSession } from "../core/session";
import type { WalletRequest, WalletResponse } from "../core/messages";

const AUTO_LOCK_ALARM = "pocket.autolock";
const AUTO_LOCK_MINUTES = 15;

export default defineBackground(() => {
  const controller = new WalletController();
  const ready = controller.init();

  chrome.runtime.onMessage.addListener(
    (msg: WalletRequest, sender, sendResponse: (r: WalletResponse<unknown>) => void) => {
      // Only this extension's own pages. A web page cannot reach this listener
      // at all (no content script, no externally_connectable), so this is
      // defence in depth for the worker that holds the keys.
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: "Unauthorized sender." });
        return false;
      }

      // The prover speaks on this same runtime channel with its own
      // discriminator. Ignore anything that is not a wallet request outright,
      // rather than answering it and re-arming the idle lock.
      if (typeof msg?.type !== "string") return false;

      void (async () => {
        try {
          await ready;
          if (!isAllowedWhileLocked(msg.type) && !isUnlocked()) {
            sendResponse({ ok: false, error: "Wallet is locked." });
            return;
          }
          const data = await dispatch(controller, msg);
          // Only real user activity postpones the lock. A status poll or an
          // unrecognised message must not keep a funded wallet open forever.
          if (isUnlocked() && isUserActivity(msg.type)) armAutoLock();
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, error: describeError(e) });
        }
      })();

      return true; // async response
    },
  );

  // An alarm, not a setTimeout: a setTimeout dies with the worker, so a wallet
  // relying on one would silently stay unlocked across a restart.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) clearSession();
  });

  function armAutoLock() {
    void chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: AUTO_LOCK_MINUTES });
  }
});
