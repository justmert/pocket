import { useCallback, useEffect, useState } from "react";
import { call } from "./ui/rpc";
import { space, text, theme, type Scheme } from "./ui/theme";
import { Button, Frame, Loading, Notice } from "./ui/primitives";
import { Onboarding } from "./ui/screens/Onboarding";
import { Unlock } from "./ui/screens/Unlock";
import { Home } from "./ui/screens/Home";
import { Send } from "./ui/screens/Send";
import { PrivatePocket } from "./ui/screens/PrivatePocket";
import { InFlight } from "./ui/screens/InFlight";
import { Recover } from "./ui/screens/Recover";
import { DappApproval } from "./ui/screens/DappApproval";
import type { TxSummary } from "../../core/provider/describe-tx";
import type { WalletStatus } from "../../core/messages";

export function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [view, setView] = useState<"home" | "send" | "private">("home");
  const [recovering, setRecovering] = useState(false);
  const [dappRequest, setDappRequest] = useState<{
    id: string;
    origin: string;
    summary: TxSummary;
  } | null>(null);
  const [unresolved, setUnresolved] = useState<{
    hash: string;
    maxTime: number;
    expired: boolean;
  } | null>(null);
  const [scheme, setScheme] = useState<Scheme>(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const t = theme(scheme);

  // A worker that never answers used to leave the popup spinning forever, with
  // no way to tell a slow start from a dead one.
  const refresh = useCallback(async () => {
    try {
      setStatus(await call({ type: "status" }));
      setBootError(null);
    } catch (e) {
      setBootError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    const onChange = (e: MediaQueryListEvent) => setScheme(e.matches ? "dark" : "light");
    mq?.addEventListener("change", onChange);
    return () => mq?.removeEventListener("change", onChange);
  }, [refresh]);

  useEffect(() => {
    document.body.style.margin = "0";
    document.body.style.background = t.bg;
    // The stylesheet needs the accent for the focus ring, and the accent is
    // chosen in TypeScript, so hand it over rather than duplicating the hex.
    const root = document.documentElement;
    root.style.setProperty("--pocket-accent", t.accent);
    root.style.setProperty("--pocket-bg", t.bg);
    root.style.colorScheme = t.scheme;
  }, [t.bg, t.accent, t.scheme]);

  // Checked on every mount. MV3 kills the worker aggressively, so a poll
  // interrupted mid-flight is a normal event rather than an edge case.
  // A site asking for a signature outranks everything else the popup could
  // show: the page is blocked waiting, and a request that sits unseen times
  // out as a refusal.
  useEffect(() => {
    void (async () => {
      try {
        setDappRequest(await call({ type: "pendingDappRequest" }));
      } catch {
        // A locked or restarting worker simply has nothing pending.
      }
    })();
  }, [status?.locked]);

  useEffect(() => {
    void (async () => {
      try {
        setUnresolved(await call({ type: "inFlight" }));
      } catch {
        // A failed check must not block the wallet; the record survives and
        // the next mount tries again.
      }
    })();
  }, [status?.locked]);

  if (!status) {
    return (
      <Frame t={t}>
        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            padding: space.gutter,
          }}
        >
          <div style={{ ...text.title, marginBottom: space.lg }}>Pocket</div>
          {bootError ? (
            <>
              <Notice tone="danger" t={t}>
                {bootError}
              </Notice>
              <Button t={t} onClick={() => void refresh()}>
                Try again
              </Button>
            </>
          ) : (
            <Loading label="Starting…" t={t} />
          )}
        </div>
      </Frame>
    );
  }

  if (!status.initialised) return <Onboarding t={t} onDone={() => void refresh()} />;
  if (status.locked) {
    return recovering ? (
      <Recover
        t={t}
        onDone={() => {
          setRecovering(false);
          void refresh();
        }}
        onCancel={() => setRecovering(false)}
      />
    ) : (
      <Unlock t={t} onUnlocked={() => void refresh()} onForgot={() => setRecovering(true)} />
    );
  }
  // A transaction whose outcome the worker never saw, because it died mid-poll
  // or the popup closed. Shown before anything else: without it a user builds a
  // second payment while the first may still land, and pays twice.
  if (dappRequest) {
    return <DappApproval t={t} request={dappRequest} onDone={() => setDappRequest(null)} />;
  }
  if (unresolved) {
    return (
      <InFlight
        t={t}
        record={unresolved}
        onResolved={() => {
          setUnresolved(null);
          void refresh();
        }}
      />
    );
  }
  if (view === "send") return <Send t={t} onBack={() => setView("home")} />;
  if (view === "private") return <PrivatePocket t={t} onBack={() => setView("home")} />;

  return (
    <Home
      t={t}
      status={status}
      onSend={() => setView("send")}
      onPrivate={() => setView("private")}
      onLock={async () => {
        await call({ type: "lock" });
        await refresh();
      }}
    />
  );
}
