import { useEffect, useState } from "react";
import { call } from "../rpc";
import { Button, Frame, Header, Notice, Spinner } from "../primitives";
import { Money } from "../Money";
import { text, type Theme } from "../theme";
import type { PrivatePocket as PocketState } from "../../../../core/messages";

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
 */
export function PrivatePocket({ t, onBack }: { t: Theme; onBack: () => void }) {
  const [p, setP] = useState<PocketState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const s = await call({ type: "privatePocket" });
        if (live) setP(s);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

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
      <div style={{ padding: 18, flex: 1 }}>
        {error && (
          <Notice tone="danger" t={t}>
            {error}
          </Notice>
        )}

        {!p && !error && (
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <Spinner t={t} />
            <span style={{ ...text.body, color: t.sub }}>Reading the ledger…</span>
          </div>
        )}

        {p?.state === "ready" && (
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
                <Button t={t}>Make spendable</Button>
              </div>
            )}

            {typeof p.daysRemaining === "number" && p.daysRemaining < 8 && (
              <Notice tone="exposed" t={t}>
                This pocket goes dormant in {p.daysRemaining} days unless it is used. Pocket will
                keep it alive automatically.
              </Notice>
            )}
          </>
        )}

        {p && p.state !== "ready" && (
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
                <Button t={t}>Set up the private pocket</Button>
              </>
            )}
            {p.state === "archived" && <Button t={t}>Reactivate</Button>}
            {p.state === "diverged" && (
              <Button t={t} variant="quiet">
                Rebuild from history
              </Button>
            )}
          </>
        )}
      </div>
    </Frame>
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

function toneFor(state: string): "info" | "exposed" | "danger" {
  if (state === "diverged") return "danger";
  if (state === "archived" || state === "unregistered") return "exposed";
  return "info";
}
