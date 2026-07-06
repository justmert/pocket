// wallet state for the whole popup.
//
// one place reads the worker and one place holds what it said, so no two screens
// can disagree about the balance or about which pocket is open. every field here
// is either real or null; nothing is defaulted to zero, because "not loaded yet"
// and "you have nothing" are different facts and only one of them is about the
// user.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
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

export type Tab = "home" | "settings";

export type SheetId =
  | "receive"
  | "send"
  | "move"
  | "phrase"
  | "connections"
  | "network"
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

interface Wallet {
  t: Theme;
  pocket: Pocket;
  setPocket(p: Pocket): void;
  /** bumps on every pocket change so the wash can replay. */
  pocketFlip: number;

  status: WalletStatus | null;
  bootError: string | null;
  balances: PublicBalance[] | null;
  balanceError: string | null;
  priv: PrivatePocket | null;
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
  const [priv, setPriv] = useState<PrivatePocket | null>(null);
  const [privError, setPrivError] = useState<string | null>(null);
  const [yieldPosition, setYieldPosition] = useState<YieldPosition | null>(null);
  const [dappRequest, setDappRequest] = useState<DappRequest | null>(null);
  const [inFlight, setInFlight] = useState<InFlightRecord | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [pocket, setPocketState] = useState<Pocket>("public");
  const [pocketFlip, setPocketFlip] = useState(0);
  const [tab, setTab] = useState<Tab>("home");
  const [sheets, setSheets] = useState<SheetId[]>([]);
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
      setPriv(await call({ type: "privatePocket" }));
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

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // a site waiting on a signature outranks everything the popup could show, so
  // it is checked on every mount and whenever the lock state moves.
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
    setPocketState((current) => {
      if (current !== p) setPocketFlip((n) => n + 1);
      return p;
    });
  }, []);

  const lock = useCallback(async () => {
    try {
      await call({ type: "lock" });
    } finally {
      // whatever the worker answered, this popup must stop showing balances.
      setBalances(null);
      setPriv(null);
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
    root.style.setProperty("--pocket-ring", t.ring);
    root.style.setProperty("--pocket-enter", motion.enter);
    root.style.setProperty("--pocket-exit", motion.exit);
    root.style.setProperty("--pocket-wash-ease", motion.wash);
    root.style.setProperty("--pocket-instant", motion.instant);
    root.style.setProperty("--pocket-quick", motion.quick);
    root.style.setProperty("--pocket-page", motion.page);
    root.style.setProperty("--pocket-page-out", motion.pageOut);
    root.style.setProperty("--pocket-sheet", motion.sheet);
    root.style.setProperty("--pocket-sheet-out", motion.sheetOut);
    root.style.setProperty("--pocket-settle", motion.settle);
    root.style.setProperty("--pocket-pocket", motion.pocket);
    root.style.setProperty("--pocket-ambient", motion.ambient);
    root.style.setProperty("--pocket-ambient-slow", motion.ambientSlow);
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
  const closeAllSheets = useCallback(() => setSheets([]), []);

  const value: Wallet = {
    t,
    pocket,
    setPocket,
    pocketFlip,
    status,
    bootError,
    balances,
    balanceError,
    priv,
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
