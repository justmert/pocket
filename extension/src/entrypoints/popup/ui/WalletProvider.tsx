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
import { motion, theme, type Pocket, type Theme } from "./theme";
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
  expired: boolean;
}

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
  status: "processing" | "done" | "failed";
  hash?: string;
  ledger?: number;
  error?: string;
  /** when it was submitted, for the "a moment ago" line and ordering. */
  at: number;
}

interface Wallet {
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

  /** transactions the popup started and is still watching, newest first. */
  backgroundOps: BgOp[];
  /** record a started transaction; returns its id for the resolver to key on. */
  beginOp(op: Omit<BgOp, "id" | "status" | "at">): string;
  /** mark a watched transaction landed, with its hash and ledger. */
  completeOp(id: string, result: { hash: string; ledger?: number }): void;
  /** mark a watched transaction failed, with the reason already made safe. */
  failOp(id: string, error: string): void;
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
   * the private pocket a form acts on: the selected asset's pocket, or the
   * primary one. singular by design, because every op runs against exactly one
   * asset. kept for the many consumers that read one pocket; it is now whichever
   * asset `privateAsset` names.
   */
  priv: PrivatePocket | null;
  /** the selected private asset's wrapper token, passed as `asset` on every
   *  private op. defaults to the primary (first configured) asset. */
  privateAsset: string | null;
  /** choose which private asset the next private op runs against. */
  setPrivateAsset(token: string): void;
  privError: string | null;
  yieldPosition: YieldPosition | null;
  dappRequest: DappRequest | null;
  inFlight: InFlightRecord | null;

  refreshing: boolean;
  refresh(): Promise<void>;
  reloadStatus(): Promise<void>;
  lock(): Promise<void>;
  clearDappRequest(): void;
  clearInFlight(): void;

  tab: Tab;
  setTab(tab: Tab): void;
  sheets: SheetId[];
  openSheet(id: SheetId): void;
  closeSheet(): void;
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
   * open a private asset's detail. selects it (so the sheet and any op it starts
   * act on that asset) and raises the private-asset sheet. the sheet reads the
   * live pocket off `priv`, so it stays in step as balances refresh.
   */
  openPrivateAsset(p: PrivatePocket): void;
  closeAllSheets(): void;

  copied: boolean;
  copy(value: string): void;
  toast: string | null;
  showToast(message: string): void;
}

const Ctx = createContext<Wallet | null>(null);

export function useWallet(): Wallet {
  const w = useContext(Ctx);
  if (!w) throw new Error("useWallet outside WalletProvider");
  return w;
}

/** the native balance, which is the one the hero shows. */
export function nativeOf(balances: PublicBalance[] | null): PublicBalance | undefined {
  return balances?.find((b) => b.id === "native");
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [balances, setBalances] = useState<PublicBalance[] | null>(null);
  const [balanceError, setBalanceError] = useState<string | null>(null);
  const [privAssets, setPrivAssets] = useState<PrivatePocket[] | null>(null);
  const [privError, setPrivError] = useState<string | null>(null);
  // which confidential asset a private op runs against, by wrapper token. seeded
  // from localStorage so the choice survives a reopen; reconciled against the
  // configured set once status loads (a token no longer configured falls back to
  // the primary). null until then, which every consumer reads as "the primary".
  const [privateAsset, setPrivateAssetState] = useState<string | null>(() => {
    try {
      return localStorage.getItem("pocket:privateAsset");
    } catch {
      return null;
    }
  });
  const setPrivateAsset = useCallback((token: string) => {
    setPrivateAssetState(token);
    try {
      localStorage.setItem("pocket:privateAsset", token);
    } catch {
      /* storage disabled: the choice stays in memory for this session. */
    }
  }, []);
  const [yieldPosition, setYieldPosition] = useState<YieldPosition | null>(null);
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
  const [savedAddresses, setSavedAddresses] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem("pocket:savedAddresses");
      const list: unknown = raw ? JSON.parse(raw) : [];
      return Array.isArray(list) ? list.filter((a): a is string => typeof a === "string") : [];
    } catch {
      return [];
    }
  });
  const saveAddress = useCallback((address: string) => {
    const addr = address.trim();
    if (!addr) return;
    setSavedAddresses((prev) => {
      const next = [addr, ...prev.filter((a) => a !== addr)].slice(0, 20);
      try {
        localStorage.setItem("pocket:savedAddresses", JSON.stringify(next));
      } catch {
        /* storage disabled: the list stays in memory for this session. */
      }
      return next;
    });
  }, []);
  // transactions the popup is still watching. session-only: the worker owns the
  // durable record (its in-flight entry and, on success, the openings), so this
  // is purely the open popup's view of what it has not seen land yet. a counter,
  // not a clock, keys them: Date.now() would tie two ops submitted in the same
  // millisecond, and the id only has to be unique within one popup lifetime.
  const [backgroundOps, setBackgroundOps] = useState<BgOp[]>([]);
  const opSeq = useRef(0);

  const [tab, setTab] = useState<Tab>("home");
  const [sheets, setSheets] = useState<SheetId[]>([]);
  const [assetDetail, setAssetDetail] = useState<PublicBalance | null>(null);
  const [copied, setCopied] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

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
      } catch {
        assets = [await call({ type: "privatePocket" })];
      }
      setPrivAssets(assets);
      setPrivError(null);
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
        setBootError(null);
        if (!next.locked && next.initialised) {
          await Promise.all([
            loadBalances(),
            next.privateAvailable ? loadPrivate() : Promise.resolve(),
            call({ type: "yieldPosition" })
              .then(setYieldPosition)
              .catch(() => setYieldPosition(null)),
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
  const failOp = useCallback((id: string, error: string) => {
    setBackgroundOps((prev) =>
      prev.map((o) => (o.id === id ? { ...o, status: "failed", error } : o)),
    );
  }, []);
  const dropOp = useCallback((id: string) => {
    setBackgroundOps((prev) => prev.filter((o) => o.id !== id));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // hold a port open to the worker while this page shows an UNLOCKED wallet.
  //
  // it moves no data. it tells the worker a wallet page is on screen, which is
  // what lets the worker keep itself alive across MV3's ~30s idle eviction
  // instead of dying under an idle popup, the death that read to the user as the
  // wallet "locking every couple of minutes". it also carries the worker's own
  // "locked" push, for the case where the fifteen-minute idle lock fires while
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
        if (m?.type === "locked") void reloadStatus();
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
  }, [status?.locked, reloadStatus]);

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
      setBalances(null);
      setPrivAssets(null);
      setYieldPosition(null);
      setSheets([]);
      setTab("home");
      setPocketState("public");
      await reloadStatus();
    }
  }, [reloadStatus]);

  // the private pocket cannot be open on a deployment that has none.
  useEffect(() => {
    if (status && !status.privateAvailable && pocket === "private") setPocketState("public");
  }, [status, pocket]);

  const t = useMemo(() => theme(pocket), [pocket]);

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

  const showToast = useCallback((m: string) => {
    setToast(m);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  const copy = useCallback(
    (value: string) => {
      void navigator.clipboard.writeText(value).then(
        () => {
          setCopied(true);
          clearTimeout(copyTimer.current);
          copyTimer.current = setTimeout(() => setCopied(false), 1400);
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
  const closeSheet = useCallback(() => setSheets((s) => s.slice(0, -1)), []);
  const openAsset = useCallback((b: PublicBalance) => {
    setAssetDetail(b);
    setSheets((s) => (s[s.length - 1] === "asset" ? s : [...s, "asset"]));
  }, []);
  const openPrivateAsset = useCallback(
    (p: PrivatePocket) => {
      // no token on the fallback single-pocket read: nothing to select, and the
      // one asset is already what `priv` resolves to.
      if (p.token) setPrivateAsset(p.token);
      setSheets((s) => (s[s.length - 1] === "privateAsset" ? s : [...s, "privateAsset"]));
    },
    [setPrivateAsset],
  );
  const closeAllSheets = useCallback(() => setSheets([]), []);

  // the effective selected asset token: the stored choice if it is still one of
  // the configured assets, else the primary (first). status.privateAssets is the
  // config list, present even while the per-asset balances are still loading, so
  // the selection resolves before privAssets does.
  const configuredTokens = status?.privateAssets?.map((a) => a.token) ?? [];
  const effectiveAsset =
    privateAsset && configuredTokens.includes(privateAsset)
      ? privateAsset
      : (configuredTokens[0] ?? null);
  // the one pocket a form acts on, derived so it always agrees with the loaded
  // set and the current selection. the fallback single-pocket read carries no
  // token, so match on token first and fall back to the first loaded pocket.
  const priv =
    privAssets && privAssets.length > 0
      ? (privAssets.find((p) => p.token === effectiveAsset) ?? privAssets[0]!)
      : null;

  const value: Wallet = {
    t,
    pocket,
    setPocket,
    hidden,
    toggleHidden,
    savedAddresses,
    saveAddress,
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
    privateAsset: effectiveAsset,
    setPrivateAsset,
    privError,
    yieldPosition,
    dappRequest,
    inFlight,
    refreshing,
    refresh,
    reloadStatus,
    lock,
    clearDappRequest: () => setDappRequest(null),
    clearInFlight: () => setInFlight(null),
    tab,
    setTab,
    sheets,
    openSheet,
    closeSheet,
    assetDetail,
    openAsset,
    openPrivateAsset,
    closeAllSheets,
    copied,
    copy,
    toast,
    showToast,
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
