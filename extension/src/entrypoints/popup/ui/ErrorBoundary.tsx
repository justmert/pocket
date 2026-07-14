// the last thing between a render throw and a blank 384x600 rectangle.
//
// there was no boundary anywhere in the popup, so any throw during render
// unmounted the whole tree: `#root.childElementCount` goes to 0, `body.innerText`
// to "", and because the frame is the node chrome sizes the popup from, the
// window collapses with it. what the user sees is an empty coloured box in front
// of their money, which is indistinguishable from a broken install.
//
// this catches at the OUTERMOST point, outside `WalletProvider`, because the
// provider is the one component that talks to the worker on mount and is
// therefore as able to throw as anything it wraps.
//
// TWO RULES, both deliberate:
//
//   1. the sentence is a FIXED STRING and never `error.message`. core/dispatch.ts
//      keeps an allowlist by error NAME for exactly this reason: an arbitrary
//      message can carry an RPC URL, a stack fragment, or witness material, and
//      this component has no way to tell a safe message from an unsafe one.
//   2. it does not offer to "continue anyway". re-rendering the tree that just
//      threw is how a boundary turns one broken screen into a loop, and a wallet
//      may not invite a retry it cannot promise anything about. reloading the
//      popup is the honest move: keys live in the worker, so nothing is lost.
import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";
import { Button, ButtonStack, Frame, Notice } from "./primitives";
import { Logo } from "./Brand";
import { space, theme } from "./theme";

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(_error: Error, _info: ErrorInfo): void {
    // deliberately empty, and deliberately not a log. `no-console` is an eslint
    // error outside tests because amounts, openings and blinding factors must
    // never reach a log or a crash report, and a react error carries a component
    // stack whose props are exactly that material. the state change above is the
    // whole response.
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    // the private pocket's dark identity, chosen directly rather than read from
    // the provider: the provider is outside this boundary and may be the thing
    // that failed. it is the same tone every logged-out screen already wears.
    const t = theme("private");
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
          <div style={{ marginTop: space.lg, width: "100%" }}>
            <Notice t={t} tone="danger">
              Pocket could not draw this screen. Your wallet and your funds are not affected: the
              keys are held by the extension&rsquo;s background service, not by this window. Reopen
              the wallet to continue.
            </Notice>
            <ButtonStack>
              <Button t={t} onClick={() => window.location.reload()}>
                Reload
              </Button>
            </ButtonStack>
          </div>
        </div>
      </Frame>
    );
  }
}
