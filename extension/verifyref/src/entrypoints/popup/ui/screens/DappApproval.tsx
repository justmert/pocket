import { useState } from "react";
import { call } from "../rpc";
import { Button, ButtonStack, Frame, Header, Label, Notice } from "../primitives";
import { MonoBlock } from "../AddressBlock";
import { Money } from "../Money";
import { leading, space, text, type Theme } from "../theme";
import type { TxSummary } from "../../../../core/provider/describe-tx";

/**
 * A site is asking for a signature.
 *
 * The screen exists so the wallet never signs bytes a person has not read.
 * Two things are load-bearing and neither is decoration: the ORIGIN is shown
 * verbatim and untruncated, because it is the only thing distinguishing the
 * real site from a lookalike, and Approve does not render at all when the
 * envelope could not be decoded. A hash the user cannot read is not consent.
 */
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
  const { summary, origin } = request;

  const answer = async (approved: boolean) => {
    setBusy(true);
    try {
      await call({ type: "resolveDappRequest", id: request.id, approved });
    } finally {
      onDone();
    }
  };

  return (
    <Frame t={t}>
      <Header title="Signature request" t={t} />
      <div style={{ padding: space.gutter, flex: 1, overflowY: "auto" }}>
        <Label t={t}>This site is asking</Label>
        {/* Full origin, never shortened. A lookalike domain is the entire
            attack, and an ellipsis is where it hides. */}
        <MonoBlock t={t}>{origin}</MonoBlock>

        {!summary.decoded ? (
          <div style={{ marginTop: space.lg }}>
            <Notice tone="danger" t={t}>
              {summary.warning ??
                "Pocket could not read this transaction, so it will not offer to sign it."}
            </Notice>
            {/* No Approve button here, deliberately. There is nothing to consent to. */}
            <ButtonStack>
              <Button t={t} disabled={busy} onClick={() => void answer(false)}>
                Close
              </Button>
            </ButtonStack>
          </div>
        ) : (
          <>
            {summary.warning && (
              <div style={{ marginTop: space.lg }}>
                <Notice tone="danger" t={t}>
                  {summary.warning}
                </Notice>
              </div>
            )}

            <div style={{ marginTop: space.lg }}>
              <Label t={t}>What this does</Label>
            </div>
            <ul
              style={{
                ...text.body,
                color: t.text,
                paddingLeft: space.gutter,
                margin: 0,
                lineHeight: leading.relaxed,
                // These lines quote things the user or the chain chose: a memo,
                // an address, an asset code. A 28-byte memo is very often one
                // unbroken token, because that is what exchange deposit memos
                // are, and without this the frame's `overflow: hidden` cuts it
                // rather than wrapping. Cutting the memo on the screen that
                // asks you to approve the memo is the worst place for it.
                overflowWrap: "anywhere",
              }}
            >
              {summary.effects.map((e) => (
                <li key={e}>{e}</li>
              ))}
            </ul>

            <div style={{ marginTop: space.lg }}>
              <Label t={t}>Memo</Label>
            </div>
            {summary.memo ? (
              <MonoBlock t={t}>{summary.memo}</MonoBlock>
            ) : (
              <div style={{ ...text.body, color: t.sub }}>No memo.</div>
            )}

            <div style={{ marginTop: space.lg }}>
              <Label t={t}>Network fee</Label>
              <Money amount={summary.fee} code="XLM" size="inline" t={t} />
            </div>

            <Notice t={t}>
              Approving signs this once. It does not let this site sign anything else.
            </Notice>

            <ButtonStack>
              <Button t={t} variant="quiet" disabled={busy} onClick={() => void answer(false)}>
                Reject
              </Button>
              <Button t={t} disabled={busy} onClick={() => void answer(true)}>
                {busy ? "Signing…" : "Approve and sign"}
              </Button>
            </ButtonStack>
          </>
        )}
      </div>
    </Frame>
  );
}
