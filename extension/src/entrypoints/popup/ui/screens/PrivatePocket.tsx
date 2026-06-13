import { useCallback, useEffect, useState } from "react";
import { call } from "../rpc";
import { Button, Field, Frame, Header, Notice, Spinner } from "../primitives";
import { AddressBlock } from "../AddressBlock";
import { Money } from "../Money";
import { text, type Theme } from "../theme";
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
  const [form, setForm] = useState<{ kind: PrivateOpRequest["kind"]; to: string; amount: string } | null>(
    null,
  );

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

  return (
    <Frame t={t}>
      <Header
        title="Private pocket"
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
      <div style={{ padding: 18, flex: 1, overflowY: "auto" }}>
        {error && (
          <Notice tone="danger" t={t}>
            {error}
          </Notice>
        )}

        {done && (
          <Notice t={t}>
            Confirmed on the ledger.
            <div style={{ ...text.caption, fontFamily: "ui-monospace, monospace", marginTop: 6, wordBreak: "break-all" as const }}>
              {done.hash}
            </div>
            {done.followed && (
              <div style={{ marginTop: 6 }}>Made spendable in a second transaction.</div>
            )}
          </Notice>
        )}

        {busy && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
            <Spinner t={t} />
            <span style={{ ...text.body, color: t.sub }}>{busy}</span>
          </div>
        )}

        {!p && !error && !busy && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Spinner t={t} />
            <span style={{ ...text.body, color: t.sub }}>Reading the ledger…</span>
          </div>
        )}

        {p?.state === "ready" && !busy && (
          <>
            <div style={{ ...text.caption, color: t.faint, marginBottom: 6 }}>SPENDABLE</div>
            <Money amount={p.spendable ?? "0"} code="XLM" treatment="sealed" size={30} t={t} />

            <div style={{ ...text.caption, color: t.faint, margin: "20px 0 6px" }}>RECEIVING</div>
            <Money amount={p.receiving ?? "0"} code="XLM" treatment="sealed" size={20} t={t} />
            {p.mergeAvailable && (
              <div style={{ marginTop: 12 }}>
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
              <div style={{ display: "grid", gap: 10, marginTop: 22 }}>
                <Button
                  t={t}
                  onClick={() => setForm({ kind: "transfer", to: "", amount: "" })}
                >
                  Send privately
                </Button>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
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
              </div>
            )}

            {typeof p.daysRemaining === "number" && p.daysRemaining < 8 && (
              <Notice tone="exposed" t={t}>
                This pocket goes dormant in {p.daysRemaining} days unless it is used. Pocket
                schedules a keep-alive transaction while it is unlocked, but a browser that is
                closed cannot send one. Opening the wallet before then is what guarantees it.
              </Notice>
            )}
          </>
        )}

        {p && p.state !== "ready" && !busy && (
          <>
            <div style={{ ...text.heading, marginBottom: 10 }}>{titleFor(p.state)}</div>
            <Notice tone={toneFor(p.state)} t={t}>
              {p.message}
            </Notice>
            {p.state === "unregistered" && (
              <>
                {/* The three facts that are permanent or public, stated before
                    the button, not after it. */}
                <ul
                  style={{
                    ...text.body,
                    color: t.sub,
                    paddingLeft: 18,
                    lineHeight: 1.7,
                    marginBottom: 16,
                  }}
                >
                  <li>Setting up is a public transaction. Anyone can see this account has one.</li>
                  <li>
                    Your address stays public on every private payment. Only amounts are hidden.
                  </li>
                  <li>The auditor you bind now cannot be changed later.</li>
                </ul>
                <Button
                  t={t}
                  onClick={() =>
                    void start({ kind: "register", auditorId: 0 }, "Proving. This takes a moment…")
                  }
                >
                  Set up the private pocket
                </Button>
              </>
            )}
            {p.state === "archived" && (
              <Button t={t} onClick={() => void start({ kind: "merge" }, "Reactivating…")}>
                Reactivate
              </Button>
            )}
            {(p.state === "diverged" || p.state === "needsRecovery") && (
              // Deliberately not a button. Replaying history needs an archive
              // endpoint, and none is configured in this build; offering a
              // control that cannot work would repeat the exact problem this
              // screen had.
              <Notice tone="exposed" t={t}>
                Rebuilding needs a durable event archive, and this build has none configured. Your
                funds are safe on chain. Pocket will not spend from a state it cannot verify.
              </Notice>
            )}
          </>
        )}
      </div>
    </Frame>
  );
}

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
      <div style={{ padding: 18, flex: 1, overflowY: "auto" }}>
        <div style={{ ...text.caption, color: t.faint, marginBottom: 8 }}>
          {summary.kind.toUpperCase()}
        </div>
        {summary.amount && (
          <div style={{ marginBottom: 14 }}>
            <Money amount={summary.amount} code="XLM" size={28} t={t} />
          </div>
        )}
        {summary.to && (
          <div style={{ marginBottom: 14 }}>
            <div style={{ ...text.label, color: t.sub, marginBottom: 6 }}>To</div>
            {/* Full address, never truncated: a 4+4 lookalike costs about an
                hour to grind, so an abbreviation is not a safe way to confirm. */}
            <AddressBlock address={summary.to} t={t} />
          </div>
        )}

        <div style={{ ...text.label, color: t.sub, margin: "18px 0 8px" }}>What this does</div>
        <ul style={{ ...text.body, color: t.text, paddingLeft: 18, lineHeight: 1.7 }}>
          {summary.effects.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>

        <div style={{ ...text.caption, color: t.faint, marginTop: 14 }}>
          Network fee {summary.fee} XLM
        </div>

        {busy ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 18 }}>
            <Spinner t={t} />
            <span style={{ ...text.body, color: t.sub }}>{busy}</span>
          </div>
        ) : (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 18 }}>
            <Button t={t} variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
            <Button t={t} onClick={onApprove}>
              Approve
            </Button>
          </div>
        )}
      </div>
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
    <div style={{ marginTop: 22 }}>
      <div style={{ ...text.label, color: t.sub, marginBottom: 10 }}>
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
        label="Amount"
        value={amount}
        onChange={(v) => onChange({ amount: v })}
        placeholder="0.0000000"
      />
      {kind === "shield" && (
        <Notice tone="exposed" t={t}>
          This amount is public. Shielding hides what you do next, not the fact that you moved
          this much in.
        </Notice>
      )}
      {kind === "unshield" && (
        <Notice tone="exposed" t={t}>
          This amount becomes public when it lands in the public pocket.
        </Notice>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 12 }}>
        <Button t={t} variant="quiet" onClick={onCancel}>
          Cancel
        </Button>
        <Button t={t} disabled={!ready} onClick={onSubmit}>
          Review
        </Button>
      </div>
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
