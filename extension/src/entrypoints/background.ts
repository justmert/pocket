// Service worker. Owns the encrypted vault and every network call; the popup is
// a thin UI. The plaintext seed lives in this worker's memory only. To keep the
// wallet usable across MV3's constant worker eviction, the DEK that re-opens the
// vault is mirrored into chrome.storage.session (RAM, wiped on browser close)
// and restored on startup, up to the user's idle-lock deadline. See
// core/session.ts for the durability model.
import "../lib/polyfill"; // must run before any stellar-sdk import
import { WalletController } from "../core/controller";
import { dispatch, describeError, isAllowedWhileLocked, isUserActivity } from "../core/dispatch";
import { isUnlocked } from "../core/session";
import { isExtensionPage } from "../core/provider/session";
import type { WalletRequest, WalletResponse } from "../core/messages";

const AUTO_LOCK_ALARM = "pocket.autolock";
const KEEP_ALIVE_ALARM = "pocket.keepalive";

// The port an open wallet page holds while it is on screen. It carries no data
// and grants nothing; its only job is to tell the worker "a page is open", so
// the worker can keep itself alive across MV3 eviction while the user is
// actually looking at an unlocked wallet. See `keepWarm` below.
const UI_PORT = "pocket.ui";

// How often to poke an extension API to reset MV3's idle-eviction timer, which
// is about thirty seconds. Comfortably under it, and only ever ticking while
// there is something to keep alive for.
const KEEP_WARM_MS = 20_000;

export default defineBackground(() => {
  const controller = new WalletController();
  const ready = controller.init();

  // Pin the session mirror to trusted contexts (the default, made explicit): a
  // content script running in a web page must never be able to read the DEK the
  // wallet stashes there. Guarded for the test harness that has no setAccessLevel.
  void chrome.storage.session?.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });

  /**
   * Operations running right now in this worker.
   *
   * The idle lock must not fire between a submission and the write that records
   * its consequence. By that point the money has moved, and finishing the job
   * needs the very keys the lock destroys: `clearSession` zeroes the seed in
   * place, so an operation holding a reference to it is not spared either.
   */
  let running = 0;

  /**
   * Pages currently holding the worker open, and the timer that keeps it alive.
   *
   * Staying unlocked across worker eviction is the DEK mirror's job (session.ts),
   * not this. Keep-warm is a narrower optimization on top of it:
   *   - while an operation is in flight (`running > 0`), so a proof or a submit
   *     finishes in ONE worker lifetime rather than being killed mid-flight; the
   *     mirror restores a SESSION, but not a half-finished operation, and
   *   - while an unlocked page is on screen (`uiPorts`), so the popup stays
   *     responsive instead of paying a cold restore on every interaction.
   *
   * It touches neither storage nor the idle-lock alarm. A page connects the port
   * only while unlocked and drops it on close; when nothing needs the worker warm
   * the timer stops and MV3 may evict as usual, which the mirror makes safe.
   */
  const uiPorts = new Set<chrome.runtime.Port>();
  let keepWarmTimer: ReturnType<typeof setInterval> | undefined;

  function keepWarm() {
    const wanted = running > 0 || (uiPorts.size > 0 && isUnlocked());
    if (wanted && keepWarmTimer === undefined) {
      keepWarmTimer = setInterval(() => {
        // Any extension API call counts as worker activity and resets the
        // eviction timer. getPlatformInfo has no side effects and needs no
        // permission. Optional-chained so a test harness without it is a no-op.
        void chrome.runtime.getPlatformInfo?.();
      }, KEEP_WARM_MS);
    } else if (!wanted && keepWarmTimer !== undefined) {
      clearInterval(keepWarmTimer);
      keepWarmTimer = undefined;
    }
  }

  // A wallet page connects this port while it is on screen. Guarded with `?.`
  // because a non-browser test harness has no `onConnect`; there the worker
  // simply has no page holding it open, which is what those tests assume.
  chrome.runtime.onConnect?.addListener?.((port) => {
    if (port.name !== UI_PORT) return;
    // Only our own extension pages may pin the worker open. A content script
    // runs inside a web page and carries our id but is NOT an extension page, so
    // it must not be able to hold the worker (and the keys it guards) alive.
    const base = chrome.runtime.getURL("/");
    if (port.sender?.id !== chrome.runtime.id || !isExtensionPage(port.sender ?? {}, base)) {
      port.disconnect();
      return;
    }
    uiPorts.add(port);
    keepWarm();
    port.onDisconnect.addListener(() => {
      uiPorts.delete(port);
      keepWarm();
    });
  });

  /**
   * Tell every open wallet page that the session is gone.
   *
   * This lived inside the idle-alarm branch and nowhere else, so ONLY an idle
   * timeout told other pages. Pressing Lock, and erasing the wallet, both
   * destroy the session synchronously and posted nothing, and Pocket ships an
   * extension tab as well as the toolbar popup, so two pages open at once is
   * ordinary. The second one kept a full render of balances, history and the
   * address on screen for a wallet whose keys no longer existed, and only found
   * out when the user next touched it.
   *
   * The deliberate lock is the worse case of the two, not the better one: the
   * user pressed Lock, watched one window obey, and can see another that has
   * not.
   */
  const announceLocked = () => {
    for (const port of uiPorts) {
      try {
        port.postMessage({ type: "locked" });
      } catch {
        /* the page went away between the lock and this post; its disconnect
           handler has already dropped it, or will. */
      }
    }
  };

  chrome.runtime.onMessage.addListener(
    (msg: WalletRequest, sender, sendResponse: (r: WalletResponse<unknown>) => void) => {
      // Only this extension's own pages. A web page cannot reach this listener
      // at all (no content script, no externally_connectable), so this is
      // defence in depth for the worker that holds the keys.
      if (sender.id !== chrome.runtime.id) {
        sendResponse({ ok: false, error: "Unauthorized sender." });
        return false;
      }
      // ...and a content script carries that same id, so it is not on its own a
      // boundary. Anything not from one of our own pages may take the `sep43`
      // route below and nothing else.
      const ownPage = isExtensionPage(sender, chrome.runtime.getURL("/"));

      // A dApp call, relayed by the content script. It travels the same
      // runtime channel but is NOT a wallet request: it carries an origin, it
      // never reaches `dispatch`, and it can only do what `controller.sep43`
      // allows. Handled before the wallet router so the two cannot be
      // confused for one another.
      if (!ownPage && (msg as { type?: string }).type !== "sep43") {
        sendResponse({ ok: false, error: "Unauthorized sender." });
        return false;
      }

      if ((msg as { type?: string }).type === "sep43") {
        const call = msg as unknown as { method: string; params: unknown[] };
        void (async () => {
          try {
            await ready;
            const { senderOrigin } = await import("../core/provider/session");
            const origin = senderOrigin(sender);
            sendResponse({
              ok: true,
              data: await controller.sep43(origin, call.method, call.params),
            });
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
      if (activity) {
        running++;
        keepWarm();
      }

      void (async () => {
        try {
          await ready;
          if (!isAllowedWhileLocked(msg.type) && !isUnlocked()) {
            sendResponse({ ok: false, error: "Wallet is locked." });
            return;
          }
          const wasUnlocked = isUnlocked();
          const data = await dispatch(controller, msg);
          // Only real user activity postpones the lock. A status poll or an
          // unrecognised message must not keep a funded wallet open forever. The
          // window is the user's setting, and the mirror's deadline slides with
          // the alarm so both enforcers agree.
          if (isUnlocked() && activity) {
            armAutoLock(controller.autoLockMinutes());
            controller.slideDeadline();
          }
          // Any request that ENDED the session tells the other pages, not just
          // the idle alarm. Keyed on the observed transition rather than on a
          // list of message types, so a future request that locks is covered by
          // the same line rather than by remembering to add it here.
          if (wasUnlocked && !isUnlocked()) announceLocked();
          sendResponse({ ok: true, data });
        } catch (e) {
          sendResponse({ ok: false, error: describeError(e) });
        } finally {
          if (activity) running--;
          // running may have hit zero, or this message may have locked or
          // unlocked the wallet; re-evaluate whether the worker still needs to
          // be kept warm.
          keepWarm();
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
      // Go through the controller, not straight to `clearSession`. Locking is
      // more than dropping keys: it also drops dApp grants, so a site that can
      // read the address does not keep doing so. Calling the session module
      // directly did the smaller half, which meant the AUTOMATIC lock cleaned
      // up less than the manual one, in exactly the case the automatic lock
      // exists for: the user has walked away from the machine.
      // Awaited via the alarm handler's own promise: an idle lock that has not
      // finished clearing grants has not finished locking.
      void controller.lock().then(() => {
        // Tell any page still on screen that it just locked, so a popup that sat
        // open through the timeout switches to the lock screen rather than
        // showing balances for a wallet whose keys are gone. Before the keep-warm
        // above, the worker would simply have died here and the page would have
        // found out on its next call; now the worker survives the idle period, so
        // it has to say so itself.
        announceLocked();
        keepWarm();
      });
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

  // On worker start, init() may have restored a session from the RAM mirror. A
  // fresh worker has no alarm armed of its own, so match one to the restored
  // deadline; otherwise a restored session would have no idle lock behind it.
  void ready.then(() => {
    const deadline = controller.sessionDeadline();
    if (deadline === null) return;
    armAutoLock(Math.max(1, Math.ceil((deadline - Date.now()) / 60_000)));
  });
});
