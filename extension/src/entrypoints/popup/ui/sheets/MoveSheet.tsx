import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Label, Notice, Row, Sheet } from "../primitives";
import { Receipt, ReviewPanel, useOnce, usePhase } from "../flow";
import { Progress } from "../Progress";
import { ArrowDown, ArrowUp, Check } from "../icons";
import { space, text } from "../theme";
import type { PrivateOpRequest, PrivateOpSummary } from "../../../../core/messages";

type Kind = PrivateOpRequest["kind"];
type Stage = "menu" | "form" | "review" | "running" | "done";

/** the words the user sees. the protocol's own names never reach a screen. */
const HEADING: Record<Kind, string> = {
  register: "Setting up",
  shield: "Moving in",
  merge: "Making spendable",
  transfer: "Sending privately",
  unshield: "Moving out",
};

export function MoveSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const priv = w.priv;

  const [stage, setStage] = useState<Stage>("menu");
  const [kind, setKind] = useState<Kind>("shield");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<PrivateOpSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number; followed?: string } | null>(
    null,
  );
  const once = useOnce();
  const phase = usePhase(busy);

  const reset = () => {
    setStage("menu");
    setAmount("");
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

  const close = () => onClose();

  useEffect(() => {
    if (!open || stage !== "menu" || priv?.state === "ready") return;
    let left = 15;
    const id = setInterval(() => {
      if (left-- <= 0) {
        clearInterval(id);
        return;
      }
      void w.refresh();
    }, 2000);
    return () => clearInterval(id);
  }, [open, stage, priv?.state, w]);

  const build = async (op: PrivateOpRequest) => {
    setKind(op.kind);
    setError(null);
    setBuilding(true);
    try {
      const r = await call({ type: "buildPrivateOp", op });
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
    try {
      const r = await call({ type: "confirmPrivateOp", handle });
      setResult(r);
      // the work is over, so the sheet stops refusing to close.
      setBusy(false);
      setStage("done");
      void w.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      once.release();
    }
  };

  const rebuild = async () => {
    setError(null);
    setBusy(true);
    try {
      await call({ type: "rebuildFromHistory" });
      void w.refresh();
      close();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const title =
    stage === "menu" ? "Move" : stage === "done" ? HEADING[kind] : HEADING[kind];

  return (
    <Sheet t={t} open={open} onClose={busy ? () => undefined : close} title={title} full={stage === "review" || stage === "done"} focusKey={stage} still={stage === "review"}>
      {stage === "menu" &&
        menu({
          priv,
          building,
          error,
          onShield: () => {
            setKind("shield");
            setStage("form");
          },
          onUnshield: () => {
            setKind("unshield");
            setStage("form");
          },
          onMerge: () => void build({ kind: "merge" }),
          onRegister: () => void build({ kind: "register" }),
          onRebuild: () => void rebuild(),
          rebuilding: busy,
        })}

      {stage === "form" && (
        <>
          <Notice t={t} tone="exposed">
            {kind === "shield"
              ? "This amount is public. Moving in hides what you do next, not the fact that you moved this much in."
              : "This amount becomes public when it lands in the public pocket."}
          </Notice>
          <Field
            t={t}
            label="Amount (XLM)"
            value={amount}
            onChange={setAmount}
            placeholder="0.0000000"
            autoFocus
            onSubmit={() => amount.trim() && void build({ kind, amount } as PrivateOpRequest)}
          />
          {error && (
            <Notice t={t} tone="danger">
              {error}
            </Notice>
          )}
          <ButtonStack>
            <Button
              t={t}
              disabled={!amount.trim()}
              busy={building}
              onClick={() => void build({ kind, amount } as PrivateOpRequest)}
            >
              {building ? "Checking" : "Review"}
            </Button>
            <Button t={t} variant="quiet" onClick={() => setStage("menu")}>
              Back
            </Button>
          </ButtonStack>
        </>
      )}

      {stage === "review" && summary && (
        <ReviewPanel
          t={t}
          heading={HEADING[summary.kind]}
          amount={summary.amount}
          treatment={summary.kind === "shield" || summary.kind === "unshield" ? "exposed" : "sealed"}
          to={summary.to}
          effects={summary.effects}
          error={error}
          busy={busy}
          phase={phase}
          approveLabel="Approve"
          onApprove={() => void approve()}
          onCancel={() => setStage("menu")}
        />
      )}

      {stage === "done" && result && (
        <Receipt
          t={t}
          hash={result.hash}
          ledger={result.ledger}
          note={result.followed ? "Made spendable in a second transaction." : undefined}
          onDone={close}
        />
      )}
    </Sheet>
  );

  // called rather than mounted: declared here it would be a new component type
  // on every render, and react would tear down and rebuild the whole menu.
  function menu({
    priv,
    building,
    error,
    onShield,
    onUnshield,
    onMerge,
    onRegister,
    onRebuild,
    rebuilding,
  }: {
    priv: typeof w.priv;
    building: boolean;
    error: string | null;
    onShield: () => void;
    onUnshield: () => void;
    onMerge: () => void;
    onRegister: () => void;
    onRebuild: () => void;
    rebuilding: boolean;
  }) {
    if (!priv) {
      return <Notice t={t}>Reading the ledger.</Notice>;
    }

    if (building) {
      return <Progress t={t} phase={phase} label="Building" fallback="Checking this against the ledger." />;
    }

    const body = () => {
      switch (priv.state) {
        case "unavailable":
        case "unfunded":
          return <Notice t={t}>{priv.message}</Notice>;

        case "unregistered":
          return (
            <>
              {priv.message && <Notice t={t} tone="exposed">{priv.message}</Notice>}
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
                  Setting up takes TWO transactions, and pressing this sends the first one straight
                  away: it registers your auditor key and pays a network fee. You will review the
                  second before anything else is signed.
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
                  Set up the private pocket
                </Button>
              </ButtonStack>
            </>
          );

        case "archived":
          return (
            <>
              {priv.message && <Notice t={t} tone="exposed">{priv.message}</Notice>}
              <ButtonStack>
                <Button t={t} onClick={onMerge}>
                  Reactivate
                </Button>
              </ButtonStack>
            </>
          );

        case "needsRecovery":
        case "diverged":
          return (
            <>
              {priv.message && (
                <Notice t={t} tone={priv.state === "diverged" ? "danger" : "exposed"}>
                  {priv.message}
                </Notice>
              )}
              <Notice t={t}>
                Rebuilding replays your history and checks the result against what the contract
                holds, so an incomplete history is refused rather than accepted.
              </Notice>
              <ButtonStack>
                <Button t={t} busy={rebuilding} onClick={onRebuild}>
                  {rebuilding ? "Replaying your history" : "Rebuild from history"}
                </Button>
              </ButtonStack>
            </>
          );

        case "ready":
          return (
            <>
              {priv.mergeAvailable && (
                <>
                  <ButtonStack>
                    <Button t={t} onClick={onMerge}>
                      Make spendable
                    </Button>
                  </ButtonStack>
                  <div style={{ height: space.gutter }} />
                </>
              )}
              <Row
                t={t}
                index={0}
                icon={<ArrowDown size={19} />}
                title="Move in"
                sub="Public pocket to private"
                onClick={onShield}
              />
              <Row
                t={t}
                index={1}
                icon={<ArrowUp size={19} />}
                title="Move out"
                sub="Private pocket to public"
                onClick={onUnshield}
              />
              {!priv.mergeAvailable && (
                <Row
                  t={t}
                  index={2}
                  icon={<Check size={19} />}
                  title="Make spendable"
                  sub="Nothing is waiting right now"
                  onClick={undefined}
                />
              )}
            </>
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
