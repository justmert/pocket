import { useEffect, useRef, useState } from "react";
import { call } from "../rpc";
import { MonoBlock } from "../Address";
import { Button, ButtonStack, Header, Label, Notice, Screen, Spinner } from "../primitives";
import { space, text, type Theme } from "../theme";

/**
 * a transaction the worker submitted and never saw resolve.
 *
 * this screen exists to stop a second one being sent. it outranks every other
 * view for that reason, and the only way past it without an answer is when the
 * time window has already closed.
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
  // the outcome tones are chosen so Notice attaches a live region: only
  // danger/positive/exposed announce to a screen reader, and this screen exists
  // to tell the user whether a transaction landed, so the answer must be spoken.
  const [outcome, setOutcome] = useState<{
    tone: "exposed" | "positive" | "danger";
    text: string;
  } | null>(null);
  // the resolved branch auto-advances after a beat. hold the timer so it can be
  // cleared if the screen unmounts first, otherwise onResolved fires into a gone tree.
  const resolveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (resolveTimer.current !== null) clearTimeout(resolveTimer.current);
    },
    [],
  );

  const check = async () => {
    setChecking(true);
    setOutcome(null);
    try {
      const result = await call({ type: "reconcileInFlight" });
      if (!result || result.kind === "succeeded") {
        onResolved();
        return;
      }
      if (result.kind === "pending") {
        setOutcome({
          tone: "exposed",
          text: "Still not confirmed. It may yet land, so it must not be resent.",
        });
      } else {
        setOutcome({ tone: "positive", text: "Resolved: it will not land. You can carry on." });
        resolveTimer.current = setTimeout(onResolved, 1500);
      }
    } catch (e) {
      setOutcome({ tone: "danger", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setChecking(false);
    }
  };

  return (
    <Screen t={t} still>
      <Header t={t} title="Unfinished transaction" />
      <Notice t={t} tone="exposed">
        Pocket submitted a transaction and did not see whether it confirmed. Do not send it again
        until this is resolved.
      </Notice>

      <Label t={t}>Transaction hash</Label>
      <MonoBlock t={t}>{record.hash}</MonoBlock>

      <div style={{ ...text.body, color: t.sub, marginTop: space.md, lineHeight: 1.5 }}>
        {record.expired
          ? "Its time window has passed, so it can no longer be included."
          : `It can still be included until ${deadline(record.maxTime)}.`}
      </div>

      {outcome && (
        <div style={{ marginTop: space.md }}>
          <Notice t={t} tone={outcome.tone}>
            {outcome.text}
          </Notice>
        </div>
      )}

      {checking ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            marginTop: space.gutter,
            color: t.sub,
            ...text.body,
          }}
          role="status"
          aria-live="polite"
        >
          <Spinner size={17} color={t.accent} />
          Checking the ledger
        </div>
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
    </Screen>
  );
}

/** the only clock in the wallet: local time, hour and minute, no date. */
function deadline(maxTime: number): string {
  return new Date(maxTime * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}
