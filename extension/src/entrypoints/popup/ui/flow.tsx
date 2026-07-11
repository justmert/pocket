// the parts every signing flow shares: the review, the progress, the receipt.
//
// one implementation so that approving a public payment and approving a private
// one are the same act, described the same way, with the same last chance to
// back out.
import { useEffect, useRef, useState } from "react";
import { call } from "./rpc";
import { Amount, type Treatment } from "./Amount";
import { AddressBlock, MonoBlock } from "./Address";
import { Button, ButtonRow, ButtonStack, Label, Notice, Overline, Sheet } from "./primitives";
import { Progress } from "./Progress";
import { InfoTip } from "./Tooltip";
import { NO_MEMO } from "./copy";
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
  /**
   * omitted where the surface around the review already names the operation.
   *
   * the move sheet titles itself "Moving in" at 24px and used to repeat it
   * immediately below at 12px uppercase, which is the same word twice with
   * nothing between them.
   */
  heading?: string;
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
      {heading && <Overline t={t}>{heading}</Overline>}

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
            <div style={{ ...text.body, color: t.sub }}>{NO_MEMO}</div>
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

/**
 * a confirm, as a popup.
 *
 * every confirm in the wallet is this: a bottom sheet with the figure, the full
 * destination, the fee, and a last chance to back out. it is clean on purpose,
 * but two things stay that the reference wallet omits, because they are the
 * whole point of a self-custody confirm and the suite enforces both:
 *
 *   the ADDRESS is shown in full, never truncated. matching first-4 + last-4 is
 *   about an hour of brute force, so a shortened address is not what anyone
 *   approves.
 *
 *   WHAT THIS DOES is listed. it is the anti-blind-signing surface: the bytes
 *   that leave the machine have to be the bytes the screen described, and
 *   tests/qa/signed-equals-shown.spec.ts reconstructs the envelope from this
 *   list. it is kept compact rather than removed.
 *
 * the prose the old screen wrote inline (the memo caveat especially) moves into
 * an info tooltip, which is the rule now: the screen states the fact, the tip
 * carries the why.
 *
 * on success the same popup swaps to the receipt, so the flow never leaves the
 * sheet: open, confirm, done, close.
 */
export function ConfirmSheet({
  t,
  open,
  heading = "Confirm send",
  amount,
  code = "XLM",
  treatment = "plain",
  to,
  memo,
  fee,
  effects,
  warning,
  blocked,
  error,
  busy,
  phase,
  approveLabel = "Confirm and send",
  waitDescription = "Signing and submitting, then waiting for the ledger to confirm.",
  result,
  onApprove,
  onCancel,
  onDone,
}: {
  t: Theme;
  open: boolean;
  heading?: string;
  amount?: string;
  code?: string;
  treatment?: Treatment;
  to?: string;
  memo?: { value?: string };
  /** network fee in decimal XLM, shown as its own row like the reference. */
  fee?: string;
  effects: string[];
  warning?: string;
  blocked?: string;
  error?: string | null;
  busy: boolean;
  phase: string | null;
  approveLabel?: string;
  waitDescription?: string;
  /** set once the transaction has landed; the popup then shows the receipt. */
  result?: { hash: string; ledger: number } | null;
  onApprove: () => void;
  onCancel: () => void;
  onDone: () => void;
}) {
  return (
    <Sheet
      t={t}
      open={open}
      onClose={busy ? () => undefined : result ? onDone : onCancel}
      full
      still
      focusKey={result ? "done" : "review"}
    >
      {result ? (
        <Receipt t={t} hash={result.hash} ledger={result.ledger} onDone={onDone} />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.gutter }}>
          <Overline t={t}>{heading}</Overline>

          {amount && (
            <Amount t={t} value={amount} code={code} size="display" treatment={treatment} />
          )}

          {to && (
            <div>
              <Label t={t}>To</Label>
              <AddressBlock t={t} address={to} />
            </div>
          )}

          {/* the clean rows: fee, and memo as a fact with its caveat tucked into
              a tip rather than shouted in prose. */}
          <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
            {fee && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ ...text.rowSub, color: t.sub }}>Network fee</span>
                <span style={{ ...text.rowTitle, color: t.text }}>{fee} XLM</span>
              </div>
            )}
            {memo && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: space.sm }}>
                <span style={{ ...text.rowSub, color: t.sub, display: "flex", alignItems: "center", gap: 6 }}>
                  Memo
                  {!memo.value && (
                    <InfoTip t={t} label="About memos" size={16}>
                      {NO_MEMO}
                    </InfoTip>
                  )}
                </span>
                <span style={{ ...text.rowTitle, color: memo.value ? t.text : t.faint, overflowWrap: "anywhere", textAlign: "right", minWidth: 0 }}>
                  {memo.value || "None"}
                </span>
              </div>
            )}
          </div>

          {/* the security surface, compact and de-emphasised but present. open
              by default: it is what stands between a person and a blind
              signature, and the suite reconstructs the envelope from it. */}
          <details open style={{ ...text.caption, color: t.sub }}>
            <summary
              style={{ cursor: "pointer", ...text.rowSub, color: t.sub, listStyle: "none" }}
            >
              What this does
            </summary>
            <ul
              style={{
                margin: `${space.xs}px 0 0`,
                paddingLeft: space.gutter,
                lineHeight: 1.5,
                overflowWrap: "anywhere",
              }}
            >
              {effects.map((e, i) => (
                <li key={i} style={{ marginBottom: 2 }}>
                  {e}
                </li>
              ))}
            </ul>
          </details>

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
            <Progress t={t} phase={phase} label={approveLabel} fallback={waitDescription} />
          ) : (
            <ButtonRow>
              <Button t={t} variant="quiet" onClick={onCancel}>
                Cancel
              </Button>
              <Button t={t} disabled={Boolean(blocked)} onClick={onApprove}>
                {approveLabel}
              </Button>
            </ButtonRow>
          )}
        </div>
      )}
    </Sheet>
  );
}
