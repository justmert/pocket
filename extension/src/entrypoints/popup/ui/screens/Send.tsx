import { useState } from "react";
import { call } from "../rpc";
import {
  Button,
  ButtonStack,
  Content,
  Field,
  Frame,
  Header,
  Label,
  Loading,
  Notice,
  TextButton,
} from "../primitives";
import { AddressBlock, MonoBlock } from "../AddressBlock";
import { Money } from "../Money";
import { leading, space, text, type Theme } from "../theme";
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
  const [building, setBuilding] = useState(false);

  const review = async () => {
    setError(null);
    setBuilding(true);
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
    } finally {
      setBuilding(false);
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
          <TextButton t={t} onClick={onBack}>
            Close
          </TextButton>
        }
      />
      <Content>
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
            {building ? (
              <Loading label="Checking the recipient…" t={t} />
            ) : (
              <Button t={t} disabled={!to || !amount} onClick={() => void review()}>
                Review
              </Button>
            )}
          </>
        )}

        {stage === "confirm" && built && (
          <>
            <Label t={t}>Sending to</Label>
            {/* Full address, never truncated: matching the first and last four
                characters costs about an hour on a laptop. */}
            <AddressBlock address={built.summary.to} t={t} />

            <div style={{ marginTop: space.gutter }}>
              <Label t={t}>Amount</Label>
            </div>
            <Money
              amount={built.summary.amount}
              code={built.summary.assetCode}
              size="section"
              t={t}
            />

            {/* The memo is signed, so it must be reviewed. Corrupting it is the
                single most reliable way to lose funds at an exchange deposit
                address, and its ABSENCE matters just as much: an exchange
                deposit without one is usually unrecoverable. So both cases are
                stated, and neither is left to be inferred from blank space. */}
            <div style={{ marginTop: space.gutter }}>
              <Label t={t}>Memo</Label>
            </div>
            {built.summary.memo ? (
              <MonoBlock t={t}>{built.summary.memo}</MonoBlock>
            ) : (
              <div style={{ ...text.body, color: t.sub }}>
                No memo. Exchanges usually require one; a deposit without it can be lost.
              </div>
            )}

            <div style={{ marginTop: space.gutter }}>
              <Label t={t}>What this does</Label>
            </div>
            <ul
              style={{
                ...text.body,
                color: t.text,
                paddingLeft: space.gutter,
                margin: 0,
                lineHeight: leading.relaxed,
              }}
            >
              {built.summary.effects.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>

            {!built.summary.decoded && (
              <div style={{ marginTop: space.lg }}>
                <Notice tone="danger" t={t}>
                  Pocket could not determine what this transaction does. Do not approve it.
                </Notice>
              </div>
            )}

            {error && (
              <div style={{ marginTop: space.lg }}>
                <Notice tone="danger" t={t}>
                  {error}
                </Notice>
              </div>
            )}

            <ButtonStack>
              <Button t={t} disabled={!built.summary.decoded} onClick={() => void send()}>
                Confirm and send
              </Button>
              <Button t={t} variant="quiet" onClick={() => setStage("compose")}>
                Back
              </Button>
            </ButtonStack>
          </>
        )}

        {stage === "sending" && (
          <div style={{ marginTop: space.xl }}>
            <Loading label="Submitting and waiting for the ledger…" t={t} />
          </div>
        )}

        {stage === "done" && result && (
          <>
            <div style={{ ...text.title, color: t.positive, marginBottom: space.md }}>Sent</div>
            <div style={{ ...text.body, color: t.sub, marginBottom: space.lg }}>
              Included in ledger {result.ledger}.
            </div>
            <Label t={t}>Transaction hash</Label>
            <MonoBlock t={t}>{result.hash}</MonoBlock>
            <ButtonStack>
              <Button t={t} onClick={onBack}>
                Done
              </Button>
            </ButtonStack>
          </>
        )}
      </Content>
    </Frame>
  );
}
