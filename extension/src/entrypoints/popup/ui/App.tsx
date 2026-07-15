import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { WalletProvider, useWallet } from "./WalletProvider";
import { Button, ButtonStack, Frame, Notice, Spinner, Toast } from "./primitives";
import { Logo } from "./Brand";
import { ErrorBoundary } from "./ErrorBoundary";
import { BottomNav } from "./BottomNav";
import { Home } from "./screens/Home";
import { History } from "./screens/History";
import { Settings } from "./screens/Settings";
import { Onboarding } from "./screens/Onboarding";
import { Unlock } from "./screens/Unlock";
import { Recover } from "./screens/Recover";
import { InFlight } from "./screens/InFlight";
import { DappApproval } from "./screens/DappApproval";
import { AssetDetailSheet } from "./sheets/AssetDetailSheet";
import { PrivateAssetSheet } from "./sheets/PrivateAssetSheet";
import { TransactionsSheet } from "./screens/History";
import { ReceiveSheet } from "./sheets/ReceiveSheet";
import { Send } from "./screens/Send";
import { Move } from "./screens/Move";
import { Swap } from "./screens/Swap";
import { Yield } from "./screens/Yield";
import { CctpSend } from "./screens/CctpSend";
import { CctpClaim } from "./screens/CctpClaim";
import { ManageAssets } from "./screens/ManageAssets";
import { ChooseAsset } from "./screens/ChooseAsset";
import { MoveSheet } from "./sheets/MoveSheet";
import {
  AutoLockSheet,
  ConnectionsSheet,
  EraseSheet,
  NetworkSheet,
  PhraseSheet,
  RebuildSheet,
} from "./sheets/SettingsSheets";
import {
  clearOnboardingUnfinished,
  onboardingUnfinished,
  placeOnboarding,
  raiseOnboardingTab,
  type Placement,
} from "./onboardingTab";
import { space, text, type Theme } from "./theme";

export function App() {
  return (
    // OUTSIDE the provider on purpose: the provider is the component that talks
    // to the worker on mount, so it can throw too, and a boundary inside it
    // would not catch that.
    <ErrorBoundary>
      <WalletProvider>
        <Root />
      </WalletProvider>
    </ErrorBoundary>
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
        <Logo t={t} width={168} />
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
function useUnfinishedOnboarding(hasWallet: boolean): {
  unfinished: boolean;
  /** the user acknowledged the phrase is unconfirmed and asked for the wallet. */
  release: () => void;
} {
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
  // the effect keys on `hasWallet`, which does not change when the marker is
  // cleared, so nothing would re-read storage and the screen would stay put
  // after the one press meant to leave it.
  return { unfinished, release: () => setUnfinished(false) };
}

/**
 * the window that is not the one holding the phrase.
 *
 * it does not offer the wallet and it does not offer onboarding: the flow is
 * already running somewhere else, and two windows both showing a recovery phrase
 * step would be its own defect. it raises that one.
 *
 * and when there is no longer one to raise, it says so and lets the user out.
 * this screen stands in front of the ENTIRE wallet and its marker lives in
 * session storage, so for as long as the browser stays open there was no way
 * past it: the single control called a function that answered "the tab is gone"
 * and then discarded the answer, so the press did nothing, every time. the user
 * has a complete unlocked vault, a password they just chose, and a phrase that
 * Settings can still show them, and could reach none of it without quitting
 * chrome.
 *
 * the way out is deliberately a SECOND press, on a control that says what it
 * costs, and it is offered only once raising has actually been tried and failed.
 * clearing the marker on its own is what must not happen: that is the wallet
 * presenting itself as finished while the phrase has never been written down,
 * which is the failure `markOnboardingUnfinished` exists to prevent.
 */
function FinishOnboarding({ t, onContinue }: { t: Theme; onContinue: () => void }) {
  // null until the user has asked. false only once a raise has been attempted
  // and the tab turned out to be gone, so the "gone" copy is never shown on a
  // guess.
  const [raised, setRaised] = useState<boolean | null>(null);
  const [raising, setRaising] = useState(false);

  const go = async () => {
    setRaising(true);
    const ok = await raiseOnboardingTab();
    // on success this window is already closing, so there is no state to set.
    if (!ok) {
      setRaised(false);
      setRaising(false);
    }
  };

  const leave = async () => {
    await clearOnboardingUnfinished();
    onContinue();
  };

  return (
    <Boot t={t}>
      <div style={{ marginTop: space.lg, width: "100%" }}>
        {raised === false ? (
          <>
            <Notice t={t} tone="exposed">
              That tab is gone, so your recovery phrase was never confirmed. Your wallet itself is
              safe. Open Settings, then Recovery phrase, to see the words again and write them down.
            </Notice>
            <ButtonStack>
              <Button t={t} onClick={() => void leave()}>
                Continue to the wallet
              </Button>
            </ButtonStack>
          </>
        ) : (
          <>
            <Notice t={t} tone="exposed">
              Your recovery phrase is still open in another tab and has not been confirmed yet.
              Finish writing it down there.
            </Notice>
            <ButtonStack>
              <Button t={t} busy={raising} onClick={() => void go()}>
                Go back to it
              </Button>
            </ButtonStack>
          </>
        )}
      </div>
    </Boot>
  );
}

function Root() {
  const w = useWallet();
  const t = w.t;
  const [recovering, setRecovering] = useState(false);
  const { unfinished, release } = useUnfinishedOnboarding(w.status?.initialised === true);

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
  if (unfinished) return <FinishOnboarding t={t} onContinue={release} />;

  if (w.status.locked) {
    return recovering ? (
      <Recover
        t={t}
        onDone={() => {
          setRecovering(false);
          void w.refresh();
        }}
        onCancel={() => setRecovering(false)}
      />
    ) : (
      <Unlock t={t} onUnlocked={() => void w.refresh()} onForgot={() => setRecovering(true)} />
    );
  }

  // a transaction whose outcome nobody saw. shown before any screen that could
  // build a second one, and that INCLUDES the dApp approval below it.
  //
  // these two were the other way round, and the two files each claimed the
  // precedence: InFlight says "this screen exists to stop a second one being
  // sent. it outranks every other view for that reason", while the dApp branch
  // justified itself as outranking "anything the user could have opened the popup
  // for", which an unresolved submission is not. only one of them could be right.
  //
  // the worker does not close the gap either: `assertNothingUnresolved` guards
  // seven in-wallet build sites and the SEP-43 `signTransaction` path calls it
  // nowhere, so a site could have its transaction signed over the top of a
  // submission the wallet had already told the user not to repeat.
  //
  // the cost is real and is the trade the wallet already makes when locked: the
  // site's request waits and is answered as declined if the user does not resolve
  // this in time.
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

  // a site is blocked waiting on an answer, so it outranks anything the user
  // could have opened the popup for.
  if (w.dappRequest) {
    return <DappApproval t={t} request={w.dappRequest} onDone={w.clearDappRequest} />;
  }

  return <Shell />;
}

function Shell() {
  const w = useWallet();
  const t = w.t;
  const top = w.sheets[w.sheets.length - 1];

  // send is a ROUTE, not a sheet: it fills the frame and replaces what is
  // behind it. it still lives on the sheet stack so that every existing
  // `openSheet("send")` call site, the bottom bar and the asset detail among
  // them, keeps working and so that close and escape behave as they always did.
  if (top === "send") return <Send onClose={w.closeSheet} />;

  // move-in / move-out are pages too, not popups: the same full-frame compose
  // step as Send, since to the user this is a send between their own pockets.
  if (top === "moveIn") return <Move kind="shield" onClose={w.closeSheet} />;
  if (top === "moveOut") return <Move kind="unshield" onClose={w.closeSheet} />;

  // the public-pocket integrations are full-frame compose pages too, wired
  // exactly like send: they live on the sheet stack so open/close and escape
  // behave the same, and each fills the frame over what is behind it.
  if (top === "swap") return <Swap onClose={w.closeSheet} />;
  if (top === "yieldDeposit") return <Yield kind="deposit" onClose={w.closeSheet} />;
  if (top === "yieldWithdraw") return <Yield kind="withdraw" onClose={w.closeSheet} />;
  if (top === "cctpSend") return <CctpSend onClose={w.closeSheet} />;
  if (top === "cctpClaim") return <CctpClaim onClose={w.closeSheet} />;
  if (top === "assets") return <ManageAssets onClose={w.closeSheet} />;
  if (top === "chooseAsset") return <ChooseAsset onClose={w.closeSheet} />;

  return (
    <Frame t={t}>
      {w.tab === "home" ? <Home /> : w.tab === "history" ? <History /> : <Settings />}

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
      <PrivateAssetSheet open={top === "privateAsset"} onClose={w.closeSheet} />
      <TransactionsSheet open={top === "transactions"} onClose={w.closeSheet} />
      <MoveSheet open={top === "move"} onClose={w.closeSheet} />
      <NetworkSheet open={top === "network"} onClose={w.closeSheet} />
      <AutoLockSheet open={top === "autolock"} onClose={w.closeSheet} />
      <ConnectionsSheet open={top === "connections"} onClose={w.closeSheet} />
      <RebuildSheet open={top === "rebuild"} onClose={w.closeSheet} />
      <PhraseSheet open={top === "phrase"} onClose={w.closeSheet} />
      <EraseSheet open={top === "erase"} onClose={w.closeSheet} />

      <Toast t={t} message={w.toast} tone={w.toastTone} />
    </Frame>
  );
}
