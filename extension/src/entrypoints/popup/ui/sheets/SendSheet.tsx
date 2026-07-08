import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Notice, Sheet } from "../primitives";
import { Receipt, ReviewPanel, useOnce, usePhase } from "../flow";
import type { PrivateOpSummary, TransferSummary } from "../../../../core/messages";

type Stage = "compose" | "review" | "done";

/**
 * why there is nothing to send yet, in the words the rest of the product uses.
 *
 * one sentence per state rather than one for all of them: "you cannot send" is
 * true everywhere and useful nowhere, and the state is what tells someone which
 * of these is one press from fixed and which is not.
 */
const PRIVATE_NOT_READY: Record<string, string> = {
  unavailable: "This network has no private pocket, so there is nothing to send from.",
  unfunded: "This account does not exist on the network yet. Receive some XLM first, then you can open a private pocket.",
  unregistered: "The private pocket is not open yet. Setting it up takes two transactions, and you review the second one.",
  archived: "The private pocket went dormant from not being used. Reactivate it before sending.",
  needsRecovery: "This device's record of the private balances has to be rebuilt before anything can be sent.",
  diverged: "This device disagrees with the contract about the private balances, so it refuses to spend until that is rebuilt.",
  ready: "",
};

/**
 * one send, two pockets.
 *
 * the public pocket pays openly and the private one pays with the amount
 * hidden. which one is being spent is never inferred from a label: the sheet is
 * titled for the pocket that is open, and the review says it again.
 */
export function SendSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const isPrivate = w.pocket === "private";

  const [stage, setStage] = useState<Stage>("compose");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [publicSummary, setPublicSummary] = useState<TransferSummary | null>(null);
  const [privateSummary, setPrivateSummary] = useState<PrivateOpSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const once = useOnce();
  const phase = usePhase(busy);

  const reset = () => {
    setStage("compose");
    setTo("");
    setAmount("");
    setMemo("");
    setError(null);
    setHandle(null);
    setPublicSummary(null);
    setPrivateSummary(null);
    setResult(null);
    setBusy(false);
    once.release();
  };

  // reset on the way IN. resetting on a timer after close can still be pending
  // when the sheet is reopened, and it then wipes what was just typed.
  const wasOpen = useRef(open);
  useEffect(() => {
    if (open && !wasOpen.current) reset();
    wasOpen.current = open;
  });

  const close = () => onClose();

  const review = async () => {
    setError(null);
    setBuilding(true);
    try {
      if (isPrivate) {
        const r = await call({ type: "buildPrivateOp", op: { kind: "transfer", to, amount } });
        setHandle(r.handle);
        setPrivateSummary(r.summary);
      } else {
        const r = await call({
          type: "buildPayment",
          to,
          amount,
          assetId: "native",
          memo: memo || undefined,
        });
        setHandle(r.xdr);
        setPublicSummary(r.summary);
      }
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  };

  const approve = async () => {
    if (!handle || !once.claim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = isPrivate
        ? await call({ type: "confirmPrivateOp", handle })
        : await call({ type: "confirmPayment", handle });
      setResult({ hash: r.hash, ledger: r.ledger });
      // the work is over, so the sheet stops refusing to close. leaving this set
      // left a receipt whose only way out was one button, with the header's
      // close, the backdrop and escape all dead.
      setBusy(false);
      setStage("done");
      void w.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      once.release();
    }
  };

  // empty, not "empty once trimmed". a whitespace amount is malformed input and
  // the wallet should say so by name; a button that is simply dead says nothing.
  const ready = to !== "" && amount !== "";

  return (
    <Sheet
      t={t}
      open={open}
      onClose={busy ? () => undefined : close}
      title={isPrivate ? "Send privately" : "Send"}
      full={stage !== "compose"}
      focusKey={stage}
      still={stage === "review"}
    >
      {/* there is nothing to send from a private pocket that has not been
          opened, and the screen behind this sheet says so: "Not open yet",
          "Fund this account first". offering a compose form anyway let someone
          type a destination and an amount for an account that does not exist,
          wait, and be told to check their connection.

          the sheet still opens, because a control that does nothing when
          pressed is its own small dead end. it answers instead. */}
      {stage === "compose" && isPrivate && w.priv?.state !== "ready" ? (
        <>
          <Notice t={t}>
            {w.priv
              ? PRIVATE_NOT_READY[w.priv.state]
              : "Pocket is still reading this account. Try again in a moment."}
          </Notice>
          <ButtonStack>
            <Button
              t={t}
              onClick={() => {
                onClose();
                w.openSheet("move");
              }}
            >
              Open the private pocket
            </Button>
          </ButtonStack>
        </>
      ) : null}

      {stage === "compose" && !(isPrivate && w.priv?.state !== "ready") && (
        <>
          <Field
            t={t}
            label="To"
            value={to}
            onChange={setTo}
            placeholder="G..."
            mono
            autoFocus
          />
          <Field
            t={t}
            label="Amount (XLM)"
            value={amount}
            onChange={setAmount}
            placeholder="0.0000000"
            onSubmit={() => ready && void review()}
          />
          {!isPrivate && <Field t={t} label="Memo (optional)" value={memo} onChange={setMemo} />}

          {isPrivate && (
            <Notice t={t}>The amount is hidden. Both addresses stay public on the ledger.</Notice>
          )}

          {error && (
            <Notice t={t} tone="danger">
              {error}
            </Notice>
          )}

          <ButtonStack>
            <Button t={t} disabled={!ready} busy={building} onClick={() => void review()}>
              {building ? "Checking" : "Review"}
            </Button>
          </ButtonStack>
        </>
      )}

      {stage === "review" && publicSummary && (
        <ReviewPanel
          t={t}
          heading="Sending"
          amount={publicSummary.amount}
          code={publicSummary.assetCode}
          to={publicSummary.to}
          memo={{ value: publicSummary.memo }}
          effects={publicSummary.effects}
          warning={publicSummary.warning}
          blocked={
            publicSummary.decoded
              ? undefined
              : "Pocket could not determine what this transaction does. Do not approve it."
          }
          error={error}
          busy={busy}
          phase={phase}
          approveLabel="Confirm and send"
          onApprove={() => void approve()}
          onCancel={() => setStage("compose")}
        />
      )}

      {stage === "review" && privateSummary && (
        <ReviewPanel
          t={t}
          heading="Sending privately"
          amount={privateSummary.amount}
          to={privateSummary.to}
          effects={privateSummary.effects}
          error={error}
          busy={busy}
          phase={phase}
          approveLabel="Confirm and send"
          onApprove={() => void approve()}
          onCancel={() => setStage("compose")}
        />
      )}

      {stage === "done" && result && (
        <Receipt t={t} hash={result.hash} ledger={result.ledger} onDone={close} />
      )}
    </Sheet>
  );
}
