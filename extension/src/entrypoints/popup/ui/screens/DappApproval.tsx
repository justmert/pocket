import { useState } from "react";
import { call } from "../rpc";
import { useWallet } from "../WalletProvider";
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
  const w = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const once = useOnce();
  const { summary } = request;

  // just the host, for the toast: a full origin with its scheme is a long string
  // for a transient line, and the host is the part the approval screen is about.
  const hostOf = (origin: string) => origin.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");

  const answer = async (approved: boolean) => {
    if (!once.claim()) return;
    setBusy(true);
    setError(null);
    try {
      const parked = await call({ type: "resolveDappRequest", id: request.id, approved });
      // the worker times a request out at 280s and answers the site
      // `USER_REJECTED` on its own. this screen can outlive that, and pressing
      // Approve on one that has already expired used to close exactly as a
      // success does, while the site had been told minutes earlier that the user
      // declined, and SEP-43 tells a site not to retry a rejection. nothing was
      // signed, so the honest answer is that the request is gone.
      if (!parked) {
        setError("That request expired, so the site was told you did not answer it. Ask it again.");
        setBusy(false);
        return;
      }
      // the site has its signature and this screen is about to vanish. without a
      // word, the only evidence the user ever gave one is on the site's side:
      // there is no `beginOp`, nothing in Activity, and nothing to see if the tab
      // moved on. a wallet's own record of what it signed should not be the
      // signing party's alone.
      w.showToast(`Signature sent to ${hostOf(request.origin)}`, "positive");
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
            // the KIND, not just the value: an id memo of 12345 and a text memo
            // of "12345" are byte-identical here and an exchange asking for one
            // and getting the other loses the deposit.
            memo={{ value: summary.memo, type: summary.memoType }}
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
