// A chrome the service worker can actually run against.
//
// Not a mock of wallet code. This stands in for the BROWSER, which is the one
// thing a node process cannot provide, and it records what the worker did to it
// so a test can ask questions the real API cannot answer: which alarms are
// armed, what is in session storage, whether a listener answered at all.
//
// Everything else is real. The vault does real scrypt, the derivation is real
// BIP-32, `dispatch` is the shipped router and `background.ts` is the shipped
// listener.
import { vi } from "vitest";

export interface Alarm {
  name: string;
  delayInMinutes?: number;
  periodInMinutes?: number;
}

export interface ChromeShim {
  local: Map<string, unknown>;
  /** Nothing sensitive may ever appear here. Asserted, not assumed. */
  session: Map<string, unknown>;
  alarms: Map<string, Alarm>;
  /** Every alarm ever created, so a re-arm is visible and not just the last state. */
  alarmHistory: Alarm[];
  /** Fire an alarm as the browser would. */
  fireAlarm(name: string): void;
  /** Deliver a runtime message as the browser would, and await the reply. */
  send(message: unknown, sender?: { id?: string; origin?: string; url?: string }): Promise<unknown>;
  /** Listeners the worker registered, so a test can prove one exists. */
  messageListeners: number;
  /**
   * Called before every `storage.local` write.
   *
   * Used to RECORD the order writes land in, which is how this suite proves
   * that two installs cannot interleave. A hook may also return a promise to
   * hold a write open, but see the warning on the implementation before doing
   * so: holding a write changes the schedule, and a race test that no longer
   * races is worse than no test.
   */
  beforeLocalWrite?: (key: string, value: unknown) => unknown;
  /**
   * Called after every `storage.local` remove, with the keys that went.
   *
   * RECORDING ONLY, and its return value is ignored on purpose: an erase is the
   * one moment when a wallet exists nowhere, and a test that wants to race that
   * window needs to know when it opened. Returning a promise here would suspend
   * the erase and move the schedule, which is the mistake documented on the
   * write path.
   */
  afterLocalRemove?: (keys: string[]) => void;
}

type MessageListener = (
  msg: unknown,
  sender: { id?: string; origin?: string; url?: string },
  sendResponse: (r: unknown) => void,
) => boolean | undefined;

export const EXTENSION_ID = "pocketextensionidaaaaaaaaaaaaaaaa";
/** What Chrome actually stamps on a message from our own popup. */
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
export const POPUP_SENDER = {
  id: EXTENSION_ID,
  origin: EXTENSION_ORIGIN,
  url: `${EXTENSION_ORIGIN}/popup.html`,
};

/**
 * Install the shim. Call this at module top level, BEFORE importing anything
 * that touches `chrome`, then use dynamic `await import(...)` for the modules
 * under test.
 */
export function installChrome(): ChromeShim {
  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const alarms = new Map<string, Alarm>();
  const alarmHistory: Alarm[] = [];
  const messageHandlers: MessageListener[] = [];
  const alarmHandlers: ((a: { name: string }) => void)[] = [];

  // Assigned once the shim object below exists, so the hook a test sets is the
  // one the write path reads.
  let shim: ChromeShim;

  const area = (m: Map<string, unknown>, hooked = false) => ({
    get: async (k: string | string[] | null) => {
      if (k === null) return Object.fromEntries(m);
      if (Array.isArray(k)) {
        const out: Record<string, unknown> = {};
        for (const key of k) if (m.has(key)) out[key] = m.get(key);
        return out;
      }
      return m.has(k) ? { [k]: m.get(k) } : {};
    },
    set: async (o: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(o)) {
        // THE INSTRUMENT MUST NOT MOVE THE THING IT MEASURES.
        //
        // `await undefined` is still a microtask. An earlier version of this
        // file awaited the hook unconditionally, which added one tick to every
        // write in every test, and under that schedule two concurrent imports
        // stopped interleaving at all: the second caller's guard saw the first
        // caller's header and correctly refused, so the race test went green
        // while the race was still there. The read path had the same defect.
        //
        // So: only await something that is actually thenable. A recording hook
        // like `(k) => { order.push(k) }` costs nothing, and `(k) => order.push(k)`
        // returning a number no longer accidentally suspends the writer.
        const held = hooked ? shim.beforeLocalWrite?.(k, v) : undefined;
        if (typeof (held as PromiseLike<void> | undefined)?.then === "function") {
          await held;
        }
        m.set(k, v);
      }
    },
    remove: async (k: string | string[]) => {
      const keys = Array.isArray(k) ? k : [k];
      for (const key of keys) m.delete(key);
      if (hooked) shim.afterLocalRemove?.(keys);
    },
    clear: async () => m.clear(),
  });

  vi.stubGlobal("chrome", {
    runtime: {
      id: EXTENSION_ID,
      ContextType: { OFFSCREEN_DOCUMENT: "OFFSCREEN_DOCUMENT" },
      getContexts: async () => [],
      lastError: undefined,
      getURL: (path: string) => `${EXTENSION_ORIGIN}${path}`,
      onMessage: {
        addListener: (fn: MessageListener) => messageHandlers.push(fn),
      },
      sendMessage: async () => undefined,
    },
    storage: { local: area(local, true), session: area(session) },
    alarms: {
      create: async (name: string, info: Omit<Alarm, "name">) => {
        const a = { name, ...info };
        alarms.set(name, a);
        alarmHistory.push(a);
      },
      get: async (name: string) => alarms.get(name),
      clear: async (name: string) => alarms.delete(name),
      onAlarm: { addListener: (fn: (a: { name: string }) => void) => alarmHandlers.push(fn) },
    },
    offscreen: {
      Reason: { WORKERS: "WORKERS" },
      createDocument: async () => undefined,
      closeDocument: async () => undefined,
    },
  });

  // WXT auto-imports this. Calling the body immediately is what the real
  // wrapper does, so the listeners register on the shim above.
  vi.stubGlobal("defineBackground", (fn: () => void) => fn());

  shim = {
    local,
    session,
    alarms,
    alarmHistory,
    messageListeners: 0,
    fireAlarm(name: string) {
      for (const h of alarmHandlers) h({ name });
    },
    // The default sender is a POPUP, url and all. It used to be `{ id }` alone,
    // which Chrome never sends for a page and which made the harness unable to
    // tell the popup apart from a content script: both are "the extension's id
    // and nothing else". Eighty-eight tests agreed with each other about a
    // sender that does not exist.
    async send(
      message: unknown,
      sender: { id?: string; origin?: string; url?: string } = POPUP_SENDER,
    ) {
      if (messageHandlers.length === 0) throw new Error("no message listener is registered");
      return new Promise((resolve) => {
        let answered = false;
        const reply = (r: unknown) => {
          answered = true;
          resolve(r);
        };
        let handled = false;
        for (const h of messageHandlers) {
          if (h(message, sender, reply) === true) handled = true;
        }
        // A listener that returns anything but `true` will not answer later, so
        // resolving to undefined here is what the popup actually observes.
        if (!handled && !answered) resolve(undefined);
      });
    },
  };
  return shim;
}

/** Every request type in the WalletRequest union, as the popup can send them. */
export const EVERY_REQUEST: { type: string; msg: Record<string, unknown> }[] = [
  { type: "status", msg: { type: "status" } },
  { type: "create", msg: { type: "create", password: "pw" } },
  { type: "import", msg: { type: "import", password: "pw", mnemonic: "x" } },
  { type: "unlock", msg: { type: "unlock", password: "pw" } },
  { type: "lock", msg: { type: "lock" } },
  { type: "balances", msg: { type: "balances" } },
  {
    type: "buildPayment",
    msg: { type: "buildPayment", to: "G", amount: "1", assetId: "native" },
  },
  { type: "confirmPayment", msg: { type: "confirmPayment", handle: "h" } },
  { type: "reset", msg: { type: "reset", password: "pw" } },
  { type: "revealPhrase", msg: { type: "revealPhrase", password: "pw" } },
  { type: "privatePocket", msg: { type: "privatePocket" } },
  { type: "privatePockets", msg: { type: "privatePockets" } },
  { type: "buildPrivateOp", msg: { type: "buildPrivateOp", op: { kind: "merge" } } },
  { type: "confirmPrivateOp", msg: { type: "confirmPrivateOp", handle: "h" } },
  { type: "inFlight", msg: { type: "inFlight" } },
  { type: "reconcileInFlight", msg: { type: "reconcileInFlight" } },
  {
    type: "recoverFromMnemonic",
    msg: { type: "recoverFromMnemonic", mnemonic: "x", password: "pw" },
  },
  { type: "setNetwork", msg: { type: "setNetwork", network: "testnet" } },
  { type: "setAutoLock", msg: { type: "setAutoLock", minutes: 15 } },
  { type: "fundTestnet", msg: { type: "fundTestnet" } },
  // The SEP-43 dApp surface, added mid-pass. None of these is on the
  // locked-state allowlist, and all four reach key material or reveal the
  // address, so all four must refuse while locked.
  { type: "rebuildFromHistory", msg: { type: "rebuildFromHistory" } },
  { type: "dappSessions", msg: { type: "dappSessions" } },
  { type: "connectDapp", msg: { type: "connectDapp", origin: "https://example.com" } },
  { type: "disconnectDapp", msg: { type: "disconnectDapp", origin: "https://example.com" } },
  // The dApp approval queue and the yield read, added later in the same pass.
  // `resolveDappRequest` is the single most consequential message here: it is a
  // user saying yes to something a website asked for.
  { type: "yieldPosition", msg: { type: "yieldPosition" } },
  {
    type: "buildYieldMove",
    msg: { type: "buildYieldMove", kind: "deposit", amount: "1" },
  },
  { type: "confirmYieldMove", msg: { type: "confirmYieldMove", handle: "h" } },
  {
    type: "swapQuote",
    msg: { type: "swapQuote", assetIn: "native", assetOut: "native", amount: "1" },
  },
  {
    type: "buildSwap",
    msg: { type: "buildSwap", assetIn: "native", assetOut: "native", amount: "1" },
  },
  { type: "confirmSwap", msg: { type: "confirmSwap", handle: "h" } },
  {
    type: "buildAddTrustline",
    msg: { type: "buildAddTrustline", assetCode: "USDC", issuer: "GISSUER" },
  },
  { type: "confirmAddTrustline", msg: { type: "confirmAddTrustline", handle: "h" } },
  { type: "trustlines", msg: { type: "trustlines" } },
  { type: "assetSearch", msg: { type: "assetSearch", query: "usdc" } },
  {
    type: "buildRemoveTrustline",
    msg: { type: "buildRemoveTrustline", assetCode: "USDC", issuer: "GISSUER" },
  },
  {
    type: "buildCctpSend",
    msg: {
      type: "buildCctpSend",
      destinationDomain: 6,
      recipient: "0x0000000000000000000000000000000000000000",
      amount: "1",
    },
  },
  { type: "confirmCctpSend", msg: { type: "confirmCctpSend", handle: "h" } },
  { type: "cctpAttestation", msg: { type: "cctpAttestation", sourceDomain: 6, txHash: "h" } },
  { type: "buildCctpClaim", msg: { type: "buildCctpClaim", sourceDomain: 6, txHash: "h" } },
  { type: "confirmCctpClaim", msg: { type: "confirmCctpClaim", handle: "h" } },
  { type: "pendingDappRequest", msg: { type: "pendingDappRequest" } },
  {
    type: "resolveDappRequest",
    msg: { type: "resolveDappRequest", id: "x", approved: true },
  },
  { type: "currentPhase", msg: { type: "currentPhase" } },
  // The value chart. All three are refused while locked, and `valueSeries` is
  // the one that matters: it reads this account's balance history, so answering
  // it locked would tell anyone who could reach the worker how much money the
  // wallet has held and when it moved. `assetMarket` and `assetSeries` carry no
  // account at all and are public market facts, but they still go through
  // requireSession, because a locked wallet has no business making network
  // requests on the user's IP either.
  { type: "valueSeries", msg: { type: "valueSeries", range: "1W" } },
  { type: "assetMarket", msg: { type: "assetMarket", symbol: "XLM" } },
  { type: "assetSeries", msg: { type: "assetSeries", symbol: "XLM", range: "1W" } },
  // The merged public+private transaction history. Reads the account, so it is
  // refused while locked; not activity, so a background load does not postpone
  // the idle lock, exactly like the chart reads.
  { type: "history", msg: { type: "history" } },
];

/** The six the worker answers while locked. Everything else must be refused. */
export const ALLOWED_WHILE_LOCKED = [
  "status",
  "create",
  "import",
  "unlock",
  "lock",
  "recoverFromMnemonic",
];
