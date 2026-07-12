// The relay between a page and the wallet.
//
// It is deliberately dumb: it validates the shape of a message, forwards it,
// and posts the answer back. It holds no keys, makes no decisions, and knows
// nothing about accounts. Everything that matters happens in the service
// worker, which is the only context that can see a key or raise an approval.
//
// The origin is NOT taken from anything the page says. Chrome fills in
// `sender.origin` on the worker side from the frame itself, so a page cannot
// claim to be somewhere it is not.
export default defineContentScript({
  matches: ["http://*/*", "https://*/*"],
  runAt: "document_start",
  world: "ISOLATED",
  async main() {
    // The provider object has to live in the PAGE world to be reachable by
    // page scripts, and MV3 forbids remotely hosted code, so it ships in the
    // package and is injected from here.
    const el = document.createElement("script");
    el.src = chrome.runtime.getURL("/injected.js");
    el.type = "module";
    (document.head ?? document.documentElement).appendChild(el);
    el.remove();

    const CHANNEL = "pocket:sep43";
    const ALLOWED = new Set([
      "getAddress",
      "signTransaction",
      "signAuthEntry",
      "signMessage",
      "getNetwork",
    ]);

    const reply = (id: string, result: unknown) =>
      window.postMessage({ channel: `${CHANNEL}:reply`, id, result }, window.location.origin);

    // A page can post into this listener as fast as it can run, and every
    // message that gets past the checks below costs a runtime hop and keeps the
    // worker awake. What MATTERS is enforced in the worker, which caps parked
    // approvals per origin the same way it enforces its own method allowlist,
    // because a content script shares a process with a hostile page and can
    // always be bypassed by one that finds a way into this world. This is the
    // cheap first line: it stops a busy loop becoming one runtime message per
    // frame, and it costs a well-behaved dapp nothing, since no honest one
    // sends four calls a second.
    //
    // Over budget is ANSWERED, not dropped. A dapp told to slow down can; a
    // dapp whose promise never settles just hangs, and a hung page is what a
    // user reports as "Pocket is broken".
    const BURST = 12;
    const PER_SECOND = 4;
    let tokens = BURST;
    let refilled = Date.now();
    const take = (): boolean => {
      const now = Date.now();
      tokens = Math.min(BURST, tokens + ((now - refilled) / 1000) * PER_SECOND);
      refilled = now;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    };

    window.addEventListener("message", (e: MessageEvent) => {
      // Only this page, not an iframe pretending to be it.
      if (e.source !== window) return;
      const d = e.data as { channel?: string; id?: string; method?: string; params?: unknown[] };
      if (d?.channel !== CHANNEL || typeof d.id !== "string") return;
      // Bound once. The narrowing above does not survive into the callbacks
      // below, and the id is what pairs an answer with the call that asked.
      const id = d.id;

      // An unknown method must not reach the worker at all. The allowlist here
      // is convenience; the worker enforces its own, because a content script
      // runs in a hostile page's process and is not a trust boundary.
      if (typeof d.method !== "string" || !ALLOWED.has(d.method)) {
        reply(id, { error: { code: -32601, message: "Unsupported method." } });
        return;
      }

      // Counted AFTER the shape and method checks: a message that was never
      // going to reach the worker costs nothing to reject, so it must not cost
      // a token either. The budget is for calls that would have been relayed.
      if (!take()) {
        reply(id, {
          error: { code: -32005, message: "Too many requests to Pocket. Slow down and retry." },
        });
        return;
      }

      void chrome.runtime
        .sendMessage({ type: "sep43", method: d.method, params: d.params ?? [] })
        .then(
          (r: { ok: boolean; data?: unknown; error?: string }) => {
            const result = r?.ok
              ? r.data
              : { error: { code: -32603, message: r?.error ?? "Pocket refused." } };
            reply(id, result);
          },
          () => {
            // The worker was evicted or the extension is updating. Say so
            // rather than leaving the promise unsettled.
            reply(id, { error: { code: -32603, message: "Pocket is unavailable." } });
          },
        );
    });
  },
});
