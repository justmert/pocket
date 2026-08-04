// wallet state for the whole popup.
//
// one place reads the worker and one place holds what it said, so no two screens
// can disagree about the balance or about which pocket is open. every field here
// is either real or null; nothing is defaulted to zero, because "not loaded yet"
// and "you have nothing" are different facts and only one of them is about the
// user.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ReactNode } from "react";
import { call } from "./rpc";
import { stillUnresolved } from "./backgroundOps";
import {
  readAddressBook,
  addToAddressBook,
  removeFromAddressBook,
  clearAddressBook,
} from "./addressBook";
import { selectPrivateAsset, liveDetail, livePublicDetail } from "./selectAsset";
import { COPY_HOLD_MS, motion, theme, type Pocket, type Theme } from "./theme";
import type {
  PrivatePocket,
  PublicBalance,
  WalletStatus,
  YieldPosition,
} from "../../../core/messages";
import type { TxSummary } from "../../../core/provider/describe-tx";

export type Tab = "home" | "settings" | "history";

export type SheetId =
  | "asset"
  | "privateAsset"
  | "transactions"
  | "receive"
  | "send"
  | "move"
  | "moveIn"
  | "moveOut"
  // the public-pocket integrations, each a full-frame route like send: an
  // in-app swap, yield deposit/withdraw, and the two CCTP cross-chain legs.
  | "swap"
  | "yieldDeposit"
  | "yieldWithdraw"
  | "cctpSend"
  | "cctpClaim"
  // manage assets (trustlines): the list, and the directory search to add one.
  | "assets"
  | "chooseAsset"
  | "phrase"
  | "connections"
  | "network"
  | "autolock"
  | "erase"
  | "rebuild";

export interface DappRequest {
  id: string;
  origin: string;
  summary: TxSummary;
}

export interface InFlightRecord {
  hash: string;
  maxTime: number;
  /** when it was submitted; absent on a record from an earlier build. */
  at?: number;
  /** the envelope's own deadline has passed: it can never be included now. */
  windowPassed: boolean;
  /** the ledger has been asked and said it does not have it. */
  answered: boolean;
  /**
   * safe to build a replacement, which needs BOTH of the above.
   *
   * a deadline passing says nothing about whether the transaction landed
   * before it. these were one field, and the screen that offered "continue
   * anyway" offered it on the deadline alone.
   */
  expired: boolean;
}

/** what a watched transaction is doing. */
export type OpStatus = "processing" | "done" | "failed" | "unresolved";

/**
 * what `failOp` decided a caught error actually was.
 *
 * named, and exported, because it is now a value a compose screen branches on
 * rather than a private detail of the Activity row: an `unresolved` submission
 * must not be drawn in the failure colour and must not re-arm Approve.
 */
export type OpVerdict = Extract<OpStatus, "failed" | "unresolved">;

/**
 * a transaction the popup started and is still watching.
 *
 * the worker runs a confirm to its terminal on-chain state regardless of the
 * popup, so "go to background" is not a new capability: it is the popup letting
 * go of the sheet while keeping a record of what it let go of. that record lives
 * here, at the app root, so it survives the send screen unmounting. the confirm
 * promise resolves into `completeOp` from the same closure, which is what makes
 * the processing list flip to done on its own with nobody watching the sheet.
 *
 * this is a display record, not the source of truth. the chain is. a `done` op
 * is shown until its hash appears in the fetched history, then dropped: history
 * is the account of what happened, this is only the account of what we are still
 * waiting on. nothing secret is here; amounts are the public-pocket ones, and a
 * private op carries no counterparty.
 */
export interface BgOp {
  id: string;
  /** "Send", "Send privately", "Shield", "Unshield": the row's verb. */
  verb: string;
  pocket: Pocket;
  code: string;
  /** decimal string, already formatted for display. absent for an op with no
   *  amount to show, like opening the private pocket. */
  amount?: string;
  /** fiat estimate for the row's second line, when the sender had one. */
  fiat?: number | null;
  /** recipient, for a send. shielding has no counterparty to show. */
  to?: string;
  /** the network fee, already a display XLM string, for the detail's fee row. */
  fee?: string;
  network?: string;
  /**
   * `unresolved` is NOT a failure and must never be drawn as one.
   *
   * `submitAndConfirm` polls to a terminal outcome and reports `pending` when it
   * never reached one, whose own authored sentence is "It has not confirmed yet.
   * It may still land, so do not resend." That arrives at the popup as a thrown
   * error like any other, and every compose screen caught it and called
   * `failOp`, so Activity painted the wallet's own do-not-resend warning in the
   * danger colour. Telling someone a payment failed is the one instruction that
   * makes them send it again, which is how a transaction gets paid twice.
   */
  status: OpStatus;
  hash?: string;
  ledger?: number;
  error?: string;
  /** when it was submitted, for the "a moment ago" line and ordering. */
  at: number;
}

/** Exported alongside `Ctx` so a test can build a fixed wallet state. */
export interface Wallet {
  t: Theme;
  pocket: Pocket;
  setPocket(p: Pocket): void;
  /** balances blurred out for shoulder-surfing, toggled from the header menu and
   *  remembered across reopens. a display flag only; nothing here is secret. */
  hidden: boolean;
  toggleHidden(): void;

  /** saved recipient addresses (a local address book), most-recent first. */
  savedAddresses: string[];
  /** remember a recipient address, offered from a receipt after a send. */
  saveAddress(address: string): void;
  /** forget ONE saved recipient. the only removal was erasing the wallet. */
  forgetAddress(address: string): void;

  /** transactions the popup started and is still watching, newest first. */
  backgroundOps: BgOp[];
  /** record a started transaction; returns its id for the resolver to key on. */
  beginOp(op: Omit<BgOp, "id" | "status" | "at">): string;
  /** mark a watched transaction landed, with its hash and ledger. */
  completeOp(id: string, result: { hash: string; ledger?: number }): void;
  /**
   * mark a watched transaction failed, with the reason already made safe, and
   * answer whether it was a failure at all.
   *
   * `unresolved` means the worker still holds a durable in-flight record for it,
   * so the submission may yet land. A caller that draws the reason MUST draw an
   * `unresolved` one as information rather than as an error, and MUST leave its
   * approve control disabled: this is the state in which pressing it again pays
   * twice. See `BackgroundOp.status`.
   */
  failOp(id: string, error: string): Promise<OpVerdict>;
  /** forget a watched transaction (its receipt was dismissed from the sheet). */
  dropOp(id: string): void;

  status: WalletStatus | null;
  bootError: string | null;
  balances: PublicBalance[] | null;
  balanceError: string | null;
  /**
   * the private pockets, one per configured confidential asset (XLM, USDC, ...),
   * in config order. null while loading; empty when none are configured. this is
   * the plural read the multi-asset UI enumerates.
   */
  privAssets: PrivatePocket[] | null;
  /**
   * the PRIMARY private pocket (native / first configured), for the home's prompt
   * and single-asset hero. singular by design; there is NO global "selected asset"
   * any more, so nothing a form does can change what the home reads here. each form
   * (send / move / shield / unshield) picks its own asset locally.
   */
  priv: PrivatePocket | null;
  /** the private asset whose detail sheet is open (the row the user tapped), null
   *  when closed. PrivateAssetSheet reads this instead of `priv`, so it shows the
   *  tapped asset rather than the primary. */
  privateDetail: PrivatePocket | null;
  privError: string | null;
  yieldPosition: YieldPosition | null;
  /**
   * Why the yield position could not be read, if it could not.
   *
   * Separate from a null position because they mean opposite things. Null is
   * "this build has no vault configured", which is a fact about the product;
   * this is "the service did not answer", which is a fact about right now. The
   * catch here used to turn the second into the first, so a DeFindex outage
   * removed the entire Yield section from Home and the wallet looked like a
   * build that never had the feature.
   */
  yieldError: string | null;
  dappRequest: DappRequest | null;
  inFlight: InFlightRecord | null;

  refreshing: boolean;
  refresh(): Promise<void>;
  reloadStatus(): Promise<void>;
  lock(): Promise<void>;
  /** the wallet locked ITSELF while this page was open (idle timer, or the
   *  worker recycling), rather than the user pressing Lock. */
  autoLocked: boolean;
  clearDappRequest(): void;
  clearInFlight(): void;

  tab: Tab;
  setTab(tab: Tab): void;
  sheets: SheetId[];
  openSheet(id: SheetId): void;
  closeSheet(id?: SheetId): void;
  /** clear the whole sheet stack and return to the home tab. */
  goHome(): void;
  /**
   * the asset whose detail sheet is open.
   *
   * held here rather than in Home because a sheet has to render at the frame
   * level: inside the scrolling area it would scroll away with the content it
   * is supposed to be covering.
   */
  assetDetail: PublicBalance | null;
  openAsset(b: PublicBalance): void;
  /**
   * open a private asset's detail: stashes the tapped pocket in `privateDetail` and
   * raises the private-asset sheet, WITHOUT touching any global selection.
   */
  openPrivateAsset(p: PrivatePocket): void;
  /** open the move sheet (register / make spendable) FOR a specific asset. */
  openMove(p: PrivatePocket): void;
  closeAllSheets(): void;

  copied: boolean;
  copy(value: string): void;
  toast: string | null;
  /** the toast's tone: "neutral" is the default dark inverse pill; "positive" is a
   *  solid-accent success confirmation (e.g. testnet funding landed), so a success
   *  reads as the pocket's own colour rather than a generic dark box. */
  toastTone: "neutral" | "positive";
  showToast(message: string, tone?: "neutral" | "positive"): void;
}

// Exported for tests ONLY, so a screen can be rendered against a fixed wallet
// state without standing up the rpc channel and a worker. Nothing in the app
// consumes it directly; every screen goes through `useWallet`.
export const Ctx = createContext<Wallet | null>(null);

export function useWallet(): Wallet {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}

/**
 * Is the balance mask on? Answers false outside the provider.
 *
 * Non-throwing on purpose, so `Amount` can consult it without every use of that
 * component requiring a wallet around it. Onboarding renders amounts before
 * there is a session to mask.
 */
export function useHidden(): boolean {
  return useContext(Ctx)?.hidden ?? false;
}

/** the native balance, which is the one the hero shows. */
export function nativeOf(balances: PublicBalance[] | null): PublicBalance | undefined {
  return balances?.find((b) => b.id === "native");
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  // the wallet locked ITSELF while this page was open, rather than the user
  // pressing Lock. the unlock screen says so, because otherwise a wallet that
  // idle-locked mid-task simply reappeared as a password prompt with the typing
  // gone and nothing anywhere explaining either.
  const [autoLocked, setAutoLocked] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [balances, setBalances] = useState<PublicBalance[] | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [privAssets, setPrivAssets] = useState<PrivatePocket[] | null>(null);
  const [privError, setPrivError] = useState<string | null>(null);
  // the private asset whose detail sheet is open (the tapped row).
  //
  // NOT persisted and not seeded from anywhere: the first half of this comment
  // was left over from a design that did keep a selection in localStorage, and it
  // sat directly above a `useState(null)` describing the opposite. there is no
  // persisted "selected asset" any more: each form picks its own asset locally,
  // so nothing a form does bleeds into the home or the next form.
  const [privateDetail, setPrivateDetail] = useState<PrivatePocket | null>(null);
  const [yieldPosition, setYieldPosition] = useState<YieldPosition | null>(null);
  const [yieldError, setYieldError] = useState<string | null>(null);
  const [dappRequest, setDappRequest] = useState<DappRequest | null>(null);
  const [inFlight, setInFlight] = useState<InFlightRecord | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [pocket, setPocketState] = useState<Pocket>("public");
  // a display-only "hide my balance" flag, seeded from and written back to
  // localStorage so it survives the popup closing (a session-only flag would
  // un-hide every time the toolbar popup reopens, which is most of the time).
  const [hidden, setHiddenState] = useState<boolean>(() => {
    try {
      return localStorage.getItem("pocket:hideBalance") === "1";
    } catch {
      return false;
    }
  });
  const toggleHidden = useCallback(() => {
    setHiddenState((h) => {
      const next = !h;
      try {
        localStorage.setItem("pocket:hideBalance", next ? "1" : "0");
      } catch {
        /* private mode or storage disabled: the flag stays in memory for now. */
      }
      return next;
    });
  }, []);

  // saved recipient addresses: a local address book, kept in localStorage so it
  // survives the popup closing. addresses are public, so this is not vault
  // material; it is a convenience, offered from a receipt and used from the send
  // field. most-recent first, deduped, and capped so it cannot grow without bound.
  const [savedAddresses, setSavedAddresses] = useState<string[]>(readAddressBook);
  const saveAddress = useCallback((address: string) => {
    setSavedAddresses((prev) => addToAddressBook(prev, address));
  }, []);
  const forgetAddress = useCallback((address: string) => {
    setSavedAddresses((prev) => removeFromAddressBook(prev, address));
  }, []);
  // transactions the popup is still watching. session-only: the worker owns the
  // durable record (its in-flight entry and, on success, the openings), so this
  // is purely the open popup's view of what it has not seen land yet. a counter,
  // not a clock, keys them: Date.now() would tie two ops submitted in the same
  // millisecond, and the id only has to be unique within one popup lifetime.
  const [backgroundOps, setBackgroundOps] = useState<BgOp[]>([]);
  const opSeq = useRef(0);
  // a mirror `failOp` can read synchronously. it decides a verdict a caller acts
  // on, and that decision may not be made inside a state updater: an updater has
  // to be pure and react is free to run it more than once per update.
  const opsRef = useRef<BgOp[]>(backgroundOps);
  opsRef.current = backgroundOps;
  // same reason: `loadPrivate` is a `useCallback` with empty deps (adding one
  // would re-run every effect that depends on its identity), and it has to know
  // how many private assets this deployment actually has.
  const statusRef = useRef<WalletStatus | null>(null);

  const [tab, setTab] = useState<Tab>("home");
  const [sheets, setSheets] = useState<SheetId[]>([]);
  const [assetDetail, setAssetDetail] = useState<PublicBalance | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastTone, setToastTone] = useState<"neutral" | "positive">("neutral");

  const copyTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const reloadStatus = useCallback(async () => {
    try {
      setStatus(await call({ type: "status" }));
      setBootError(null);
    } catch (e) {
      setBootError(message(e));
    }
  }, []);

  const loadBalances = useCallback(async () => {
    try {
      setBalances(await call({ type: "balances" }));
      setBalanceError(null);
    } catch (e) {
      // the previous balance stays on screen rather than being replaced by a
      // zero. the error says the number is stale; a zero would be a lie.
      setBalanceError(message(e));
    }
  }, []);

  const loadPrivate = useCallback(async () => {
    try {
      // the plural read: one pocket per configured confidential asset. an older
      // worker (or a test that only stubs the singular call) has no
      // `privatePockets`, so fall back to wrapping the single primary pocket, and
      // the multi-asset UI still renders with one asset rather than none.
      let assets: PrivatePocket[];
      try {
        assets = await call({ type: "privatePockets" });
        setPrivError(null);
      } catch (plural) {
        // The fallback returns the PRIMARY asset alone, so on a multi-asset
        // wallet it is a truncated list, not an equivalent one. It was being
        // stored as though it were complete and the error cleared, so the other
        // assets simply vanished from every private screen with nothing said,
        // and the pocket the user had selected could disappear out from under
        // the selection.
        //
        // Kept, because an older worker really does lack `privatePockets` and a
        // list of one beats a list of none. Reported alongside, because a
        // silently short list of balances is the same class of lie as a zero.
        assets = [await call({ type: "privatePocket" })];
        // compared against how many the WORKER says this deployment has, not
        // against a literal 2. `assets` is a one-element array literal on the line
        // above, so `assets.length < 2` was constant-true: the incomplete-list
        // sentence right below could never render, and on a two-asset wallet the
        // second asset disappeared from every private screen while the hero
        // summed the one that was left and presented it as the pocket's total.
        // the comment above states the intent ("a silently short list of balances
        // is the same class of lie as a zero") and the guard did not implement it.
        const expected = statusRef.current?.privateAssets?.length ?? 1;
        setPrivError(
          assets.length >= expected
            ? message(plural)
            : "Pocket could not read every private asset, so this list may be incomplete.",
        );
      }
      setPrivAssets(assets);
    } catch (e) {
      setPrivError(message(e));
    }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const next = await call({ type: "status" }).catch((e) => {
        setBootError(message(e));
        return null;
      });
      if (next) {
        setStatus(next);
        statusRef.current = next;
        setBootError(null);
        // An erase must take the popup's own memory with it. `backgroundOps`,
        // the balances, the private pockets and the yield position are all held
        // in React state, and `reset` only clears the WORKER: everything here
        // survived it for as long as the popup stayed open, so creating or
        // importing a wallet straight after an erase showed the previous
        // wallet's operations, amounts and hashes under the new one's identity.
        //
        // Keyed on the transition rather than added to the erase handler, so an
        // erase reached by any other route is covered by the same line.
        if (!next.initialised) {
          setBackgroundOps([]);
          setBalances(null);
          setBalanceError(null);
          setPrivAssets(null);
          setYieldPosition(null);
          setYieldError(null);
          // The address book too, and it is the one the worker's erase sweep
          // could never have reached: it lives in the POPUP's localStorage, not
          // in `chrome.storage.local`. So erasing a wallet left the list of
          // everyone the previous owner had paid, and the next wallet created
          // on the device inherited it, offered from its own send field.
          //
          // Addresses are public on the ledger, which is why they are stored in
          // the clear; WHO THIS DEVICE PAID is not, and that is what the list
          // is.
          setSavedAddresses([]);
          clearAddressBook();
          // and the mask, which was in neither sweep. it is a display preference,
          // not a secret, but it belongs to the wallet that set it: erase with it
          // on, create a fresh wallet, and its very first Home masked every
          // figure including its own address, with the only switch buried in a
          // header overflow menu on a screen the user has never seen before.
          setHiddenState(false);
          try {
            localStorage.removeItem("pocket:hideBalance");
          } catch {
            // a storage that refuses to forget still leaves a usable wallet.
          }
        }
        if (!next.locked && next.initialised) {
          await Promise.all([
            loadBalances(),
            next.privateAvailable ? loadPrivate() : Promise.resolve(),
            call({ type: "yieldPosition" })
              .then((p) => {
                setYieldPosition(p);
                setYieldError(null);
              })
              // The position is NOT cleared. The last figure read is still the
              // best thing known about the vault, and replacing it with null
              // deletes the section rather than reporting that the refresh
              // failed, which is the same "a zero would be a lie" rule applied
              // to a whole feature.
              .catch((e: unknown) => setYieldError(message(e))),
          ]);
        }
      }
    } finally {
      setRefreshing(false);
    }
  }, [loadBalances, loadPrivate]);

  const beginOp = useCallback((op: Omit<BgOp, "id" | "status" | "at">) => {
    const id = `op-${++opSeq.current}`;
    setBackgroundOps((prev) => [{ ...op, id, status: "processing", at: Date.now() }, ...prev]);
    return id;
  }, []);
  const completeOp = useCallback(
    (id: string, result: { hash: string; ledger?: number }) => {
      setBackgroundOps((prev) =>
        prev.map((o) =>
          o.id === id ? { ...o, status: "done", hash: result.hash, ledger: result.ledger } : o,
        ),
      );
      // the money moved: pull fresh balances and history so the completed row can
      // reconcile against the chain and this watch record retire. safe to run
      // detached; refresh owns its own errors.
      void refresh();
    },
    [refresh],
  );
  const failOp = useCallback(async (id: string, error: string): Promise<OpVerdict> => {
    // Record it as failed FIRST, so the row stops spinning even if the question
    // below cannot be answered. A stuck spinner is a worse lie than a wrong
    // label, and this must not depend on a second round trip succeeding.
    setBackgroundOps((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status: "failed", error } : o)),
    );
    // Then ask the WORKER whether the submission is actually unresolved rather
    // than failed, because only the worker knows. `submitAndConfirm` clears the
    // durable in-flight record for every terminal outcome and keeps it for a
    // `pending` one (chain/submit.ts), so the record still being there IS the
    // answer, and it is authoritative in a way that matching on the error's
    // wording would not be.
    //
    // Asked here rather than at each `catch`, because there are seven compose
    // screens calling this and a defect that has to be remembered in seven
    // places is a defect that comes back with the eighth.
    //
    // The VERDICT IS RETURNED, and that is the whole point of this being async.
    // It used to be computed, applied to the Activity row, and dropped: the same
    // `catch` that called this then drew the reason as a danger notice and
    // released the one-shot guard, so nine compose screens painted the wallet's
    // own "it may still land, so do not resend" in the failure colour above a
    // re-armed Approve. The comment at the top of `BackgroundOp.status` states
    // the stake, and Activity three inches away had already been corrected.
    try {
      const held = await call({ type: "inFlight" });
      // The op is read from a ref rather than from inside the updater, because a
      // state updater must stay pure: React may invoke it more than once for one
      // update, so deciding the verdict in there would make the answer depend on
      // how often React chose to call it.
      const op = opsRef.current.find((o) => o.id === id);
      // `status: "failed"` is what the write above just set; the ref may not have
      // caught up within this tick, so the check is made against that known fact
      // rather than against whatever the ref still says.
      if (!stillUnresolved({ status: "failed", hash: op?.hash }, held)) return "failed";
      setBackgroundOps((prev) =>
        prev.map((o) =>
          o.id === id ? { ...o, status: "unresolved", hash: o.hash ?? held?.hash } : o,
        ),
      );
      // and publish the record, which is what actually takes the user somewhere
      // safe. `inFlight` was read on mount and on a lock change only, so the one
      // moment the wallet learns mid-session that a submission is unresolved was
      // the one moment it did not reach the screen built for exactly that: the
      // compose screen kept the user, and `closeConfirm` releases the one-shot
      // guard, so cancelling re-armed Approve on a payment that may already have
      // landed. `App` routes on this, so the blocking screen with its single way
      // forward takes over instead.
      setInFlight(held);
      return "unresolved";
    } catch {
      // A locked or restarting worker cannot answer. The row stays `failed`,
      // which is what it already said, and so does the verdict: an unanswerable
      // question must not become a claim that the payment is still in flight.
      return "failed";
    }
  }, []);
  const dropOp = useCallback((id: string) => {
    setBackgroundOps((prev) => prev.filter((o) => o.id !== id));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * everything the popup must forget when the session ends, however it ended.
   *
   * named and shared because it was the body of `lock()` alone, so the worker's
   * own "locked" push (the idle timer, and the port's disconnect when the worker
   * recycles) called `reloadStatus` and nothing else. the popup routed to the
   * unlock screen with the whole stack still mounted underneath, so unlocking
   * came back to it: with Settings -> Erase this wallet open, the screen that
   * returned after the password ended on the erase confirmation. the idle
   * options start at one minute.
   */
  const dropSession = useCallback(async () => {
    setBalances(null);
    setPrivAssets(null);
    setYieldPosition(null);
    setSheets([]);
    setTab("home");
    setPocketState("public");
    await reloadStatus();
  }, [reloadStatus]);

  // hold a port open to the worker while this page shows an UNLOCKED wallet.
  //
  // it moves no data. it tells the worker a wallet page is on screen, which is
  // what lets the worker keep itself alive across MV3's ~30s idle eviction
  // instead of dying under an idle popup, the death that read to the user as the
  // wallet "locking every couple of minutes". it also carries the worker's own
  // "locked" push, sent whenever the session ends: the idle lock, the Lock
  // button and an erase all announce it now, so a second open page follows the
  // first rather than showing balances for a wallet whose keys are gone.
  // originally only for the case where the fifteen-minute idle lock fires while
  // this page is still open.
  //
  // only while unlocked: a locked wallet has nothing in the worker to protect,
  // so there is no reason to keep it awake, and holding the port then would just
  // wake a worker that should be allowed to sleep.
  useEffect(() => {
    if (status?.locked !== false) return;
    const connect = chrome?.runtime?.connect;
    if (!connect) return;
    let port: chrome.runtime.Port | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const open = () => {
      if (stopped) return;
      try {
        port = connect({ name: "pocket.ui" });
      } catch {
        return;
      }
      port.onMessage.addListener((m: { type?: string }) => {
        // the worker idle-locked while we were still here: re-read status so the
        // app routes to the lock screen. that flips status.locked, which tears
        // this effect down and drops the port, which is correct.
        // the SAME teardown the Lock button runs, not just a status re-read:
        // the sheets, tab and pocket are this popup's own memory of a session
        // that is over, and `autoLocked` is what lets the unlock screen say so.
        if (m?.type === "locked") {
          setAutoLocked(true);
          void dropSession();
        }
      });
      port.onDisconnect.addListener(() => {
        port = undefined;
        // the worker recycled despite the keep-warm (a crash, or the browser
        // reclaiming it). re-read status: a fresh worker starts locked, and that
        // will tear this effect down. if we are still unlocked, reconnect so the
        // next stretch stays warm too.
        void reloadStatus();
        if (!stopped) retry = setTimeout(open, 800);
      });
    };
    open();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      // disconnecting our own end does not fire our onDisconnect, so this does
      // not trigger a reconnect; it just releases the worker.
      port?.disconnect();
    };
  }, [status?.locked, dropSession]);

  // a site waiting on a signature outranks everything the popup could show, so
  // it is checked on every mount and whenever the lock state moves.
  //
  // NOT a timer. A9-02 and A9-03 are right that these three values can change
  // under an open popup, and a three second poll closed them and cost the whole
  // suite twenty minutes of extra wall clock while clearing sheets under tests
  // that were mid-flow. The finding stands; the fix has to be cheaper than this
  // and is written up in ux/escalations.md rather than shipped half-working.
  useEffect(() => {
    void (async () => {
      try {
        setDappRequest(await call({ type: "pendingDappRequest" }));
      } catch {
        // a locked or restarting worker has nothing pending.
      }
      try {
        setInFlight(await call({ type: "inFlight" }));
      } catch {
        // the record survives; the next mount tries again.
      }
    })();
  }, [status?.locked]);

  const setPocket = useCallback((p: Pocket) => {
    setPocketState(p);
  }, []);

  const lock = useCallback(async () => {
    try {
      await call({ type: "lock" });
    } finally {
      // whatever the worker answered, this popup must stop showing balances.
      await dropSession();
    }
  }, [dropSession]);

  // the private pocket cannot be open on a deployment that has none.
  useEffect(() => {
    if (status && !status.privateAvailable && pocket === "private") setPocketState("public");
  }, [status, pocket]);

  // logged-out screens (boot, onboarding, lock, recover) wear the private pocket's
  // dark, teal identity: no pocket is chosen yet, and a dark front door reads as the
  // product's own rather than a bright default. driving it here means the body
  // background and the CSS interaction vars go dark with it, so the whole screen is
  // consistent, not just the inline styles. once unlocked, the theme follows the
  // pocket toggle again.
  const loggedOut = !status || !status.initialised || status.locked === true;
  const t = useMemo(() => theme(loggedOut ? "private" : pocket), [loggedOut, pocket]);

  useEffect(() => {
    document.body.style.margin = "0";
    document.body.style.background = t.bg;
    const root = document.documentElement;
    // the stylesheet cannot import typescript, so the tokens are handed to it
    // once rather than written out twice and left to drift.
    root.style.setProperty("--pocket-accent", t.accent);
    // read only by the wide-page rule in style.css, where the document is wider
    // than the frame and the space around it would otherwise be browser white.
    root.style.setProperty("--pocket-bg", t.bg);
    root.style.setProperty("--pocket-ring", t.ring);
    // placeholder text in the blue-tinted form fields read too light against the
    // tint; the secondary-text stop gives it real contrast without matching typed
    // text. handed to the stylesheet's ::placeholder rule, per pocket.
    root.style.setProperty("--pocket-placeholder", t.sub);
    // the quiet button's hover fill, per pocket. brightening a solid accent reads
    // as "lit", but brightening the quiet button's pale `field` fill just washes it
    // toward white and looks broken; hovering to the one-step-deeper `tint` reads as
    // interactive on both pockets (deeper on the light one, lighter on the dark).
    root.style.setProperty("--pocket-quiet-hover", t.tint);
    // the universal hover veil (`.pk-tap`): a translucent sheen laid over any fill,
    // dark on the light pocket and light on the dark one, so hovering an icon button
    // or a row reads as interactive on either surface. the skeleton sheen is exactly
    // that per-pocket translucent stop, so it doubles as the veil rather than minting
    // a second one.
    root.style.setProperty("--pocket-hover-veil", t.skeletonHi);
    // the amount slider's track and the soft halo behind its thumb, per pocket.
    root.style.setProperty("--pocket-slider-track", t.accentSoft);
    root.style.setProperty("--pocket-slider-halo", t.accentSoft);
    // the loading shimmer's two stops, per pocket: a light sheen sweeps the dark
    // canvas, a dark one the light surface, so neither pocket shows a dull smudge.
    root.style.setProperty("--pocket-skel-a", t.skeletonBase);
    root.style.setProperty("--pocket-skel-b", t.skeletonHi);
    root.style.setProperty("--pocket-enter", motion.enter);
    root.style.setProperty("--pocket-exit", motion.exit);
    root.style.setProperty("--pocket-instant", motion.instant);
    root.style.setProperty("--pocket-quick", motion.quick);
    root.style.setProperty("--pocket-page", motion.page);
    root.style.setProperty("--pocket-sheet", motion.sheet);
    root.style.setProperty("--pocket-settle", motion.settle);
    root.style.setProperty("--pocket-roll", motion.roll);
    root.style.setProperty("--pocket-pocket", motion.pocket);
    root.style.setProperty("--pocket-ambient", motion.ambient);
    root.style.setProperty("--pocket-ambient-slow", motion.ambientSlow);
    root.style.setProperty("--pocket-spin", motion.spin);
    root.style.setProperty("--pocket-spin-calm", motion.spinCalm);
    root.style.setProperty("--pocket-shimmer-calm", motion.shimmerCalm);
    root.style.colorScheme = t.dark ? "dark" : "light";
  }, [t]);

  const showToast = useCallback((m: string, tone: "neutral" | "positive" = "neutral") => {
    setToast(m);
    setToastTone(tone);
    clearTimeout(toastTimer.current);
    // scaled to what there is to read. 1800ms INCLUDES a 200ms fade in and out,
    // so a message was fully opaque for about 1.4 seconds, and the toast is the
    // whole error surface for at least one Settings row whose own comment says it
    // has "no body to grow an inline notice". a short acknowledgement keeps the
    // old dwell; a sentence gets time to be read.
    const dwell = Math.min(6000, Math.max(1800, 900 + m.length * 55));
    toastTimer.current = setTimeout(() => setToast(null), dwell);
  }, []);

  const copy = useCallback(
    (value: string) => {
      void navigator.clipboard.writeText(value).then(
        () => {
          setCopied(true);
          clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => setCopied(false), COPY_HOLD_MS);
        },
        () => showToast("Could not copy"),
      );
    },
    [showToast],
  );

  useEffect(
    () => () => {
      clearTimeout(copyTimer.current);
      clearTimeout(toastTimer.current);
    },
    [],
  );

  // opening the sheet that is already on top is not a second sheet. it used to
  // be, and then one close left the same sheet still open.
  const openSheet = useCallback(
    (id: SheetId) => setSheets((s) => (s[s.length - 1] === id ? s : [...s, id])),
    [],
  );
  /**
   * close a sheet, but only if it is still the one on top.
   *
   * this popped blindly, and two Settings sheets call `onClose()` after two
   * awaits, so a late resolution closed whatever the user had opened since:
   * Settings -> Network -> Mainnet -> dismiss -> open Auto-lock, and one to three
   * seconds later the Auto-lock sheet closed by itself. `openSheet` already
   * guards its own mirror of this and says so; nothing guarded the pop side.
   *
   * The id is optional so the many callers that legitimately mean "close me, I am
   * on top" keep working unchanged.
   */
  const closeSheet = useCallback(
    (id?: SheetId) =>
      setSheets((s) => {
        // A NON-STRING argument is a caller mistake, not an id.
        //
        // This is a `(id?: SheetId)` function, and React hands a click handler
        // the event as its first argument, so every `onClick={w.closeSheet}` in
        // the tree called it with a MouseEvent. The guard below then compared an
        // event to a string, decided this was not the sheet on top, and returned
        // the stack unchanged: the control did nothing. It was the X on every
        // titled sheet, and nothing caught it because the browser tier could not
        // run at all.
        //
        // The call sites are fixed too. This is here because the signature
        // invites the mistake and the failure is silent, and a wallet whose
        // close button quietly does nothing is not a thing to leave to
        // discipline.
        const wanted = typeof id === "string" ? id : undefined;
        return wanted && s[s.length - 1] !== wanted ? s : s.slice(0, -1);
      }),
    [],
  );
  // actually go home, from anywhere, whatever is stacked over it.
  //
  // the processing view's "Go to Home" is called its "only way out" by flow.tsx,
  // and it was wired to nine different things. seven screens handed it their own
  // `onClose`, which pops ONE sheet and never touches the tab, so leaving a Send
  // that was opened from Activity landed back on Activity; two handed it a
  // `closeConfirm` that opens with `if (busy) return`, and the processing view
  // renders only while busy, so on those two the button could not do anything at
  // all. one name, one behaviour, and the whole stack goes rather than its top.
  const goHome = useCallback(() => {
    setSheets([]);
    setTab("home");
  }, []);
  const openAsset = useCallback((b: PublicBalance) => {
    setAssetDetail(b);
    setSheets((s) => (s[s.length - 1] === "asset" ? s : [...s, "asset"]));
  }, []);
  const openPrivateAsset = useCallback((p: PrivatePocket) => {
    setPrivateDetail(p);
    setSheets((s) => (s[s.length - 1] === "privateAsset" ? s : [...s, "privateAsset"]));
  }, []);
  // the move sheet (register / make-spendable) acts on ONE asset, passed by whoever
  // opens it (the tapped asset, a blocked form's local asset, or the primary). it
  // reuses privateDetail, so there is still no global selection: MoveSheet just reads
  // the asset the opener meant, not whatever `priv` happens to be.
  const openMove = useCallback((p: PrivatePocket) => {
    setPrivateDetail(p);
    setSheets((s) => (s[s.length - 1] === "move" ? s : [...s, "move"]));
  }, []);
  const closeAllSheets = useCallback(() => setSheets([]), []);

  // the PRIMARY private asset (first configured / native), for the home only. there
  // is no global selection any more: each form picks its own asset locally, so this
  // never shifts under the home. `selectPrivateAsset` keeps it agreeing with the
  // loaded set rather than substituting a different asset silently.
  const primaryToken = status?.privateAssets?.map((a) => a.token)[0] ?? null;
  const priv = selectPrivateAsset(privAssets, primaryToken);

  // The tapped asset, resolved AGAINST THE LOADED SET on every render rather
  // than handed back as the object the row was drawn from.
  //
  // `setPrivateDetail` has two writers and both are "a row was tapped";
  // `refresh` writes `privAssets` and nothing reconciled the two. So the sheet
  // showed the pocket as it was at the moment of the tap, for as long as it was
  // open: a balance that refreshed under it, or a receive that landed, changed
  // nothing on screen. Its own header comment claims the opposite in words
  // ("it reads the live pocket off `priv` ... so a balance that refreshes, or a
  // receive that lands, updates the open sheet in place"), and MoveSheet reads
  // the same field to decide which asset it is acting on.
  //
  // While `privAssets` is null the read has not landed, and the snapshot is
  // still the best-known truth, so it stands. Once the set IS loaded the answer
  // comes from it, including when that answer is "this asset is no longer
  // there": `selectPrivateAsset` refuses to substitute a different asset, which
  // is what stops a USDC sheet quietly becoming an XLM one.
  const privateDetailLive = liveDetail(privateDetail, privAssets);

  // The same for the PUBLIC asset sheet. `setAssetDetail` has one writer, "a
  // row was tapped", and `refresh` writes `balances`: nothing reconciled them,
  // so the open sheet held the object the row was rendered from and could
  // disagree with the row it came from a moment later. Resolved by the asset's
  // own id, so an asset that leaves the list stops being drawn as present and
  // is never replaced by a different one. The snapshot stands only while the
  // balances have not been read.
  const assetDetailLive = livePublicDetail(assetDetail, balances);

  const value: Wallet = {
    t,
    pocket,
    setPocket,
    hidden,
    toggleHidden,
    savedAddresses,
    saveAddress,
    forgetAddress,
    backgroundOps,
    beginOp,
    completeOp,
    failOp,
    dropOp,
    status,
    bootError,
    balances,
    balanceError,
    privAssets,
    priv,
    privateDetail: privateDetailLive,
    privError,
    yieldPosition,
    yieldError,
    dappRequest,
    inFlight,
    refreshing,
    refresh,
    reloadStatus,
    lock,
    autoLocked,
    // RE-ASK, rather than blank. a second request parked behind the one just
    // answered never appeared, and its site was later told the user declined it,
    // because clearing simply set null and only a fresh MOUNT reads the queue.
    // this is the one-line version of E7/E8 and is neither of the alternatives D1
    // rejected: it is not a timer, it costs one message on an action the user just
    // took, and if nothing is parked the answer is null and the screen closes
    // exactly as it does today.
    clearDappRequest: () => {
      setDappRequest(null);
      void call({ type: "pendingDappRequest" })
        .then((next) => next && setDappRequest(next))
        .catch(() => {
          // nothing parked, or a worker that cannot answer: the screen is closed
          // either way, which is what clearing meant before this.
        });
    },
    clearInFlight: () => setInFlight(null),
    tab,
    setTab,
    sheets,
    openSheet,
    closeSheet,
    goHome,
    assetDetail: assetDetailLive,
    openAsset,
    openPrivateAsset,
    openMove,
    closeAllSheets,
    copied,
    copy,
    toast,
    toastTone,
    showToast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
