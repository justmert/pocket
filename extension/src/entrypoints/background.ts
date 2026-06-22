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
const KEEP_ALIVE_ALARM = "pocket.keepalive";

export default defineBackground(() => {
  const controller = new WalletController();
  const ready = controller.init();

  /**
   * Operations running right now in this worker.
   *
   * The idle lock must not fire between a submission and the write that records
   * its consequence. By that point the money has moved, and finishing the job
   * needs the very keys the lock destroys: `clearSession` zeroes the seed in
   * place, so an operation holding a reference to it is not spared either.
   */
  let running = 0;

  chrome.runtime.onMessage.addListener(
    (msg: WalletRequest, sender, sendResponse: (r: WalletResponse<unknown>) => void) => {
      // Only this extension's own pages. A web page cannot reach this listener
      // at all (no content script, no externally_connectable), so this is
      // defence in depth for the worker that holds the keys.
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: "Unauthorized sender." });
        return false;
      }

      // A dApp call, relayed by the content script. It travels the same
      // runtime channel but is NOT a wallet request: it carries an origin, it
      // never reaches `dispatch`, and it can only do what `controller.sep43`
      // allows. Handled before the wallet router so the two cannot be
      // confused for one another.
      if ((msg as { type?: string }).type === "sep43") {
        const call = msg as unknown as { method: string; params: unknown[] };
        void (async () => {
          try {
            await ready;
            const { senderOrigin } = await import("../core/provider/session");
            const origin = senderOrigin(sender);
            sendResponse({ ok: true, data: await controller.sep43(origin, call.method, call.params) });
          } catch (e) {
            sendResponse({ ok: false, error: describeError(e) });
          }
        })();
        return true;
      }

      // The prover speaks on this same runtime channel with its own
      // discriminator. Ignore anything that is not a wallet request outright,
      // rather than answering it and re-arming the idle lock.
      if (typeof msg?.type !== "string") return false;

      const activity = isUserActivity(msg.type);
      if (activity) running++;

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
          if (isUnlocked() && activity) armAutoLock(AUTO_LOCK_MINUTES);
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, error: describeError(e) });
        } finally {
          if (activity) running--;
        }
      })();

      return true; // async response
    },
  );

  // An alarm, not a setTimeout: a setTimeout dies with the worker, so a wallet
  // relying on one would silently stay unlocked across a restart.
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === AUTO_LOCK_ALARM) {
      // Locking mid-operation strands a transaction that has already been
      // submitted: the write that records what it did needs the keys. Wait for
      // the operation instead, and look again shortly. This postpones the lock
      // by at most the operation, which the platform caps at five minutes for a
      // single request anyway.
      if (running > 0) {
        armAutoLock(1);
        return;
      }
      clearSession();
    }
    if (alarm.name === KEEP_ALIVE_ALARM) void keepAlive();
  });

  function armAutoLock(minutes: number) {
    void chrome.alarms.create(AUTO_LOCK_ALARM, { delayInMinutes: minutes });
  }

  /**
   * Bump the confidential account's TTL before it archives.
   *
   * Signing needs the keys, so this can only do anything while unlocked. A
   * locked or closed browser cannot keep an entry alive, which is why the
   * screen says so rather than promising otherwise. The next check is
   * jittered: a fixed cadence would make Pocket users identifiable by the
   * timing of their keep-alive transactions alone.
   */
  async function keepAlive() {
    try {
      await ready;
      if (!isUnlocked()) {
        void chrome.alarms.create(KEEP_ALIVE_ALARM, { delayInMinutes: 60 });
        return;
      }
      const plan = await controller.runKeepAlive();
      void chrome.alarms.create(KEEP_ALIVE_ALARM, {
        delayInMinutes: Math.max(1, Math.round(plan.nextCheckMs / 60_000)),
      });
    } catch {
      // A failed check is not a failed wallet. Look again in an hour rather
      // than dropping the schedule entirely, which would leave the entry to
      // archive silently. `await ready` is inside the try for the same reason:
      // a storage failure at startup must not take the schedule with it.
      void chrome.alarms.create(KEEP_ALIVE_ALARM, { delayInMinutes: 60 });
    }
  }

  /**
   * Make sure a keep-alive check is scheduled, without moving one that already
   * is.
   *
   * `alarms.create` REPLACES a same-named alarm rather than leaving it alone
   * ("If there is another alarm with the same name ... it will be cancelled and
   * replaced by this alarm", chrome.alarms reference). This runs on every worker
   * start, and MV3 restarts the worker whenever the popup opens, so calling
   * keepAlive() here pushed the next check an hour into the future each time.
   * A user who opens their wallet more often than hourly would never have had
   * one fire, and the confidential entry archives on a timer that does not care.
   */
  async function ensureKeepAliveScheduled() {
    if (await chrome.alarms.get(KEEP_ALIVE_ALARM)) return;
    await chrome.alarms.create(KEEP_ALIVE_ALARM, { delayInMinutes: 60 });
  }

  void ensureKeepAliveScheduled();
});
