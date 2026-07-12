import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, ButtonStack, Label, Notice, Sheet } from "../primitives";
import { Held } from "../Held";
import { canRebuild } from "../copy";
import { Receipt, ReviewPanel, useOnce } from "../flow";
import { Progress } from "../Progress";
import { space, text } from "../theme";
import type { PrivateOpRequest, PrivateOpSummary } from "../../../../core/messages";

type Kind = PrivateOpRequest["kind"];
// move-in and move-out are their own pages now (screens/Move.tsx); this sheet is
// only the states that are not a plain amount: setup, make-spendable, rebuild.
type Stage = "menu" | "review" | "running" | "done";

/** the words the user sees. the protocol's own names never reach a screen. */
const HEADING: Record<Kind, string> = {
  register: "Setting up",
  shield: "Shielding",
  merge: "Making spendable",
  transfer: "Sending privately",
  unshield: "Unshielding",
};

/** the verb for the processing-list row, so a backgrounded setup or make-spendable
 *  reads as itself rather than borrowing a send's words. */
const VERB: Record<Kind, string> = {
  register: "Set up private pocket",
  shield: "Shield",
  merge: "Make spendable",
  transfer: "Send privately",
  unshield: "Unshield",
};

export function MoveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  // the asset the opener meant (register / make-spendable is per asset), falling back
  // to the primary if it was opened without one.
  const priv = w.privateDetail ?? w.priv;
  const refresh = w.refresh;
  // the setup/make-spendable/rebuild here all act on the selected private asset,
  // set by the asset row that opened this sheet. symbol for display, token for the
  // op; both default to the primary asset for a single-asset wallet.
  const symbol = priv?.symbol ?? "XLM";
  const assetToken = priv?.token ?? undefined;

  const [stage, setStage] = useState<Stage>("menu");
  const [kind, setKind] = useState<Kind>("merge");
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<PrivateOpSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number; followed?: string } | null>(
    null,
  );
  const once = useOnce();
  // id of the background-op record for the op in flight, so the confirm's resolver
  // can flip it to done even after the sheet has been sent to the background.
  const opId = useRef<string | null>(null);
  // set the moment a register build returns, because by then its first
  // transaction is on the ledger and the disclosure below must stop describing
  // it in the future tense.
  const [registerStarted, setRegisterStarted] = useState(false);

  const reset = () => {
    setStage("menu");
    setError(null);
    setHandle(null);
    setSummary(null);
    setResult(null);
    setBusy(false);
    once.release();
  };

  // reset on the way IN. resetting on a timer after close can still be pending
  // when the sheet is reopened, and it then wipes what was just typed.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) {
      reset();
      // the menu is entirely a function of a state the ledger owns, so opening
      // the sheet re-reads it rather than showing whatever was true when the
      // popup opened.
      void w.refresh();
    }
    wasOpen.current = open;
  });

  const close = () => {
    // a dismissed receipt has served the watch record's purpose; drop it so it
    // does not linger in the processing list beside the same history row.
    if (result && opId.current) {
      w.dropOp(opId.current);
      opId.current = null;
    }
    onClose();
  };

  // The countdown lives in a ref because the effect is re-created whenever the
  // provider re-renders, and `refresh` re-renders the provider. Held in a local
  // it reset to fifteen on every tick and the bound was never reached, so a poll
  // built from `balances` and `privatePocket` kept re-arming the idle-lock alarm
  // and the wallet never locked itself again. That is the whole reason this is
  // bounded at all.
  const pollsLeft = useRef(0);
  useEffect(() => {
    if (!open || stage !== "menu" || priv?.state === "ready") return;
    pollsLeft.current = 15;
    const id = setInterval(() => {
      if (pollsLeft.current-- <= 0) {
        clearInterval(id);
        return;
      }
      void refresh();
    }, 2000);
    return () => clearInterval(id);
    // `refresh` is a stable useCallback; `w` is not, and depending on it is what
    // made this unbounded.
  }, [open, stage, priv?.state, refresh]);

  const build = async (op: PrivateOpRequest) => {
    setKind(op.kind);
    setError(null);
    setBuilding(true);
    try {
      const r = await call({ type: "buildPrivateOp", op, asset: assetToken });
      if (op.kind === "register") setRegisterStarted(true);
      setHandle(r.handle);
      setSummary(r.summary);
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("menu");
    } finally {
      setBuilding(false);
    }
  };

  const approve = async () => {
    if (!handle || !once.claim()) return;
    setBusy(true);
    setError(null);
    const id = w.beginOp({
      verb: VERB[kind],
      pocket: w.pocket,
      code: symbol,
      amount: summary?.amount,
      to: summary?.to,
      fee: summary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
      const r = await call({ type: "confirmPrivateOp", handle });
      w.completeOp(id, { hash: r.hash, ledger: r.ledger });
      setResult(r);
      // the work is over, so the sheet stops refusing to close.
      setBusy(false);
      setStage("done");
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      w.failOp(id, reason);
      setError(reason);
      setBusy(false);
      once.release();
    }
  };

  const rebuild = async () => {
    setError(null);
    setBusy(true);
    try {
      await call({ type: "rebuildFromHistory", asset: assetToken });
      void w.refresh();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title = stage === "menu" ? "Move" : HEADING[kind];

  return (
    <Sheet
      t={t}
      open={open}
      onClose={busy ? () => undefined : close}
      title={title}
      full={stage === "review" || stage === "done"}
      focusKey={stage}
      still={stage === "review"}
    >
      {/* the body fades in on each stage change (menu -> review -> done); the key
          remounts it so pocket-fade-in replays. review is `still`, which freezes the
          fade there, which is the point. */}
      <div key={stage} className="pocket-fade-in">
        {stage === "menu" &&
          menu({
            priv,
            building,
            error,
            onMerge: () => void build({ kind: "merge" }),
            onRegister: () => void build({ kind: "register" }),
            onRebuild: () => void rebuild(),
            rebuilding: busy,
          })}

        {stage === "review" && summary && (
          <ReviewPanel
            t={t}
            amount={summary.amount}
            treatment={
              summary.kind === "shield" || summary.kind === "unshield" ? "exposed" : "plain"
            }
            to={summary.to}
            fee={summary.fee}
            effects={summary.effects}
            alreadyDone={
              summary.kind === "register"
                ? "Your auditor key is already registered on the ledger, and the fee for it is paid. This step creates the confidential account."
                : undefined
            }
            cancelLabel={summary.kind === "register" ? "Leave this for now" : "Back"}
            error={error}
            busy={busy}
            approveLabel="Approve"
            onApprove={() => void approve()}
            onCancel={() => setStage("menu")}
            onGoHome={close}
          />
        )}

        {stage === "done" && result && (
          <Receipt
            t={t}
            hash={result.hash}
            note={result.followed ? "Made spendable in a second transaction." : undefined}
            network={w.status?.network}
            onDone={close}
          />
        )}
      </div>
    </Sheet>
  );

  // called rather than mounted: declared here it would be a new component type
  // on every render, and react would tear down and rebuild the whole menu.
  function menu({
    priv,
    building,
    error,
    onMerge,
    onRegister,
    onRebuild,
    rebuilding,
  }: {
    priv: typeof w.priv;
    building: boolean;
    error: string | null;
    onMerge: () => void;
    onRegister: () => void;
    onRebuild: () => void;
    rebuilding: boolean;
  }) {
    if (!priv) {
      // three different reasons produce a null pocket and they are not the same
      // fact. a deployment with no confidential wrapper will never have one, so
      // "reading the ledger" is a claim about work that is not happening and
      // never will; a failed read has an error the worker already worded; and
      // only the third is actually still reading.
      if (w.privError) {
        return (
          <Notice t={t} tone="danger">
            {w.privError}
          </Notice>
        );
      }
      if (w.status && !w.status.privateAvailable) {
        return <Notice t={t}>This network has no private pocket. Nothing to move.</Notice>;
      }
      return <Notice t={t}>Reading the ledger.</Notice>;
    }

    if (building) {
      // no "Go to Home" while building: nothing is submitted yet, so there is
      // nothing to continue in the background.
      return <Progress t={t} title="Preparing" subtitle="Checking this against the ledger." />;
    }

    const body = () => {
      switch (priv.state) {
        case "unavailable":
        case "unfunded":
          return <Notice t={t}>{priv.message}</Notice>;

        case "unregistered":
          return (
            <>
              {priv.message && (
                <Notice t={t} tone="exposed">
                  {priv.message}
                </Notice>
              )}
              <Label t={t}>Before you start</Label>
              <ul
                style={{
                  ...text.body,
                  color: t.text,
                  paddingLeft: space.gutter,
                  margin: `0 0 ${space.md}px`,
                  lineHeight: 1.55,
                }}
              >
                <li style={{ marginBottom: 6 }}>
                  {registerStarted
                    ? "The first of the two transactions has already been sent: your auditor key is registered and its fee is paid. Pressing this creates the confidential account."
                    : "Setting up takes TWO transactions, and pressing this sends the first one straight away: it registers your auditor key and pays a network fee. You will review the second before anything else is signed."}
                </li>
                <li style={{ marginBottom: 6 }}>
                  Setting up is public. Anyone can see this account has a private pocket.
                </li>
                <li style={{ marginBottom: 6 }}>
                  Your address stays public on every private payment. Only amounts are hidden.
                </li>
                <li>
                  Your auditor key is derived from your recovery phrase, so only you can read your
                  amounts. It is bound permanently and cannot be changed later.
                </li>
              </ul>
              <ButtonStack>
                <Button t={t} onClick={onRegister}>
                  {registerStarted ? "Finish setting up" : "Set up the private pocket"}
                </Button>
              </ButtonStack>
            </>
          );

        // the three states below are the same fact about the user's money —
        // it is there and it is not spendable yet — so they are one shape.
        // see ui/Held.tsx.
        case "archived":
          return (
            // no rebuild route here, and the absence is the fix.
            //
            // an earlier batch added one, on the reasoning that someone whose
            // reactivation cannot succeed should not be at a dead end. it does
            // not work and it cannot: `rebuildFromHistory` reads the account
            // before it reads any archive (controller.ts, `readOwnAccount`),
            // and for an archived entry `readConfidentialAccount` answers null
            // — which is the very thing that makes the state `archived`. so the
            // button threw "This account has no private pocket yet." at a user
            // who is holding a private balance and looking at it.
            //
            // that is worse than the dead end it was meant to close: a dead end
            // is silence, and this was the wallet denying the pocket exists.
            // restoring the ledger footprint is a transaction this build cannot
            // construct, so there is no second route to offer, and offering one
            // that answers with a denial is not honesty.
            <Held
              t={t}
              label="Dormant"
              amount={priv.spendable}
              code={symbol}
              holding="This pocket went dormant from not being used. Reactivating wakes it up. Your balance is on the ledger either way; it is this device's access to it that has lapsed."
              action={{ label: "Reactivate", onClick: onMerge }}
            >
              {priv.message && (
                <Notice t={t} tone="exposed">
                  {priv.message}
                </Notice>
              )}
            </Held>
          );

        case "needsRecovery":
        case "diverged":
          return (
            <Held
              t={t}
              label={priv.state === "diverged" ? "Out of step" : "Needs rebuilding"}
              amount={priv.spendable}
              code={symbol}
              holding={
                canRebuild(w.status?.network ?? "testnet")
                  ? "Rebuilding replays your history and checks the result against what the contract holds, so an incomplete history is refused rather than accepted."
                  : "Rebuilding would replay your history from a durable archive, and this build has none configured. Your balance is on the ledger and is not lost; this device cannot reach it until a build with an archive does the replay."
              }
              // no button where there is no archive. the worker refuses with the
              // right words, but a primary control three lines under a sentence
              // saying it cannot be done is the product arguing with itself, and
              // the user can only find out which half is true by pressing it.
              action={
                canRebuild(w.status?.network ?? "testnet")
                  ? {
                      label: rebuilding ? "Replaying your history" : "Rebuild from history",
                      onClick: onRebuild,
                      busy: rebuilding,
                    }
                  : undefined
              }
            >
              {priv.message && (
                <Notice t={t} tone={priv.state === "diverged" ? "danger" : "exposed"}>
                  {priv.message}
                </Notice>
              )}
            </Held>
          );

        // moving in and out are their own pages, reached from the bar's action
        // menu; the only thing this sheet does in the ready state is fold in what
        // has arrived. when nothing has, it says so rather than offering a
        // control that would do nothing.
        case "ready":
          return priv.mergeAvailable ? (
            <ButtonStack>
              <Button t={t} onClick={onMerge}>
                Make spendable
              </Button>
            </ButtonStack>
          ) : (
            <Notice t={t}>Nothing is waiting to be made spendable.</Notice>
          );
      }
    };

    return (
      <>
        {error && (
          <Notice t={t} tone="danger">
            {error}
          </Notice>
        )}
        {body()}
      </>
    );
  }
}
