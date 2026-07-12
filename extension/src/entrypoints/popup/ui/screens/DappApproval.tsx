import { useState } from "react";
import { call } from "../rpc";
import { OriginBlock } from "../Address";
import { Button, ButtonRow, ButtonStack, Header, Label, Notice, Screen } from "../primitives";
import { ConfirmBody, useOnce } from "../flow";
import { formatAmount } from "../../../../core/chain/balances";
import { space, type Theme } from "../theme";
import type { TxSummary } from "../../../../core/provider/describe-tx";

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
    <Screen t={t} still>
      <Header t={t} title="Signature request" />

      <Label t={t}>This site is asking</Label>
      <OriginBlock t={t} origin={request.origin} />

      {!summary.decoded ? (
        <>
          <div style={{ marginTop: space.md }}>
            <Notice t={t} tone="danger">
              {summary.warning ??
                "Pocket could not read this transaction, so it will not offer to sign it."}
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
        // the same confirm body every signing surface renders, so a dApp request
        // reads exactly like an in-wallet send: one renderer, no near-copy to drift.
        // the fee crosses as stroops and formatAmount turns it into XLM, the same
        // path Send uses, so it is never off by a factor of ten million.
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: space.gutter,
            marginTop: space.gutter,
          }}
        >
          <ConfirmBody
            t={t}
            fee={formatAmount(BigInt(summary.fee))}
            memo={{ value: summary.memo }}
            effects={summary.effects}
            warning={summary.warning}
            error={error}
          />

          {/* the one dApp-specific fact ConfirmBody has no slot for: this approval
              is single-use and grants the site no standing signing power. */}
          <Notice t={t}>
            Approving signs this once. It does not let the site sign anything else.
          </Notice>

          <ButtonRow>
            <Button t={t} variant="quiet" busy={busy} onClick={() => void answer(false)}>
              Reject
            </Button>
            <Button t={t} busy={busy} onClick={() => void answer(true)}>
              {busy ? "Signing" : "Approve"}
            </Button>
          </ButtonRow>
        </div>
      )}
    </Screen>
  );
}
