// The object a dApp actually talks to, running in the PAGE.
//
// It holds no keys and makes no decisions. Every call is posted to the content
// script, which relays to the service worker, which is the only context that
// can see a key or show an approval. So a hostile page can ask for anything
// and learns only what the user consents to.
//
// SEP-43 returns `{ error }` rather than throwing, so a dapp that forgets a
// try/catch still sees a refusal instead of an unhandled rejection.
import { ERROR, type Sep43Provider, type Sep43Result } from "../core/provider/sep43";

const CHANNEL = "pocket:sep43";
let seq = 0;

function request<T>(method: string, params: unknown[]): Promise<Sep43Result<T>> {
  const id = `${Date.now()}-${seq++}`;
  return new Promise((resolve) => {
    const onReply = (e: MessageEvent) => {
      const d = e.data as { channel?: string; id?: string; result?: unknown } | null;
      if (e.source !== window || d?.channel !== `${CHANNEL}:reply` || d.id !== id) return;
      window.removeEventListener("message", onReply);
      resolve(d.result as Sep43Result<T>);
    };
    window.addEventListener("message", onReply);
    window.postMessage({ channel: CHANNEL, id, method, params }, window.location.origin);

    // A wallet that never answers must not leave a dapp hanging forever. The
    // popup can take a while (a user reads before approving), so this is
    // generous; it exists to bound the wait, not to police it.
    setTimeout(() => {
      window.removeEventListener("message", onReply);
      resolve({ error: { code: ERROR.INTERNAL, message: "Pocket did not respond." } } as Sep43Result<T>);
    }, 300_000);
  });
}

export default defineUnlistedScript(() => {
  const provider: Sep43Provider = {
    getAddress: () => request("getAddress", []),
    signTransaction: (xdr, opts) => request("signTransaction", [xdr, opts]),
    signAuthEntry: (entry, opts) => request("signAuthEntry", [entry, opts]),
    signMessage: (message, opts) => request("signMessage", [message, opts]),
    getNetwork: () => request("getNetwork", []),
  };

  // SEP-43's discovery shape. Frozen and non-writable so a later script on the
  // same page cannot swap a method out and impersonate the wallet.
  Object.defineProperty(window, "pocket", { value: Object.freeze(provider), writable: false });
});
