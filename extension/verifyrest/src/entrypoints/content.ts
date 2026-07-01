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

    window.addEventListener("message", (e: MessageEvent) => {
      // Only this page, not an iframe pretending to be it.
      if (e.source !== window) return;
      const d = e.data as { channel?: string; id?: string; method?: string; params?: unknown[] };
      if (d?.channel !== CHANNEL || typeof d.id !== "string") return;

      // An unknown method must not reach the worker at all. The allowlist here
      // is convenience; the worker enforces its own, because a content script
      // runs in a hostile page's process and is not a trust boundary.
      if (typeof d.method !== "string" || !ALLOWED.has(d.method)) {
        window.postMessage(
          {
            channel: `${CHANNEL}:reply`,
            id: d.id,
            result: { error: { code: -32601, message: "Unsupported method." } },
          },
          window.location.origin,
        );
        return;
      }

      void chrome.runtime
        .sendMessage({ type: "sep43", method: d.method, params: d.params ?? [] })
        .then(
          (r: { ok: boolean; data?: unknown; error?: string }) => {
            const result = r?.ok
              ? r.data
              : { error: { code: -32603, message: r?.error ?? "Pocket refused." } };
            window.postMessage(
              { channel: `${CHANNEL}:reply`, id: d.id, result },
              window.location.origin,
            );
          },
          () => {
            // The worker was evicted or the extension is updating. Say so
            // rather than leaving the promise unsettled.
            window.postMessage(
              {
                channel: `${CHANNEL}:reply`,
                id: d.id,
                result: { error: { code: -32603, message: "Pocket is unavailable." } },
              },
              window.location.origin,
            );
          },
        );
    });
  },
});
