import { useState } from "react";
import { call } from "../rpc";
import { Button, Frame, Header, Notice, Spinner } from "../primitives";
import { text, type Theme } from "../theme";

/**
 * A transaction that was submitted but whose outcome we never saw.
 *
 * MV3 kills the service worker aggressively, and confirmation polling takes
 * around fifteen seconds, so this is a routine event rather than an edge case.
 *
 * The rule the screen exists to enforce: NEVER resend. A submitted transaction
 * may still land, and rebuilding it while the first is unresolved is how a user
 * pays twice. It resolves by polling the hash, and only offers to move on once
 * the original's time bounds have passed, at which point it can no longer be
 * included.
 */
export function InFlight({
  t,
  record,
  onResolved,
}: {
  t: Theme;
  record: { hash: string; maxTime: number; expired: boolean };
  onResolved: () => void;
}) {
  const [checking, setChecking] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setOutcome(null);
    try {
      const r = await call({ type: "reconcileInFlight" });
      if (!r) return onResolved();
      if (r.kind === "succeeded") return onResolved();
      setOutcome(
        r.kind === "pending"
          ? "Still not confirmed. It may yet land, so it must not be resent."
          : "Resolved: it will not land. You can carry on.",
      );
      // Anything terminal clears the record in the worker, so leaving is safe.
      if (r.kind !== "pending") setTimeout(onResolved, 1500);
    } catch (e) {
      setOutcome(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }

  return (
    <Frame t={t}>
      <Header title="Unfinished transaction" t={t} />
      <div style={{ padding: 18, flex: 1 }}>
        <Notice tone="exposed" t={t}>
          Pocket submitted a transaction and did not see whether it confirmed. It may still be
          on its way. Do not send it again until this is resolved.
        </Notice>

        <div style={{ ...text.label, color: t.sub, margin: "18px 0 6px" }}>Transaction hash</div>
        <div
          style={{
            ...text.body,
            fontFamily: "ui-monospace, monospace",
            wordBreak: "break-all",
            color: t.text,
          }}
        >
          {record.hash}
        </div>

        {record.expired && (
          <Notice t={t}>
            Its time window has passed, so it can no longer be included. If it has not confirmed
            by now, it never will.
          </Notice>
        )}

        {outcome && <Notice t={t}>{outcome}</Notice>}

        <div style={{ marginTop: 18 }}>
          {checking ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <Spinner t={t} />
              <span style={{ ...text.body, color: t.sub }}>Checking the ledger…</span>
            </div>
          ) : (
            <>
              <Button t={t} onClick={() => void check()}>
                Check now
              </Button>
              {record.expired && (
                <>
                  <div style={{ height: 8 }} />
                  <Button t={t} variant="quiet" onClick={onResolved}>
                    Continue anyway
                  </Button>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </Frame>
  );
}
