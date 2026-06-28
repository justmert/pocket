import { useCallback, useEffect, useRef, useState } from "react";
import { call } from "../rpc";
import {
  Button,
  ButtonRow,
  ButtonStack,
  Content,
  Field,
  Frame,
  Header,
  Label,
  Loading,
  Notice,
  SectionLabel,
  TextButton,
} from "../primitives";
import { AddressBlock, MonoBlock } from "../AddressBlock";
import { Money } from "../Money";
import { leading, space, text, type MoneyTreatment, type Theme } from "../theme";
import type {
  PrivatePocket as PocketState,
  PrivateOpRequest,
  PrivateOpSummary,
} from "../../../../core/messages";

/**
 * The private pocket.
 *
 * Two balances are shown separately and always. Hiding the distinction produces
 * "why can't I send my own money" tickets: a deposit lands in the receiving
 * side and needs a merge before it can be sent.
 *
 * The word "pending" is deliberately NOT used here. It already means an
 * in-flight transaction, which resolves by waiting, whereas a receiving balance
 * resolves by signing. Calling both "pending" would have users waiting for
 * something that needs a tap.
 *
 * Every action routes through the same three steps: build and prove, review
 * the effects, then sign. Nothing is signed from this file, and nothing here
 * decides what an operation does; the worker builds the envelope and states its
 * effects, and this screen only renders them.
 */
export function PrivatePocket({ t, onBack }: { t: Theme; onBack: () => void }) {
  const [p, setP] = useState<PocketState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [review, setReview] = useState<{ handle: string; summary: PrivateOpSummary } | null>(null);
  const [done, setDone] = useState<{ hash: string; followed?: string } | null>(null);
  // A ref, not state: a double click outruns a re-render.
  const confirmingRef = useRef(false);
  const [form, setForm] = useState<{
    kind: PrivateOpRequest["kind"];
    to: string;
    amount: string;
  } | null>(null);

  const refresh = useCallback(async () => {
    try {
      setP(await call({ type: "privatePocket" }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Proving happens in the offscreen document and takes a few hundred
  // milliseconds, so the wait is named rather than left as a bare spinner.
  // While a long operation runs, ask the worker what it is actually doing.
  // The phases are real and it is the only context that knows them; the
  // alternative is one unchanging sentence over eight seconds, which is the
  // picture a hung app shows.
  useEffect(() => {
    if (!busy) return;
    const id = setInterval(() => {
      void call({ type: "currentPhase" })
        .then((p) => {
          if (p) setBusy(p);
        })
        .catch(() => undefined);
    }, 400);
    return () => clearInterval(id);
  }, [busy]);

  const start = useCallback(async (op: PrivateOpRequest, label: string) => {
    setError(null);
    setDone(null);
    setBusy(label);
    try {
      setReview(await call({ type: "buildPrivateOp", op }));
      setForm(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, []);

  const confirm = useCallback(async () => {
    if (!review) return;
    // Same guard as the public send. Two clicks reach the worker, it serialises
    // them, the money moves once, and the second resolves last with "no longer
    // pending confirmation" -- an error rendered on top of a success.
    if (confirmingRef.current) return;
    confirmingRef.current = true;
    setError(null);
    setBusy("Signing and submitting…");
    try {
      const r = await call({ type: "confirmPrivateOp", handle: review.handle });
      setReview(null);
      setDone({ hash: r.hash, followed: r.followed });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setReview(null);
    } finally {
      setBusy(null);
      confirmingRef.current = false;
    }
  }, [review, refresh]);

  if (review) {
    return (
      <ReviewScreen
        t={t}
        summary={review.summary}
        busy={busy}
        onApprove={() => void confirm()}
        onCancel={() => setReview(null)}
      />
    );
  }

  const ready = p?.state === "ready";

  return (
    <Frame t={t}>
      <Header
        title="Private pocket"
        t={t}
        right={
          <TextButton t={t} onClick={onBack}>
            Close
          </TextButton>
        }
      />
      <Content>
        {error && (
          <Notice tone="danger" t={t}>
            {error}
          </Notice>
        )}

        {done && (
          <Notice tone="success" t={t}>
            Confirmed on the ledger.
            <div style={{ marginTop: space.xs }}>
              <MonoBlock t={t}>{done.hash}</MonoBlock>
            </div>
            {done.followed && (
              <div style={{ marginTop: space.xs }}>Made spendable in a second transaction.</div>
            )}
          </Notice>
        )}

        {!p && !error && <Loading label="Reading the ledger…" t={t} />}

        {/* The balances stay on screen while an operation runs. Blanking them
            for the length of a proof left the longest wait in the wallet
            looking like a screen that had failed to load. */}
        {ready && (
          <>
            <SectionLabel t={t}>SPENDABLE</SectionLabel>
            {/* A missing balance is reported as missing. Falling back to a zero
                would put a number on screen that no ledger ever said. */}
            {p.spendable ? (
              <Money amount={p.spendable} code="XLM" treatment="sealed" size="hero" t={t} />
            ) : (
              <Unreported t={t} />
            )}

            <div style={{ marginTop: space.xl }}>
              <SectionLabel t={t}>RECEIVING</SectionLabel>
            </div>
            {p.receiving ? (
              <Money amount={p.receiving} code="XLM" treatment="sealed" size="row" t={t} />
            ) : (
              <Unreported t={t} />
            )}

            {busy ? (
              <div style={{ marginTop: space.xl }}>
                <Loading label={busy} t={t} />
              </div>
            ) : (
              <>
                {p.mergeAvailable && (
                  <div style={{ marginTop: space.lg }}>
                    <Notice t={t}>
                      Received funds sit here until you make them spendable. One signature, no fee
                      beyond the network's.
                    </Notice>
                    <Button t={t} onClick={() => void start({ kind: "merge" }, "Building…")}>
                      Make spendable
                    </Button>
                  </div>
                )}

                {form ? (
                  <OpForm
                    t={t}
                    kind={form.kind}
                    to={form.to}
                    amount={form.amount}
                    onChange={(f) => setForm({ ...form, ...f })}
                    onCancel={() => setForm(null)}
                    onSubmit={() =>
                      void start(
                        form.kind === "transfer"
                          ? { kind: "transfer", to: form.to, amount: form.amount }
                          : form.kind === "shield"
                            ? { kind: "shield", amount: form.amount }
                            : { kind: "unshield", amount: form.amount },
                        form.kind === "shield" ? "Building…" : "Proving. This takes a moment…",
                      )
                    }
                  />
                ) : (
                  <ButtonStack>
                    <Button t={t} onClick={() => setForm({ kind: "transfer", to: "", amount: "" })}>
                      Send privately
                    </Button>
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: space.md,
                      }}
                    >
                      <Button
                        t={t}
                        variant="quiet"
                        onClick={() => setForm({ kind: "shield", to: "", amount: "" })}
                      >
                        Move in
                      </Button>
                      <Button
                        t={t}
                        variant="quiet"
                        onClick={() => setForm({ kind: "unshield", to: "", amount: "" })}
                      >
                        Move out
                      </Button>
                    </div>
                  </ButtonStack>
                )}
              </>
            )}

            {typeof p.daysRemaining === "number" && p.daysRemaining < 8 && (
              <div style={{ marginTop: space.xl }}>
                <Notice tone="exposed" t={t}>
                  This pocket goes dormant in {p.daysRemaining} days unless it is used. Pocket
                  schedules a keep-alive transaction while it is unlocked, but a browser that is
                  closed cannot send one. Opening the wallet before then is what guarantees it.
                </Notice>
              </div>
            )}
          </>
        )}

        {p && !ready && (
          <>
            <div style={{ ...text.heading, marginBottom: space.md }}>{titleFor(p.state)}</div>
            <Notice tone={toneFor(p.state)} t={t}>
              {p.message}
            </Notice>
            {busy && <Loading label={busy} t={t} />}
            {!busy && p.state === "unregistered" && (
              <>
                {/* The three facts that are permanent or public, stated before
                    the button, not after it. */}
                <ul
                  style={{
                    ...text.body,
                    color: t.sub,
                    paddingLeft: space.gutter,
                    lineHeight: leading.relaxed,
                // These lines quote things the user or the chain chose: a memo,
                // an address, an asset code. A 28-byte memo is very often one
                // unbroken token, because that is what exchange deposit memos
                // are, and without this the frame's `overflow: hidden` cuts it
                // rather than wrapping. Cutting the memo on the screen that
                // asks you to approve the memo is the worst place for it.
                overflowWrap: "anywhere",
                    marginBottom: space.lg,
                  }}
                >
                  <li>Setting up is a public transaction. Anyone can see this account has one.</li>
                  <li>
                    Your address stays public on every private payment. Only amounts are hidden.
                  </li>
                  <li>
                    Your auditor key is derived from your recovery phrase, so only you can read your
                    amounts. It is bound permanently and cannot be changed later.
                  </li>
                </ul>
                <Button
                  t={t}
                  onClick={() =>
                    void start({ kind: "register" }, "Setting up. This takes a moment…")
                  }
                >
                  Set up the private pocket
                </Button>
              </>
            )}
            {!busy && p.state === "archived" && (
              <Button t={t} onClick={() => void start({ kind: "merge" }, "Reactivating…")}>
                Reactivate
              </Button>
            )}
            {(p.state === "diverged" || p.state === "needsRecovery") && (
              <>
                <Notice tone="exposed" t={t}>
                  Your funds are safe on chain. Rebuilding replays your event history from the
                  durable archive and checks the result against what the contract holds, so a
                  wrong or incomplete history is refused rather than accepted.
                </Notice>
                <Button
                  t={t}
                  onClick={() => {
                    setError(null);
                    setBusy("Replaying your history…");
                    void call({ type: "rebuildFromHistory" })
                      .then((next) => setP(next))
                      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
                      .finally(() => setBusy(null));
                  }}
                >
                  Rebuild from history
                </Button>
              </>
            )}
          </>
        )}
      </Content>
    </Frame>
  );
}

/** No number at all, rather than a zero nobody's ledger reported. */
function Unreported({ t }: { t: Theme }) {
  return (
    <div style={{ ...text.body, color: t.sub }}>
      Not reported. Close and reopen the wallet to read it again.
    </div>
  );
}

/**
 * What each operation is called, in the words the user just tapped. The
 * request `kind` is a protocol name: "SHIELD" and "UNSHIELD" appear nowhere
 * else in the wallet, and a review screen is the worst place to introduce two
 * new words for something the previous screen called "Move in".
 */
const OP_LABELS: Record<PrivateOpRequest["kind"], string> = {
  register: "SETTING UP",
  shield: "MOVING IN",
  merge: "MAKING SPENDABLE",
  transfer: "SENDING PRIVATELY",
  unshield: "MOVING OUT",
};

/**
 * How the amount is treated at the moment of signing. `exposed` is reserved
 * for an amount that is or is becoming public, which is exactly what a deposit
 * and a withdrawal are, and a private transfer is `sealed`. Rendering all
 * three the same way threw away the one signal that distinguishes them.
 */
const OP_TREATMENTS: Record<PrivateOpRequest["kind"], MoneyTreatment> = {
  register: "plain",
  shield: "exposed",
  merge: "sealed",
  transfer: "sealed",
  unshield: "exposed",
};

/** Approval. Every effect the worker stated, rendered before anything is signed. */
function ReviewScreen({
  t,
  summary,
  busy,
  onApprove,
  onCancel,
}: {
  t: Theme;
  summary: PrivateOpSummary;
  busy: string | null;
  onApprove: () => void;
  onCancel: () => void;
}) {
  return (
    <Frame t={t}>
      <Header title="Review" t={t} />
      <Content>
        <SectionLabel t={t}>{OP_LABELS[summary.kind] ?? summary.kind.toUpperCase()}</SectionLabel>
        {summary.amount && (
          <div style={{ marginBottom: space.lg }}>
            <Money
              amount={summary.amount}
              code="XLM"
              size="section"
              treatment={OP_TREATMENTS[summary.kind] ?? "plain"}
              t={t}
            />
          </div>
        )}
        {summary.to && (
          <div style={{ marginBottom: space.lg }}>
            <Label t={t}>To</Label>
            {/* Full address, never truncated: a 4+4 lookalike costs about an
                hour to grind, so an abbreviation is not a safe way to confirm. */}
            <AddressBlock address={summary.to} t={t} />
          </div>
        )}

        <Label t={t}>What this does</Label>
        {/* The fee is one of these effects, stated by the worker. It used to be
            repeated underneath as well, one line apart. */}
        <ul
          style={{
            ...text.body,
            color: t.text,
            paddingLeft: space.gutter,
            margin: 0,
            lineHeight: leading.relaxed,
          }}
        >
          {summary.effects.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>

        {busy ? (
          <div style={{ marginTop: space.gutter }}>
            <Loading label={busy} t={t} />
          </div>
        ) : (
          <ButtonRow>
            <Button t={t} variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
            <Button t={t} onClick={onApprove}>
              Approve
            </Button>
          </ButtonRow>
        )}
      </Content>
    </Frame>
  );
}

function OpForm({
  t,
  kind,
  to,
  amount,
  onChange,
  onCancel,
  onSubmit,
}: {
  t: Theme;
  kind: PrivateOpRequest["kind"];
  to: string;
  amount: string;
  onChange: (f: Partial<{ to: string; amount: string }>) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const ready = amount.trim() !== "" && (kind !== "transfer" || to.trim() !== "");
  return (
    <div style={{ marginTop: space.xl }}>
      <div style={{ ...text.heading, marginBottom: space.lg }}>
        {kind === "transfer"
          ? "Send privately"
          : kind === "shield"
            ? "Move into the private pocket"
            : "Move back to the public pocket"}
      </div>
      {kind === "transfer" && (
        <Field
          t={t}
          label="To"
          value={to}
          onChange={(v) => onChange({ to: v })}
          placeholder="G..."
        />
      )}
      <Field
        t={t}
        label="Amount (XLM)"
        value={amount}
        onChange={(v) => onChange({ amount: v })}
        placeholder="0.0000000"
      />
      {kind === "shield" && (
        <Notice tone="exposed" t={t}>
          This amount is public. Shielding hides what you do next, not the fact that you moved this
          much in.
        </Notice>
      )}
      {kind === "unshield" && (
        <Notice tone="exposed" t={t}>
          This amount becomes public when it lands in the public pocket.
        </Notice>
      )}
      <ButtonRow>
        <Button t={t} variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button t={t} disabled={!ready} onClick={onSubmit}>
          Review
        </Button>
      </ButtonRow>
    </div>
  );
}

function titleFor(state: string): string {
  return (
    {
      unregistered: "Not set up yet",
      unfunded: "Fund this account first",
      archived: "Dormant",
      diverged: "Records do not match the ledger",
      needsRecovery: "Balances need rebuilding",
      unavailable: "Not available here",
      unspendable: "Temporarily unspendable",
    }[state] ?? state
  );
}

function toneFor(state: string): "danger" | "exposed" | undefined {
  if (state === "diverged") return "danger";
  if (state === "archived" || state === "unregistered" || state === "needsRecovery") {
    return "exposed";
  }
  return undefined;
}
