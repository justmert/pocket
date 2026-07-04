import { useState } from "react";
import { WalletProvider, useWallet } from "./WalletProvider";
import { Button, ButtonStack, Frame, Notice, Spinner, Toast } from "./primitives";
import { BrandRow } from "./Brand";
import { BottomNav } from "./BottomNav";
import { Home } from "./screens/Home";
import { Settings } from "./screens/Settings";
import { Onboarding } from "./screens/Onboarding";
import { Unlock } from "./screens/Unlock";
import { Recover } from "./screens/Recover";
import { InFlight } from "./screens/InFlight";
import { DappApproval } from "./screens/DappApproval";
import { ReceiveSheet } from "./sheets/ReceiveSheet";
import { SendSheet } from "./sheets/SendSheet";
import { MoveSheet } from "./sheets/MoveSheet";
import { ConnectionsSheet, EraseSheet, NetworkSheet, RebuildSheet } from "./sheets/SettingsSheets";
import { space, text } from "./theme";

export function App() {
  return (
    <WalletProvider>
      <Root />
    </WalletProvider>
  );
}

function Root() {
  const w = useWallet();
  const t = w.t;
  const [recovering, setRecovering] = useState(false);

  if (!w.status) {
    return (
      <Frame t={t}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: space.gutter,
            background: t.canvas,
          }}
        >
          <BrandRow t={t} size={56} />
          {w.bootError ? (
            <div style={{ marginTop: space.lg, width: "100%" }}>
              <Notice t={t} tone="danger">
                {w.bootError}
              </Notice>
              <ButtonStack>
                <Button t={t} onClick={() => void w.refresh()}>
                  Try again
                </Button>
              </ButtonStack>
            </div>
          ) : (
            <div
              role="status"
              aria-live="polite"
              style={{ marginTop: space.lg, display: "flex", alignItems: "center", gap: space.sm }}
            >
              <Spinner size={18} color={t.accent} />
              <span style={{ ...text.body, color: t.sub }}>Starting</span>
            </div>
          )}
        </div>
      </Frame>
    );
  }

  if (!w.status.initialised) return <Onboarding t={t} onDone={() => void w.refresh()} />;

  if (w.status.locked) {
    return recovering ? (
      <Recover
        t={t}
        network={w.status.network}
        onDone={() => {
          setRecovering(false);
          void w.refresh();
        }}
        onCancel={() => setRecovering(false)}
      />
    ) : (
      <Unlock
        t={t}
        onUnlocked={() => void w.refresh()}
        onForgot={() => setRecovering(true)}
      />
    );
  }

  // a site is blocked waiting on an answer, so it outranks anything the user
  // could have opened the popup for.
  if (w.dappRequest) {
    return <DappApproval t={t} request={w.dappRequest} onDone={w.clearDappRequest} />;
  }

  // a transaction whose outcome nobody saw. shown before any screen that could
  // build a second one.
  if (w.inFlight) {
    return (
      <InFlight
        t={t}
        record={w.inFlight}
        onResolved={() => {
          w.clearInFlight();
          void w.refresh();
        }}
      />
    );
  }

  return <Shell />;
}

function Shell() {
  const w = useWallet();
  const t = w.t;
  const top = w.sheets[w.sheets.length - 1];

  return (
    <Frame t={t}>
      {w.tab === "home" ? <Home /> : <Settings />}

      <BottomNav />

      <ReceiveSheet open={top === "receive"} onClose={w.closeSheet} />
      <SendSheet open={top === "send"} onClose={w.closeSheet} />
      <MoveSheet open={top === "move"} onClose={w.closeSheet} />
      <NetworkSheet open={top === "network"} onClose={w.closeSheet} />
      <ConnectionsSheet open={top === "connections"} onClose={w.closeSheet} />
      <RebuildSheet open={top === "rebuild"} onClose={w.closeSheet} />
      <EraseSheet open={top === "erase"} onClose={w.closeSheet} />

      {w.toast && <Toast t={t}>{w.toast}</Toast>}

      {/* the pocket switch. keyed on the flip count so it replays every time,
          and it rides over the frame's own background crossfade. */}
      {w.pocketFlip > 0 && (
        // the wash scales past the frame on purpose, and a transformed
        // descendant counts toward its ancestor's scrollable area. without this
        // clip the frame itself became scrollable, and the first thing that
        // scrolled an input into view took the bottom bar and the open sheet off
        // screen with it.
        <div
          aria-hidden
          style={{ position: "absolute", inset: 0, overflow: "hidden", zIndex: 70, pointerEvents: "none" }}
        >
          <div
            key={w.pocketFlip}
            aria-hidden
            className="pocket-wash"
            style={{
              position: "absolute",
              inset: 0,
              background: `radial-gradient(circle at 50% 18%, ${t.accent}55, transparent 58%)`,
            }}
          />
        </div>
      )}
    </Frame>
  );
}
