import { useState } from "react";
import { call } from "../rpc";
import { Button, Field, Frame, Header, Notice, Spinner } from "../primitives";
import { AddressBlock } from "../AddressBlock";
import { Money } from "../Money";
import { text, type Theme } from "../theme";
import type { TransferSummary } from "../../../../core/messages";

type Stage = "compose" | "confirm" | "sending" | "done";

/**
 * Send, with the confirm step built around what actually protects a user:
 * the full recipient address, shown untruncated, and an explicit statement of
 * every effect. Nothing is signed until the user has seen this screen.
 */
export function Send({ t, onBack }: { t: Theme; onBack: () => void }) {
  const [stage, setStage] = useState<Stage>("compose");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [built, setBuilt] = useState<{ xdr: string; summary: TransferSummary } | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const review = async () => {
    setError(null);
    try {
      setBuilt(
        await call({
          type: "buildPayment",
          to,
          amount,
          assetId: "native",
          memo: memo || undefined,
        }),
      );
      setStage("confirm");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const send = async () => {
    if (!built) return;
    setStage("sending");
    setError(null);
    try {
      // `built.xdr` is an opaque handle the worker issued, not raw XDR. The
      // worker signs only envelopes it built and we reviewed.
      setResult(await call({ type: "confirmPayment", handle: built.xdr }));
      setStage("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStage("confirm");
    }
  };

  return (
    <Frame t={t}>
      <Header
        title="Send"
        t={t}
        right={
          <button
            onClick={onBack}
            style={{
              ...text.caption,
              background: "none",
              border: "none",
              color: t.sub,
              cursor: "pointer",
            }}
          >
            Close
          </button>
        }
      />
      <div style={{ padding: 18, flex: 1 }}>
        {stage === "compose" && (
          <>
            <Field t={t} label="Recipient" value={to} onChange={setTo} placeholder="G..." />
            <Field
              t={t}
              label="Amount (XLM)"
              value={amount}
              onChange={setAmount}
              placeholder="0.0000000"
            />
            <Field t={t} label="Memo (optional)" value={memo} onChange={setMemo} />
            {error && (
              <Notice tone="danger" t={t}>
                {error}
              </Notice>
            )}
            <Button t={t} disabled={!to || !amount} onClick={() => void review()}>
              Review
            </Button>
          </>
        )}

        {stage === "confirm" && built && (
          <>
            <div style={{ ...text.label, color: t.sub, marginBottom: 6 }}>Sending to</div>
            {/* Full address, never truncated: matching the first and last four
                characters costs about an hour on a laptop. */}
            <AddressBlock address={built.summary.to} t={t} />

            <div style={{ margin: "18px 0 6px", ...text.label, color: t.sub }}>Amount</div>
            <Money amount={built.summary.amount} code={built.summary.assetCode} size={26} t={t} />

            {/* The memo is signed, so it must be reviewed. Corrupting it is the
                single most reliable way to lose funds at an exchange deposit
                address, and its ABSENCE matters just as much: an exchange
                deposit without one is usually unrecoverable. So both cases are
                stated, and neither is left to be inferred from blank space. */}
            <div style={{ margin: "18px 0 6px", ...text.label, color: t.sub }}>Memo</div>
            {built.summary.memo ? (
              <div
                style={{
                  ...text.body,
                  fontFamily: "ui-monospace, monospace",
                  color: t.text,
                  wordBreak: "break-all",
                  padding: "8px 10px",
                  borderRadius: 8,
                  background: t.field,
                }}
              >
                {built.summary.memo}
              </div>
            ) : (
              <div style={{ ...text.body, color: t.sub }}>
                No memo. Exchanges usually require one; a deposit without it can be lost.
              </div>
            )}

            <div style={{ marginTop: 20, ...text.label, color: t.sub, marginBottom: 8 }}>
              What this does
            </div>
            <ul
              style={{ ...text.body, color: t.text, paddingLeft: 18, margin: 0, lineHeight: 1.7 }}
            >
              {built.summary.effects.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>

            {!built.summary.decoded && (
              <Notice tone="danger" t={t}>
                Pocket could not determine what this transaction does. Do not approve it.
              </Notice>
            )}

            <div style={{ marginTop: 20 }}>
              {error && (
                <Notice tone="danger" t={t}>
                  {error}
                </Notice>
              )}
              <Button t={t} disabled={!built.summary.decoded} onClick={() => void send()}>
                Confirm and send
              </Button>
              <div style={{ height: 8 }} />
              <Button t={t} variant="quiet" onClick={() => setStage("compose")}>
                Back
              </Button>
            </div>
          </>
        )}

        {stage === "sending" && (
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 30 }}>
            <Spinner t={t} />
            <span style={{ ...text.body, color: t.sub }}>
              Submitting and waiting for the ledger…
            </span>
          </div>
        )}

        {stage === "done" && result && (
          <>
            <div style={{ ...text.title, marginBottom: 10 }}>Sent</div>
            <div style={{ ...text.body, color: t.sub, marginBottom: 14 }}>
              Included in ledger {result.ledger}.
            </div>
            <div style={{ ...text.label, color: t.sub, marginBottom: 6 }}>Transaction hash</div>
            <AddressBlock address={result.hash} t={t} />
            <div style={{ height: 16 }} />
            <Button t={t} onClick={onBack}>
              Done
            </Button>
          </>
        )}
      </div>
    </Frame>
  );
}
