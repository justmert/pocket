import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Notice, Sheet } from "../primitives";
import { Receipt, ReviewPanel, useOnce, usePhase } from "../flow";
import type { PrivateOpSummary, TransferSummary } from "../../../../core/messages";

type Stage = "compose" | "review" | "done";

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
    >
      {stage === "compose" && (
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
          treatment="sealed"
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
