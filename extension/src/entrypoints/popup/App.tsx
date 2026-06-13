import { useCallback, useEffect, useState } from "react";
import { call } from "./ui/rpc";
import { theme, type Scheme } from "./ui/theme";
import { Frame, Spinner } from "./ui/primitives";
import { Onboarding } from "./ui/screens/Onboarding";
import { Unlock } from "./ui/screens/Unlock";
import { Home } from "./ui/screens/Home";
import { Send } from "./ui/screens/Send";
import { PrivatePocket } from "./ui/screens/PrivatePocket";
import { InFlight } from "./ui/screens/InFlight";
import { Recover } from "./ui/screens/Recover";
import type { WalletStatus } from "../../core/messages";

export function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [view, setView] = useState<"home" | "send" | "private">("home");
  const [recovering, setRecovering] = useState(false);
  const [unresolved, setUnresolved] = useState<{
    hash: string;
    maxTime: number;
    expired: boolean;
  } | null>(null);
  const [scheme, setScheme] = useState<Scheme>(
    window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light",
  );
  const t = theme(scheme);

  const refresh = useCallback(async () => {
    setStatus(await call({ type: "status" }));
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
  }, [t.bg]);

  // Checked on every mount. MV3 kills the worker aggressively, so a poll
  // interrupted mid-flight is a normal event rather than an edge case.
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
        <div style={{ flex: 1, display: "grid", placeItems: "center" }}>
          <Spinner t={t} />
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
