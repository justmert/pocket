// the parts every signing flow shares: the review, the progress, the receipt.
//
// one implementation so that approving a public payment and approving a private
// one are the same act, described the same way, with the same last chance to
// back out.
import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { call } from "./rpc";
import { Amount, type Treatment } from "./Amount";
import { AddressBlock } from "./Address";
import { Button, ButtonRow, ButtonStack, IconDisc, Label, Notice, Sheet } from "./primitives";
import { Progress } from "./Progress";
import { InfoTip } from "./Tooltip";
import { Check, Copy, External, Eye } from "./icons";
import { explorerUrl } from "./explorer";
import { usd } from "./money";
import { NO_MEMO } from "./copy";
import { COPY_HOLD_MS, fonts, radius, space, text, type Theme } from "./theme";

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

/**
 * the one confirm body every signing surface renders.
 *
 * the figure, the destination, the fee, the memo, the "what this does" list and
 * the warning stack, in one block, so a private send, the private-pocket setup,
 * and (phase 2) a dApp request describe the act the same way instead of three
 * near-copies that drift. the surface around it owns the heading chrome above and
 * the busy/progress swap and buttons below; this owns the facts being signed.
 *
 * the "what this does" list is the anti-blind-signing surface and its strings are
 * load-bearing: tests/qa/signed-equals-shown reconstructs the envelope from these
 * <li>, so the content here has to be the bytes the worker signs.
 */
export function ConfirmBody({
  t,
  heading,
  amount,
  code = "XLM",
  treatment = "plain",
  to,
  fee,
  memo,
  effects,
  alreadyDone,
  warning,
  blocked,
  error,
  unresolved,
}: {
  t: Theme;
  /** omitted where the surface around the review already names the operation. */
  heading?: string;
  amount?: string;
  code?: string;
  treatment?: Treatment;
  to?: string;
  /** network fee in decimal XLM, shown as its own row like the reference. */
  fee?: string;
  /** rendered whether present or absent: both cases matter at a confirm step. */
  memo?: { value?: string };
  effects: string[];
  /** what has ALREADY happened by the time this confirm is on screen. */
  alreadyDone?: string;
  warning?: string;
  /** set when the wallet could not read what it is being asked to sign. */
  blocked?: string;
  error?: string | null;
  /** the error above is an UNRESOLVED submission, not a failure. see `OpVerdict`. */
  unresolved?: boolean;
}) {
  const exposed = treatment === "exposed";
  return (
    <>
      {/* the figure leads, centred: the amount is the decision, so it is the
          biggest thing here and the operation names itself quietly above it. an
          exposed figure (a move in or out, which lands on the public ledger) says
          so in one plain line, in the pocket's own "this is visible" colour rather
          than a red alarm. the full effect list below still carries the exact
          wording; this is the human version of it. */}
      {(heading || amount) && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: space.xs,
            textAlign: "center",
          }}
        >
          {heading && <span style={{ ...text.rowSub, color: t.sub }}>{heading}</span>}
          {/* `reveal`: this is the figure being signed or the one just sent.
              masking it would make a confirm impossible to check and a receipt
              impossible to read, and both are figures the user has this second
              asked to see. hide-balance is about a balance sitting on a screen,
              not about the amount in front of you. */}
          {amount && (
            <Amount t={t} value={amount} code={code} size="display" treatment={treatment} reveal />
          )}
          {exposed && (
            <span
              style={{
                ...text.caption,
                color: t.exposed,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <Eye size={14} />
              This amount is visible on the ledger
            </span>
          )}
        </div>
      )}

      {to && (
        <div>
          <Label t={t}>To</Label>
          <AddressBlock t={t} address={to} />
        </div>
      )}

      {/* the clean rows: fee, and memo as a fact with its caveat tucked into a
          tip rather than shouted in prose. */}
      {(fee || memo) && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          {fee && (
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ ...text.rowSub, color: t.sub }}>Network fee</span>
              <span style={{ ...text.rowTitle, color: t.text }}>{fee} XLM</span>
            </div>
          )}
          {memo && (
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <span
                style={{
                  ...text.rowSub,
                  color: t.sub,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                }}
              >
                Memo
                {!memo.value && (
                  <InfoTip t={t} label="About memos" size={16}>
                    {NO_MEMO}
                  </InfoTip>
                )}
              </span>
              <span
                style={{
                  ...text.rowTitle,
                  color: memo.value ? t.text : t.faint,
                  overflowWrap: "anywhere",
                  textAlign: "right",
                  minWidth: 0,
                }}
              >
                {memo.value || "None"}
              </span>
            </div>
          )}
        </div>
      )}

      {/* the security surface: the anti-blind-signing list, kept in full and
          legible but set as fine print UNDER a rule rather than the loudest block
          on the screen. every line is still a list item the suite reads, and the
          strings are still the exact bytes the worker signs. always visible (no
          collapse): a disclosure a careful person cannot see without a tap is not
          a disclosure. */}
      <div style={{ borderTop: `1px solid ${t.line}`, paddingTop: space.md }}>
        <div
          style={{
            ...text.caption,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: "0.06em",
            color: t.faint,
            marginBottom: space.xs,
          }}
        >
          What this does
        </div>
        <ul
          style={{
            margin: 0,
            paddingLeft: space.gutter,
            ...text.caption,
            color: t.sub,
            lineHeight: 1.5,
            // effects quote memos and addresses, which arrive as one unbroken run.
            overflowWrap: "anywhere",
          }}
        >
          {effects.map((e, i) => (
            <li key={i} style={{ marginBottom: 3 }}>
              {e}
            </li>
          ))}
        </ul>
      </div>

      {alreadyDone && (
        <Notice t={t} tone="exposed">
          {alreadyDone}
        </Notice>
      )}
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
      {/* an UNRESOLVED submission is not a failure and may not wear the failure
       * colour. `failOp` asks the worker, whose durable in-flight record is the
       * only authority on it, and the sentence being drawn here is the wallet's
       * own "it may still land, so do not resend": in red, above a live Approve,
       * that is an instruction to pay twice. Activity already drew the same fact
       * as information (History's processing row says so in its own comment) and
       * this surface did not. */}
      {error && (
        <Notice t={t} tone={unresolved ? "exposed" : "danger"}>
          {error}
        </Notice>
      )}
    </>
  );
}

/** a labelled fact on the wallet confirm: the reference's Total / Send / Fee
 *  rows, one per signed fact, so the review reads as a short table not a paragraph.
 *  the label wears the pocket's accent (the reference's blue captions), the value
 *  the ink, and the value may carry a small asset glyph before the figure. */
function FactRow({
  t,
  label,
  info,
  children,
}: {
  t: Theme;
  label: string;
  /** an InfoTip beside the label, for a fact whose consequence needs a sentence. */
  info?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: space.md,
        minHeight: 24,
      }}
    >
      <span
        style={{
          ...text.rowSub,
          fontWeight: 600,
          color: t.accent,
          flex: "0 0 auto",
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {label}
        {info}
      </span>
      <span
        style={{
          ...text.value,
          color: t.text,
          textAlign: "right",
          minWidth: 0,
          overflowWrap: "anywhere",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 8,
        }}
      >
        {children}
      </span>
    </div>
  );
}

/**
 * the review's one status line, the reference's pill in our terms.
 *
 * one pill under the facts, its tone saying what this transaction exposes, and the
 * full "what this does" enumeration one tap away on the info button ON THE LEFT.
 * there used to be a decorative shield beside the info button: two icons for the
 * one affordance, one of them doing nothing, so the shield is gone and the info
 * button stands where it was. a move, whose amount lands on the public ledger,
 * wears the pocket's "this is visible" accent so the one surprising thing is not
 * buried. the label stays "What this does" so the review is named and findable.
 */
function ReviewStatus({ t, exposed, effects }: { t: Theme; exposed: boolean; effects: string[] }) {
  const fg = exposed ? t.exposed : t.sub;
  const bg = exposed ? t.exposedSoft : t.field;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        background: bg,
        borderRadius: radius.pill,
        padding: `10px ${space.md}px`,
      }}
    >
      <InfoTip t={t} label="What this does">
        <ul style={{ margin: 0, paddingLeft: space.md, lineHeight: 1.5 }}>
          {effects.map((e, i) => (
            <li key={i} style={{ marginBottom: 3, overflowWrap: "anywhere" }}>
              {e}
            </li>
          ))}
        </ul>
      </InfoTip>
      <span style={{ ...text.rowSub, fontWeight: 600, color: fg, flex: 1 }}>What this does</span>
    </div>
  );
}

/**
 * the wallet's own confirm, ported from the reference: a mark, the operation, the
 * figure, and the facts being signed as a short table, with "what this does"
 * tucked into an info tip rather than spelled out as prose.
 *
 * this is NOT the dApp confirm. that stays on `ConfirmBody`, which lists every
 * operation, because a site's transaction is arbitrary and the enumeration IS the
 * disclosure. here the operation is one the wallet itself built, so its facts are
 * a table and the explanation is a tip.
 *
 * every SIGNED fact stays VISIBLE: the amount (the hero), the recipient (the full
 * address), the fee and the memo. the suite reconstructs the envelope from these
 * and a fact behind a hover is a blind signature, so only the explanation moves
 * into the tip.
 */
export function WalletReview({
  t,
  heading,
  mark,
  amount,
  code = "XLM",
  treatment = "plain",
  to,
  fee,
  memo,
  fiat,
  effects,
  verb = "Send",
  alreadyDone,
  warning,
  facts,
  blocked,
  error,
  unresolved,
}: {
  t: Theme;
  heading?: string;
  /** the asset glyph, drawn in an accent disc above the operation name. */
  mark?: ReactNode;
  amount?: string;
  code?: string;
  treatment?: Treatment;
  to?: string;
  fee?: string;
  memo?: { value?: string };
  /** a dollar figure for the amount, shown as its own "total value" row. */
  fiat?: number | null;
  effects: string[];
  /** the amount row's label: "Send", "Shield", "Unshield". */
  verb?: string;
  alreadyDone?: string;
  warning?: string;
  blocked?: string;
  error?: string | null;
  /**
   * extra SIGNED facts, one row each, for whatever a flow commits that the
   * amount/fee/memo table cannot name: the destination chain, a swap's minimum
   * received, the dust a bridge cannot carry, a trustline's reserve.
   *
   * rows and not an `effects` line, because `effects` is drawn inside an InfoTip
   * and this file's own rule is that "every SIGNED fact stays VISIBLE ... a fact
   * behind a hover is a blind signature". Sending to Base put the word Base
   * nowhere on the sheet, and the Arbitrum sheet was identical except for an
   * address that is valid on both.
   */
  facts?: { label: string; value: string }[];
  /** the error above is an UNRESOLVED submission, not a failure. see `OpVerdict`. */
  unresolved?: boolean;
}) {
  const exposed = treatment === "exposed";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
      {/* the mark over the operation name: the reference leads its confirm with the
          counterparty's avatar and a title, and so do we. */}
      {(mark || heading) && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          {mark && (
            <IconDisc t={t} size={52}>
              {mark}
            </IconDisc>
          )}
          {heading && <h2 style={{ ...text.screenTitle, color: t.text, margin: 0 }}>{heading}</h2>}
        </div>
      )}

      {/* the recipient, in full: an address is never truncated at a confirm, but
          it is set compact so 56 characters do not fill two tall lines. */}
      {to && (
        <div>
          <div style={{ ...text.label, fontWeight: 600, color: t.accent, marginBottom: 4 }}>To</div>
          <AddressBlock t={t} address={to} compact />
        </div>
      )}

      {/* the signed facts, as the reference's row table. every value here is what
          leaves the machine; the enumeration behind "what this does" is the same
          facts spelled out, one tap away. */}
      {(fiat != null || amount || fee || memo || facts?.length) && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          {fiat != null && (
            <FactRow t={t} label="Total value">
              {usd(fiat)}
            </FactRow>
          )}
          {amount && (
            <FactRow t={t} label={verb}>
              {mark && (
                <span style={{ width: 18, height: 18, display: "flex", flex: "0 0 auto" }}>
                  {mark}
                </span>
              )}
              {/* the amount being signed. see the `reveal` note above. */}
              <Amount
                t={t}
                value={amount}
                code={code}
                size="row"
                treatment={treatment}
                full
                flat
                reveal
              />
            </FactRow>
          )}
          {fee && <FactRow t={t} label="Network fee">{`${fee} XLM`}</FactRow>}
          {memo && (
            <FactRow
              t={t}
              label="Memo"
              // the same sentence, on the wallet's OWN confirm. `NO_MEMO` exists
              // in `copy.ts` because two doors to one consequence must not
              // describe it differently, and it had exactly one reader: the dApp
              // approval screen. the wallet's own send drew a faint "None" and
              // said nothing, on the path most people actually take to an
              // exchange deposit.
              info={
                !memo.value ? (
                  <InfoTip t={t} label="About memos" size={16}>
                    {NO_MEMO}
                  </InfoTip>
                ) : undefined
              }
            >
              {memo.value ? (
                <span style={{ fontFamily: fonts.mono }}>{memo.value}</span>
              ) : (
                <span style={{ color: t.faint }}>None</span>
              )}
            </FactRow>
          )}
          {facts?.map((f) => (
            <FactRow key={f.label} t={t} label={f.label}>
              {f.value}
            </FactRow>
          ))}
        </div>
      )}

      {effects.length > 0 && <ReviewStatus t={t} exposed={exposed} effects={effects} />}

      {alreadyDone && (
        <Notice t={t} tone="exposed">
          {alreadyDone}
        </Notice>
      )}
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
      {/* an UNRESOLVED submission is not a failure and may not wear the failure
       * colour. `failOp` asks the worker, whose durable in-flight record is the
       * only authority on it, and the sentence being drawn here is the wallet's
       * own "it may still land, so do not resend": in red, above a live Approve,
       * that is an instruction to pay twice. Activity already drew the same fact
       * as information (History's processing row says so in its own comment) and
       * this surface did not. */}
      {error && (
        <Notice t={t} tone={unresolved ? "exposed" : "danger"}>
          {error}
        </Notice>
      )}
    </div>
  );
}

export function ReviewPanel({
  t,
  heading,
  mark,
  amount,
  code = "XLM",
  treatment = "plain",
  to,
  fee,
  memo,
  fiat,
  effects,
  warning,
  facts,
  blocked,
  error,
  unresolved,
  busy,
  approveLabel,
  cancelLabel = "Back",
  alreadyDone,
  onApprove,
  onCancel,
  onGoHome,
}: {
  t: Theme;
  /**
   * omitted where the surface around the review already names the operation.
   *
   * the move sheet titles itself "Shielding" at 24px and used to repeat it
   * immediately below at 12px uppercase, which is the same word twice with
   * nothing between them.
   */
  heading?: string;
  /** the asset glyph for the accent disc above the operation name. */
  mark?: ReactNode;
  amount?: string;
  code?: string;
  treatment?: Treatment;
  to?: string;
  /** network fee in decimal XLM, shown as its own row like the reference. */
  fee?: string;
  /** rendered whether present or absent: both cases matter at a confirm step. */
  memo?: { value?: string };
  /** a dollar figure for the amount, shown under it when a price is known. */
  fiat?: number | null;
  effects: string[];
  warning?: string;
  /** set when the wallet could not read what it is being asked to sign. */
  blocked?: string;
  error?: string | null;
  /**
   * extra SIGNED facts, one row each, for whatever a flow commits that the
   * amount/fee/memo table cannot name: the destination chain, a swap's minimum
   * received, the dust a bridge cannot carry, a trustline's reserve.
   *
   * rows and not an `effects` line, because `effects` is drawn inside an InfoTip
   * and this file's own rule is that "every SIGNED fact stays VISIBLE ... a fact
   * behind a hover is a blind signature". Sending to Base put the word Base
   * nowhere on the sheet, and the Arbitrum sheet was identical except for an
   * address that is valid on both.
   */
  facts?: { label: string; value: string }[];
  /** the error above is an UNRESOLVED submission, not a failure. see `OpVerdict`. */
  unresolved?: boolean;
  busy: boolean;
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
  onApprove: () => void;
  onCancel: () => void;
  /** leave for home while the transaction finishes in the worker. */
  onGoHome: () => void;
}) {
  // the SAME body as ConfirmSheet, so the register/merge confirm reads exactly
  // like a send/move confirm. this wrapper exists only because the move sheet owns
  // its own Sheet (it morphs menu -> review -> done in one sheet), where
  // ConfirmSheet is the self-contained-sheet variant. both render WalletReview, so
  // the two can no longer drift the way they did when each carried its own copy.
  // while working, the review gives way to the processing view on its own, the
  // same as ConfirmSheet, so the two surfaces stay identical.
  // the worker's own sentence for the step it is on, when it has one. it
  // publishes eight of them and nothing read a single one, so a private
  // operation (up to 165s of proving) was one unchanging frame for its whole
  // duration. `controller.ts` states the standard beside the phases it sets: "A
  // single unchanging sentence over eight seconds is the picture a hung app
  // shows, and this wallet has just told the user the binding is permanent."
  const phase = usePhase(busy);
  return busy ? (
    <Progress t={t} subtitle={phase ?? undefined} onGoHome={onGoHome} />
  ) : (
    <div style={{ display: "flex", flexDirection: "column", gap: space.gutter }}>
      <WalletReview
        t={t}
        heading={heading}
        mark={mark}
        amount={amount}
        code={code}
        treatment={treatment}
        to={to}
        fee={fee}
        memo={memo}
        fiat={fiat}
        effects={effects}
        alreadyDone={alreadyDone}
        warning={warning}
        facts={facts}
        blocked={blocked}
        error={error}
        unresolved={unresolved}
      />

      <ButtonRow>
        <Button t={t} variant="quiet" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button t={t} disabled={Boolean(blocked) || Boolean(unresolved)} onClick={onApprove}>
          {approveLabel}
        </Button>
      </ButtonRow>
    </div>
  );
}

/**
 * the one payoff moment: a checkmark that draws itself as the transaction lands.
 * the ring and tick stroke in; reduced-motion users get it already complete (the
 * override lives in style.css so the mark is never left as an invisible gap).
 */
function SuccessMark({ t }: { t: Theme }) {
  return (
    <div style={{ display: "flex", justifyContent: "center" }}>
      <svg
        className="pocket-success"
        width={78}
        height={78}
        viewBox="0 0 78 78"
        fill="none"
        aria-hidden
      >
        <circle cx={39} cy={39} r={39} fill={t.accent} />
        <path
          className="pocket-success-check"
          d="M25 40 L35 50 L54 29"
          stroke={t.onAccent}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    </div>
  );
}

/** off screen but in the accessibility tree, which is where the full hash belongs
 *  now that the receipt shows a label and a copy rather than a wall of hex: a
 *  reader still hears it, and the suite still reads it. */
const HIDDEN: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  clipPath: "inset(50%)",
  whiteSpace: "nowrap",
  border: 0,
};

/** a labelled row on the receipt: the reference's Transaction ID / Explorer lines,
 *  a label on the left and a single control on the right. */
function ReceiptRow({ t, label, children }: { t: Theme; label: string; children: ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        minHeight: 46,
      }}
    >
      <span style={{ ...text.body, fontWeight: 600, color: t.sub }}>{label}</span>
      {children}
    </div>
  );
}

export function Receipt({
  t,
  hash,
  note,
  network,
  to,
  onSaveAddress,
  onDone,
}: {
  t: Theme;
  hash: string;
  note?: string;
  /** the network, for the "view on stellar.expert" link. */
  network?: string;
  /** the recipient, so a send can offer to remember it. */
  to?: string;
  /** save the recipient to the address book; absent for operations with no
   *  external recipient (a shield, a merge). */
  onSaveAddress?: (address: string) => void;
  onDone: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), COPY_HOLD_MS);
    return () => clearTimeout(id);
  }, [copied]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
      {/* the mark and the outcome, centred, the reference's success sheet. the
          claim is honest: confirm* only returns AFTER the ledger includes the
          transaction, so "successful" is a confirmed fact, not one claimed before
          it. the ledger line stays as the evidence a reader (and the suite) checks. */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: space.sm,
          textAlign: "center",
          marginTop: space.sm,
        }}
      >
        <SuccessMark t={t} />
        <span
          role="status"
          aria-live="polite"
          style={{ ...text.screenTitle, color: t.accent, marginTop: space.xs }}
        >
          Transaction successful
        </span>
        {note && <div style={{ ...text.body, fontWeight: 600, color: t.sub }}>{note}</div>}
      </div>

      {/* the hash and the explorer as rows, not a block: the row shows a label and
          one control. the full hash is copied on tap and kept in the accessibility
          tree, which is what preserves verifiability without printing hex. */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        <ReceiptRow t={t} label="Transaction ID">
          <button
            type="button"
            aria-label={copied ? "Copied" : "Copy transaction ID"}
            onClick={() =>
              void navigator.clipboard.writeText(hash).then(
                () => setCopied(true),
                () => undefined,
              )
            }
            style={{ all: "unset", cursor: "pointer", display: "flex", color: t.accent }}
          >
            {copied ? <Check size={18} sw={2.4} /> : <Copy size={18} />}
            <span style={HIDDEN}>{hash}</span>
          </button>
        </ReceiptRow>
        {network && (
          <ReceiptRow t={t} label="Explorer">
            <a
              href={explorerUrl(network, "tx", hash)}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Open on stellar.expert"
              style={{ color: t.accent, display: "flex" }}
            >
              <External size={18} />
            </a>
          </ReceiptRow>
        )}
      </div>

      <ButtonStack>
        {to && onSaveAddress && (
          <Button
            t={t}
            variant="quiet"
            disabled={saved}
            onClick={() => {
              onSaveAddress(to);
              setSaved(true);
            }}
          >
            {saved ? "Address saved" : "Save address"}
          </Button>
        )}
        <Button t={t} onClick={onDone}>
          Go to Home
        </Button>
      </ButtonStack>
    </div>
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
  mark,
  verb = "Send",
  amount,
  code = "XLM",
  treatment = "plain",
  to,
  memo,
  fee,
  fiat,
  effects,
  warning,
  facts,
  blocked,
  error,
  unresolved,
  busy,
  approveLabel = "Confirm",
  result,
  note,
  network,
  onApprove,
  onCancel,
  onDone,
  onGoHome,
  onSaveAddress,
  onClosed,
}: {
  t: Theme;
  open: boolean;
  heading?: string;
  /** the asset glyph for the accent disc above the operation name. */
  mark?: ReactNode;
  /** the amount row's label: "Send", "Shield", "Unshield". */
  verb?: string;
  amount?: string;
  code?: string;
  treatment?: Treatment;
  to?: string;
  memo?: { value?: string };
  /** network fee in decimal XLM, shown as its own row like the reference. */
  fee?: string;
  /** a dollar figure for the amount, shown under it when a price is known. */
  fiat?: number | null;
  effects: string[];
  warning?: string;
  blocked?: string;
  error?: string | null;
  /**
   * extra SIGNED facts, one row each, for whatever a flow commits that the
   * amount/fee/memo table cannot name: the destination chain, a swap's minimum
   * received, the dust a bridge cannot carry, a trustline's reserve.
   *
   * rows and not an `effects` line, because `effects` is drawn inside an InfoTip
   * and this file's own rule is that "every SIGNED fact stays VISIBLE ... a fact
   * behind a hover is a blind signature". Sending to Base put the word Base
   * nowhere on the sheet, and the Arbitrum sheet was identical except for an
   * address that is valid on both.
   */
  facts?: { label: string; value: string }[];
  /** the error above is an UNRESOLVED submission, not a failure. see `OpVerdict`. */
  unresolved?: boolean;
  busy: boolean;
  approveLabel?: string;
  /** set once the transaction has landed; the popup then shows the receipt. */
  result?: { hash: string; ledger: number } | null;
  /** a line under the receipt's outcome, e.g. a cross-chain follow-up status. */
  note?: string;
  /** the wallet's network, threaded to the receipt for its explorer link. */
  network?: string;
  onApprove: () => void;
  onCancel: () => void;
  onDone: () => void;
  /** leave for home while the transaction finishes in the worker (the processing
   *  view's only way out; the backdrop is inert while it works). */
  onGoHome: () => void;
  /** remember the recipient from the receipt; absent where there is no external
   *  recipient to save (a shield, a move). */
  onSaveAddress?: (address: string) => void;
  /** fired after the sheet finishes sliding away, so a full-frame host can leave
   *  its route once the receipt has animated out rather than cutting it short. */
  onClosed?: () => void;
}) {
  // see ReviewPanel: the worker's phase for the step it is on, so a long private
  // operation reads as progress rather than as a hung frame.
  const phase = usePhase(busy);
  return (
    <Sheet
      t={t}
      open={open}
      onClose={busy ? () => undefined : result ? onDone : onCancel}
      onClosed={onClosed}
      // NOT `full`: the reference's confirm is a bottom-sheet popup that sizes to
      // its content, with the compose screen dimmed above it, not a page that
      // replaces it. the sheet slides up over the dimmed backdrop, exactly like
      // the receive sheet does.
      // no X: Cancel (review), Go to Home (working) and Done (receipt) are the ways
      // out, and while working the backdrop is inert (onClose is a no-op above), so
      // an approved transaction is never dismissed by a stray tap.
      hideClose
      // still ONLY while reviewing: the working state must move (its sweep) and the
      // receipt draws its checkmark in.
      // the drag is refused for exactly as long as the close is: `onClose` above
      // is a no-op while busy, so a pull would report a dismiss nothing acts on.
      dismissible={!busy}
      still={!busy && !result}
      focusKey={result ? "done" : busy ? "working" : "review"}
    >
      {/* the body fades in on each phase change (review -> working -> receipt): the
          key remounts the block so pocket-fade-in replays, so the two swaps of a
          signing flow crossfade rather than snapping. the review phase is `still`,
          which freezes this fade, which is exactly right: nothing moves while the
          facts are being read. */}
      <div key={result ? "done" : busy ? "working" : "review"} className="pocket-fade-in">
        {result ? (
          <Receipt
            t={t}
            hash={result.hash}
            note={note}
            network={network}
            to={to}
            onSaveAddress={onSaveAddress}
            onDone={onDone}
          />
        ) : busy ? (
          // the working state fills the sheet on its own, the reference's processing
          // view: the mark, "Processing", and the way home while it lands.
          <Progress t={t} subtitle={phase ?? undefined} onGoHome={onGoHome} />
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: space.gutter }}>
            <WalletReview
              t={t}
              heading={heading}
              mark={mark}
              verb={verb}
              amount={amount}
              code={code}
              treatment={treatment}
              to={to}
              fee={fee}
              memo={memo}
              fiat={fiat}
              effects={effects}
              warning={warning}
              facts={facts}
              blocked={blocked}
              error={error}
              unresolved={unresolved}
            />

            <ButtonRow>
              <Button t={t} variant="quiet" onClick={onCancel}>
                Cancel
              </Button>
              <Button t={t} disabled={Boolean(blocked) || Boolean(unresolved)} onClick={onApprove}>
                {approveLabel}
              </Button>
            </ButtonRow>
          </div>
        )}
      </div>
    </Sheet>
  );
}
