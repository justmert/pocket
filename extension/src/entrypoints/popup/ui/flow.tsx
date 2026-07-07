// the parts every signing flow shares: the review, the progress, the receipt.
//
// one implementation so that approving a public payment and approving a private
// one are the same act, described the same way, with the same last chance to
// back out.
import { useEffect, useRef, useState } from "react";
import { call } from "./rpc";
import { Amount, type Treatment } from "./Amount";
import { AddressBlock, MonoBlock } from "./Address";
import { Button, ButtonRow, ButtonStack, Label, Notice, Overline } from "./primitives";
import { Progress } from "./Progress";
import { space, text, type Theme } from "./theme";

/**
 * the worker's current phase while an operation is running.
 *
 * polled rather than pushed, because the worker has no channel back into a
 * popup that may not be open. null until it reports one.
 */
export function usePhase(active: boolean): string | null {
  const [phase, setPhase] = useState<string | null>(null);
  useEffect(() => {
    if (!active) {
      setPhase(null);
      return;
    }
    let live = true;
    const tick = async () => {
      try {
        const p = await call({ type: "currentPhase" });
        if (live) setPhase(p);
      } catch {
        // a phase that cannot be read changes nothing about the operation.
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 400);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [active]);
  return phase;
}

/**
 * a guard that survives a re-render, which is what a double click outruns.
 *
 * a second press used to reach the worker, get refused for a spent handle, and
 * paint that refusal over a receipt, telling someone their payment had failed
 * one moment after it succeeded.
 */
export function useOnce(): { claim: () => boolean; release: () => void } {
  const held = useRef(false);
  return {
    claim: () => {
      if (held.current) return false;
      held.current = true;
      return true;
    },
    release: () => {
      held.current = false;
    },
  };
}

export function ReviewPanel({
  t,
  heading,
  amount,
  code = "XLM",
  treatment = "plain",
  to,
  memo,
  effects,
  warning,
  blocked,
  error,
  busy,
  phase,
  approveLabel,
  cancelLabel = "Back",
  alreadyDone,
  waitDescription = "Signing and submitting, then waiting for the ledger to confirm.",
  onApprove,
  onCancel,
}: {
  t: Theme;
  heading: string;
  amount?: string;
  code?: string;
  treatment?: Treatment;
  to?: string;
  /** rendered whether present or absent: both cases matter at a confirm step. */
  memo?: { value?: string };
  effects: string[];
  warning?: string;
  /** set when the wallet could not read what it is being asked to sign. */
  blocked?: string;
  error?: string | null;
  busy: boolean;
  phase: string | null;
  approveLabel: string;
  /**
   * what the way out is called.
   *
   * "Back" is a lie on a step that has already spent something irreversible,
   * and the register step has: its first transaction is submitted before this
   * screen exists.
   */
  cancelLabel?: string;
  /** what has ALREADY happened by the time this review is on screen. */
  alreadyDone?: string;
  /** what the worker will do, for the stretches where it names no phase. */
  waitDescription?: string;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <>
      <Overline t={t}>{heading}</Overline>

      {amount && (
        <div style={{ marginBottom: space.gutter }}>
          <Amount t={t} value={amount} code={code} size="display" treatment={treatment} />
        </div>
      )}

      {to && (
        <div style={{ marginBottom: space.gutter }}>
          <Label t={t}>To</Label>
          <AddressBlock t={t} address={to} />
        </div>
      )}

      {memo && (
        <div style={{ marginBottom: space.gutter }}>
          <Label t={t}>Memo</Label>
          {memo.value ? (
            <MonoBlock t={t}>{memo.value}</MonoBlock>
          ) : (
            <div style={{ ...text.body, color: t.sub }}>
              None. Exchanges usually require one; a deposit without it can be lost.
            </div>
          )}
        </div>
      )}

      <Label t={t}>What this does</Label>
      <ul
        style={{
          ...text.body,
          color: t.text,
          paddingLeft: space.gutter,
          margin: `0 0 ${space.md}px`,
          lineHeight: 1.55,
          // effects quote memos and addresses, which arrive as one unbroken run.
          overflowWrap: "anywhere",
        }}
      >
        {effects.map((e, i) => (
          <li key={i} style={{ marginBottom: 4 }}>
            {e}
          </li>
        ))}
      </ul>

      {alreadyDone && <Notice t={t} tone="exposed">{alreadyDone}</Notice>}
      {warning && (
        <Notice t={t} tone="danger">
          {warning}
        </Notice>
      )}
      {blocked && (
        <Notice t={t} tone="danger">
          {blocked}
        </Notice>
      )}
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}

      {busy ? (
        <div style={{ marginTop: space.gutter }}>
          <Progress t={t} phase={phase} label={approveLabel} fallback={waitDescription} />
        </div>
      ) : (
        <ButtonRow>
          <Button t={t} variant="quiet" onClick={onCancel}>
            {cancelLabel}
          </Button>
          <Button t={t} disabled={Boolean(blocked)} onClick={onApprove}>
            {approveLabel}
          </Button>
        </ButtonRow>
      )}
    </>
  );
}

export function Receipt({
  t,
  hash,
  ledger,
  note,
  onDone,
}: {
  t: Theme;
  hash: string;
  ledger: number;
  note?: string;
  onDone: () => void;
}) {
  return (
    <>
      <Notice t={t} tone="positive">
        Confirmed in ledger {ledger}.
      </Notice>
      {note && <Notice t={t}>{note}</Notice>}
      <Label t={t}>Transaction hash</Label>
      <MonoBlock t={t}>{hash}</MonoBlock>
      <ButtonStack>
        <Button t={t} onClick={onDone}>
          Done
        </Button>
      </ButtonStack>
    </>
  );
}
