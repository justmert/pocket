import { useEffect, useState } from "react";
import type { ReactNode } from "react";
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
import { AssetDetailSheet } from "./sheets/AssetDetailSheet";
import { ReceiveSheet } from "./sheets/ReceiveSheet";
import { SendSheet } from "./sheets/SendSheet";
import { MoveSheet } from "./sheets/MoveSheet";
import { ConnectionsSheet, EraseSheet, NetworkSheet, RebuildSheet } from "./sheets/SettingsSheets";
import { onboardingUnfinished, placeOnboarding, raiseOnboardingTab, type Placement } from "./onboardingTab";
import { space, text, type Theme } from "./theme";

export function App() {
  return (
    <WalletProvider>
      <Root />
    </WalletProvider>
  );
}

/** the brand, centred, with whatever the wallet has to say under it. */
function Boot({ t, children }: { t: Theme; children: ReactNode }) {
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
        {children}
      </div>
    </Frame>
  );
}

/** nothing has gone wrong; the wallet has not finished answering yet. */
function Starting({ t }: { t: Theme }) {
  return (
    <Boot t={t}>
      <div
        role="status"
        aria-live="polite"
        style={{ marginTop: space.lg, display: "flex", alignItems: "center", gap: space.sm }}
      >
        <Spinner size={18} color={t.accent} />
        <span style={{ ...text.body, color: t.sub }}>Starting</span>
      </div>
    </Boot>
  );
}

/**
 * onboarding, in a window that does not close when the user looks away.
 *
 * where it runs is settled before the flow is painted, because a phrase that
 * flashes up in a window already closing is the loss this exists to prevent.
 */
function OnboardingGate({ t, onDone }: { t: Theme; onDone: () => void }) {
  const [place, setPlace] = useState<Placement | null>(null);
  useEffect(() => {
    let live = true;
    void placeOnboarding().then((where) => {
      if (live) setPlace(where);
    });
    return () => {
      live = false;
    };
  }, []);
  // null is "still deciding" and handedOff is "this window is closing". neither
  // is a window to start onboarding in.
  if (place === null || place === "handedOff") return <Starting t={t} />;
  return <Onboarding t={t} onDone={onDone} ephemeral={place === "stuck"} />;
}

/**
 * whether a phrase is on a screen somewhere, unconfirmed.
 *
 * only asked once a wallet exists, because before that the gate handles it. null
 * while the answer is unknown, which `Root` treats as "not yet" rather than
 * flashing Home and correcting itself.
 */
function useUnfinishedOnboarding(hasWallet: boolean): boolean {
  const [unfinished, setUnfinished] = useState(false);
  useEffect(() => {
    if (!hasWallet) return;
    let live = true;
    void onboardingUnfinished().then((yes) => {
      if (live) setUnfinished(yes);
    });
    return () => {
      live = false;
    };
  }, [hasWallet]);
  return unfinished;
}

/**
 * the window that is not the one holding the phrase.
 *
 * it does not offer the wallet and it does not offer onboarding: the flow is
 * already running somewhere else, and two windows both showing a recovery phrase
 * step would be its own defect. it raises that one.
 */
function FinishOnboarding({ t }: { t: Theme }) {
  return (
    <Boot t={t}>
      <div style={{ marginTop: space.lg, width: "100%" }}>
        <Notice t={t} tone="exposed">
          Your recovery phrase is still open in another tab and has not been confirmed yet. Finish
          writing it down there. Pocket cannot show it again.
        </Notice>
        <ButtonStack>
          <Button t={t} onClick={() => void raiseOnboardingTab()}>
            Go back to it
          </Button>
        </ButtonStack>
      </div>
    </Boot>
  );
}

function Root() {
  const w = useWallet();
  const t = w.t;
  const [recovering, setRecovering] = useState(false);
  const unfinished = useUnfinishedOnboarding(w.status?.initialised === true);

  if (!w.status) {
    return w.bootError ? (
      <Boot t={t}>
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
      </Boot>
    ) : (
      <Starting t={t} />
    );
  }

  if (!w.status.initialised) return <OnboardingGate t={t} onDone={() => void w.refresh()} />;

  // a wallet exists, and that is not the same as onboarding being finished.
  //
  // `create` installs the vault before the phrase is drawn, so every window
  // except the one holding the words reports a complete, unlocked wallet. a
  // toolbar click mid-transcription used to land on Home, with an address and a
  // balance — the strongest possible statement that setup is done, made while
  // the only copy of the recovery phrase was still unrecorded on another screen.
  // this window says nothing of the kind and sends the user back to the words.
  if (unfinished) return <FinishOnboarding t={t} />;

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

      <AssetDetailSheet
        asset={top === "asset" ? w.assetDetail : null}
        onClose={w.closeSheet}
        onSend={() => {
          w.closeSheet();
          w.openSheet("send");
        }}
      />
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
