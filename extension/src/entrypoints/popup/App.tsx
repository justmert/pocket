import { useCallback, useEffect, useState } from "react";
import { call } from "./ui/rpc";
import { theme, type Scheme } from "./ui/theme";
import { Frame, Spinner } from "./ui/primitives";
import { Onboarding } from "./ui/screens/Onboarding";
import { Unlock } from "./ui/screens/Unlock";
import { Home } from "./ui/screens/Home";
import { Send } from "./ui/screens/Send";
import { PrivatePocket } from "./ui/screens/PrivatePocket";
import type { WalletStatus } from "../../core/messages";

export function App() {
  const [status, setStatus] = useState<WalletStatus | null>(null);
  const [view, setView] = useState<"home" | "send" | "private">("home");
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
  if (status.locked) return <Unlock t={t} onUnlocked={() => void refresh()} />;
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
