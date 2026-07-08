import { useState } from "react";
import { call } from "../rpc";
import { MonoBlock, OriginBlock } from "../Address";
import { Amount } from "../Amount";
import { Button, ButtonRow, ButtonStack, Header, Label, Notice, Screen } from "../primitives";
import { useOnce } from "../flow";
import { NO_MEMO } from "../copy";
import { space, text, type Theme } from "../theme";
import type { TxSummary } from "../../../../core/provider/describe-tx";

/** stroops to XLM. the envelope carries the fee in stroops and a wallet that
 *  labels seven digits of stroops as XLM is off by a factor of ten million. */
function feeInXlm(stroops: string): string {
  const n = BigInt(stroops || "0");
  const whole = n / 10_000_000n;
  const rest = (n % 10_000_000n).toString().padStart(7, "0");
  return `${whole}.${rest}`;
}

export function DappApproval({
  t,
  request,
  onDone,
}: {
  t: Theme;
  request: { id: string; origin: string; summary: TxSummary };
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const once = useOnce();
  const { summary } = request;

  const answer = async (approved: boolean) => {
    if (!once.claim()) return;
    setBusy(true);
    setError(null);
    try {
      await call({ type: "resolveDappRequest", id: request.id, approved });
      onDone();
    } catch (e) {
      // a refusal that failed to reach the worker must not close the screen: the
      // site is still waiting, and the user would be left believing they answered.
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      once.release();
    }
  };

  return (
    <Screen t={t}>
      <Header t={t} title="Signature request" />

      <Label t={t}>This site is asking</Label>
      <OriginBlock t={t} origin={request.origin} />

      {!summary.decoded ? (
        <>
          <div style={{ marginTop: space.md }}>
            <Notice t={t} tone="danger">
              {summary.warning ?? "Pocket could not read this transaction, so it will not offer to sign it."}
            </Notice>
          </div>
          {error && (
            <Notice t={t} tone="danger">
              {error}
            </Notice>
          )}
          <ButtonStack>
            <Button t={t} busy={busy} onClick={() => void answer(false)}>
              Close
            </Button>
          </ButtonStack>
        </>
      ) : (
        <>
          {summary.warning && (
            <div style={{ marginTop: space.md }}>
              <Notice t={t} tone="danger">
                {summary.warning}
              </Notice>
            </div>
          )}

          <div style={{ marginTop: space.gutter }}>
            <Label t={t}>What this does</Label>
            <ul
              style={{
                ...text.body,
                color: t.text,
                paddingLeft: space.gutter,
                margin: `0 0 ${space.md}px`,
                lineHeight: 1.55,
                overflowWrap: "anywhere",
              }}
            >
              {summary.effects.map((e, i) => (
                <li key={i} style={{ marginBottom: 4 }}>
                  {e}
                </li>
              ))}
            </ul>
          </div>

          <Label t={t}>Memo</Label>
          {summary.memo ? (
            <MonoBlock t={t}>{summary.memo}</MonoBlock>
          ) : (
            <div style={{ ...text.body, color: t.sub }}>{NO_MEMO}</div>
          )}

          <div style={{ marginTop: space.gutter }}>
            <Label t={t}>Network fee</Label>
            <Amount t={t} value={feeInXlm(summary.fee)} code="XLM" size="row" />
          </div>

          <div style={{ marginTop: space.gutter }}>
            <Notice t={t}>Approving signs this once. It does not let the site sign anything else.</Notice>
          </div>

          {error && (
            <Notice t={t} tone="danger">
              {error}
            </Notice>
          )}

          <ButtonRow>
            <Button t={t} variant="quiet" busy={busy} onClick={() => void answer(false)}>
              Reject
            </Button>
            <Button t={t} busy={busy} onClick={() => void answer(true)}>
              {busy ? "Signing" : "Approve"}
            </Button>
          </ButtonRow>
        </>
      )}
    </Screen>
  );
}
