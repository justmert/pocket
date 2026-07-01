import { useState } from "react";
import { call } from "../rpc";
import { Button, ButtonStack, Content, Frame, Header, Label, Loading, Notice } from "../primitives";
import { MonoBlock } from "../AddressBlock";
import { space, type Theme } from "../theme";

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
  // Only a thrown error is red. Neither "still pending" nor "it will not land"
  // is a failure of the wallet, and colouring them as one would teach a user to
  // ignore the colour that matters.
  const [outcome, setOutcome] = useState<{ tone: "info" | "danger"; text: string } | null>(null);

  async function check() {
    setChecking(true);
    setOutcome(null);
    try {
      const r = await call({ type: "reconcileInFlight" });
      if (!r) return onResolved();
      if (r.kind === "succeeded") return onResolved();
      setOutcome(
        r.kind === "pending"
          ? {
              tone: "info",
              text: "Still not confirmed. It may yet land, so it must not be resent.",
            }
          : { tone: "info", text: "Resolved: it will not land. You can carry on." },
      );
      // Anything terminal clears the record in the worker, so leaving is safe.
      if (r.kind !== "pending") setTimeout(onResolved, 1500);
    } catch (e) {
      setOutcome({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  }

  return (
    <Frame t={t}>
      <Header title="Unfinished transaction" t={t} />
      <Content>
        <Notice tone="exposed" t={t}>
          Pocket submitted a transaction and did not see whether it confirmed. It may still be on
          its way. Do not send it again until this is resolved.
        </Notice>

        <Label t={t}>Transaction hash</Label>
        <MonoBlock t={t}>{record.hash}</MonoBlock>

        <div style={{ marginTop: space.lg }}>
          {record.expired ? (
            <Notice t={t}>
              Its time window has passed, so it can no longer be included. If it has not confirmed
              by now, it never will.
            </Notice>
          ) : (
            <Notice t={t}>
              It can still be included until {deadline(record.maxTime)}. After that it can only
              fail.
            </Notice>
          )}

          {outcome && (
            <Notice tone={outcome.tone} t={t}>
              {outcome.text}
            </Notice>
          )}

          {checking ? (
            <Loading label="Checking the ledger…" t={t} />
          ) : (
            <ButtonStack>
              <Button t={t} onClick={() => void check()}>
                Check now
              </Button>
              {record.expired && (
                <Button t={t} variant="quiet" onClick={onResolved}>
                  Continue anyway
                </Button>
              )}
            </ButtonStack>
          )}
        </div>
      </Content>
    </Frame>
  );
}

/**
 * The only clock the wallet shows. Local time, no date: the window is minutes
 * wide, so a date would be noise and a relative "in 4 minutes" would go stale
 * on a screen that sits open.
 */
function deadline(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
