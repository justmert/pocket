import { useEffect, useRef, useState } from "react";
import { call } from "../rpc";
import { MonoBlock } from "../Address";
import { Button, ButtonStack, Header, Label, Notice, Screen, Spinner } from "../primitives";
import { space, text, type Theme } from "../theme";
import { describeOutcome } from "../../../../core/chain/submit";
import type { InFlightRecord } from "../WalletProvider";

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
  record: InFlightRecord;
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
      if (!result) {
        onResolved();
        return;
      }
      if (result.kind === "pending") {
        setOutcome({
          tone: "exposed",
          text: "Still not confirmed. It may yet land, so it must not be resent.",
        });
      } else {
        // Five terminal outcomes, and this branch used to collapse four of them
        // into "Resolved: it will not land. You can carry on." One of the four
        // is `failed`, which means the transaction WAS included, a fee WAS
        // charged and the sequence number WAS used. Telling someone that did
        // not land is not a softening, it is the opposite of what happened, on
        // the one screen they came to specifically to find out.
        //
        // `describeOutcome` is the worker's own sentence for each kind, and it
        // already said all five correctly; nothing on this path was reading it.
        // Using it here also means the wording cannot drift from the wording
        // the same outcome gets anywhere else.
        //
        // Tone follows cost, not finality: `failed` cost money, so it is not
        // positive news even though it is resolved.
        setOutcome({
          tone: result.kind === "failed" ? "danger" : "positive",
          text: describeOutcome(result),
        });
        // `succeeded` gets a beat too. It used to navigate away in silence, so
        // the screen that exists to answer "what happened to my transaction?"
        // answered it by vanishing.
        resolveTimer.current = setTimeout(onResolved, result.kind === "failed" ? 4000 : 1500);
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
        {record.windowPassed
          ? record.answered
            ? "Its time window has passed and the ledger does not have it, so it can never be applied."
            : "Its time window has passed, so it can no longer be included. Pocket has not been " +
              "able to reach the ledger to confirm whether it landed before then."
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
          {/* `.pocket-pulse` was declared, keyframed and consumed by nothing. this
              is the wait it suits: the spinner says work is happening and the
              sentence breathes with it, rather than sitting dead beside a moving
              ring on the one screen a user is asked to sit through. */}
          <span className="pocket-pulse">Checking the ledger</span>
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
