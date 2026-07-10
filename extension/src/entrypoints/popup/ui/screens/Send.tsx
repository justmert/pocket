// send, as a page rather than a panel.
//
// it fills the frame because composing a payment is the task, not an aside from
// it: the amount is the largest thing on screen, the recipient is directly under
// it, and nothing else competes. the pickers it opens ARE sheets, because
// choosing an asset or a recipient is genuinely an aside from the compose step.
//
// the review and the signing path are untouched. this file builds a payment and
// hands it to `flow.tsx`, exactly as the sheet it replaces did: what is signed
// must keep matching what is shown, and that correspondence is asserted by
// tests/qa/signed-equals-shown.spec.ts.
import { useEffect, useRef, useState } from "react";
import { BASE_FEE } from "@stellar/stellar-sdk/base";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Header, Notice, Screen, Sheet, Row } from "../primitives";
import { Receipt, ReviewPanel, useOnce, usePhase } from "../flow";
import { AssetMark } from "./Home";
import { fractionOf, sendableAfterFee } from "../../../../core/chain/balances";
import { fontSizes, radius, space, text, type Theme } from "../theme";
import type { PrivateOpSummary, PublicBalance, TransferSummary } from "../../../../core/messages";

type Stage = "compose" | "review" | "done";

/**
 * what a payment costs, in stroops.
 *
 * stellar-sdk states BASE_FEE as a decimal string of stroops. read here rather
 * than written as a literal so "max" cannot drift away from what
 * `chain/payment.ts` actually charges.
 */
const BASE_FEE_STROOPS = BigInt(BASE_FEE);

/**
 * why there is nothing to send yet, in the words the rest of the product uses.
 *
 * one sentence per state rather than one for all of them: "you cannot send" is
 * true everywhere and useful nowhere, and the state is what tells someone which
 * of these is one press from fixed and which is not.
 */
const PRIVATE_NOT_READY: Record<string, string> = {
  unavailable: "This network has no private pocket, so there is nothing to send from.",
  unfunded:
    "This account does not exist on the network yet. Receive some XLM first, then you can open a private pocket.",
  unregistered:
    "The private pocket is not open yet. Setting it up takes two transactions, and you review the second one.",
  archived: "The private pocket went dormant from not being used. Reactivate it before sending.",
  needsRecovery:
    "This device's record of the private balances has to be rebuilt before anything can be sent.",
  diverged:
    "This device disagrees with the contract about the private balances, so it refuses to spend until that is rebuilt.",
  ready: "",
};

export function Send({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const isPrivate = w.pocket === "private";

  const [stage, setStage] = useState<Stage>("compose");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [publicSummary, setPublicSummary] = useState<TransferSummary | null>(null);
  const [privateSummary, setPrivateSummary] = useState<PrivateOpSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [assetId, setAssetId] = useState("native");
  const once = useOnce();
  const phase = usePhase(busy);

  const balances = w.balances ?? [];
  const asset = balances.find((b) => b.id === assetId) ?? balances[0] ?? null;
  const code = isPrivate ? "XLM" : (asset?.code ?? "XLM");

  // what can actually leave, which is not the same as what is held. for the
  // public pocket the spendable figure already excludes the network's reserve.
  const spendable = isPrivate ? (w.priv?.spendable ?? null) : (asset?.amount ?? null);

  // reset on the way IN. resetting on a timer after close can still be pending
  // when the page is reopened, and it then wipes what was just typed.
  const mounted = useRef(false);
  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true;
    setStage("compose");
  }, []);

  const review = async () => {
    setError(null);
    setBuilding(true);
    try {
      if (isPrivate) {
        const r = await call({ type: "buildPrivateOp", op: { kind: "transfer", to, amount } });
        setHandle(r.handle);
        setPrivateSummary(r.summary);
      } else {
        const r = await call({
          type: "buildPayment",
          to,
          amount,
          assetId,
          memo: memo || undefined,
        });
        setHandle(r.xdr);
        setPublicSummary(r.summary);
      }
      setStage("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  };

  const approve = async () => {
    if (!handle || !once.claim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = isPrivate
        ? await call({ type: "confirmPrivateOp", handle })
        : await call({ type: "confirmPayment", handle });
      setResult({ hash: r.hash, ledger: r.ledger });
      setBusy(false);
      setStage("done");
      void w.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      once.release();
    }
  };

  /**
   * set the amount to a fraction of what can be sent, exactly.
   *
   * bigint stroops throughout. `Number(spendable) * 0.25` would be wrong in a
   * way nobody notices until a balance is large, and it would put a float back
   * into the value path.
   *
   * MAX on the public pocket also takes off the fee. offering the whole
   * spendable balance produces a transaction the account cannot afford, and it
   * fails after the review step, on a screen that has already said the amount
   * is fine. the private pocket pays its fee from the public one, so its max is
   * the whole balance.
   */
  const setFraction = (numerator: bigint, denominator: bigint) => {
    if (!spendable) return;
    const part = fractionOf(spendable, numerator, denominator);
    const whole = numerator === denominator;
    setAmount(whole && !isPrivate ? sendableAfterFee(part, BASE_FEE_STROOPS) : part);
  };

  // empty, not "empty once trimmed". a whitespace amount is malformed input and
  // the wallet should say so by name; a button that is simply dead says nothing.
  const ready = to !== "" && amount !== "";
  const blocked = isPrivate && w.priv?.state !== "ready";

  if (stage === "done" && result) {
    return (
      <Screen t={t}>
        <Header t={t} title="Sent" onClose={onClose} />
        <Receipt t={t} hash={result.hash} ledger={result.ledger} onDone={onClose} />
      </Screen>
    );
  }

  if (stage === "review") {
    return (
      <Screen t={t} still>
        {/* no back chevron here. ReviewPanel carries its own Back, and two
            controls doing one job on one screen is a control nobody can be sure
            about. the panel's is the one that stays, because it sits with the
            approve button it cancels. */}
        <Header t={t} title="Review" />
        {publicSummary && (
          <ReviewPanel
            t={t}
            heading="Sending"
            amount={publicSummary.amount}
            code={publicSummary.assetCode}
            to={publicSummary.to}
            memo={{ value: publicSummary.memo }}
            effects={publicSummary.effects}
            warning={publicSummary.warning}
            blocked={
              publicSummary.decoded
                ? undefined
                : "Pocket could not determine what this transaction does. Do not approve it."
            }
            error={error}
            busy={busy}
            phase={phase}
            approveLabel="Confirm and send"
            onApprove={() => void approve()}
            onCancel={() => setStage("compose")}
          />
        )}
        {privateSummary && (
          <ReviewPanel
            t={t}
            heading="Sending privately"
            amount={privateSummary.amount}
            to={privateSummary.to}
            effects={privateSummary.effects}
            error={error}
            busy={busy}
            phase={phase}
            approveLabel="Confirm and send"
            onApprove={() => void approve()}
            onCancel={() => setStage("compose")}
          />
        )}
      </Screen>
    );
  }

  return (
    <>
      <Screen t={t}>
        <Header t={t} title={isPrivate ? "Send privately" : "Send"} onBack={onClose} />

        {/* there is nothing to send from a private pocket that has not been
            opened. the page answers rather than offering a form that could only
            fail after someone had filled it in. */}
        {blocked ? (
          <>
            <Notice t={t}>
              {w.priv
                ? PRIVATE_NOT_READY[w.priv.state]
                : "Pocket is still reading this account. Try again in a moment."}
            </Notice>
            <ButtonStack>
              <Button
                t={t}
                onClick={() => {
                  onClose();
                  w.openSheet("move");
                }}
              >
                Open the private pocket
              </Button>
            </ButtonStack>
          </>
        ) : (
          <>
            <AmountCard
              t={t}
              code={code}
              amount={amount}
              onAmount={setAmount}
              spendable={spendable}
              onMax={() => setFraction(1n, 1n)}
              onPick={isPrivate ? undefined : () => setPicking(true)}
              mark={<AssetMark t={t} code={code} />}
            />

            <div style={{ marginTop: space.md }}>
              <Field
                t={t}
                label="To"
                value={to}
                onChange={setTo}
                placeholder="G..."
                mono
                onSubmit={() => ready && void review()}
              />
              {!isPrivate && (
                <Field t={t} label="Memo (optional)" value={memo} onChange={setMemo} />
              )}
            </div>

            <Fractions t={t} disabled={!spendable} onPick={setFraction} />

            {isPrivate && (
              <Notice t={t}>The amount is hidden. Both addresses stay public on the ledger.</Notice>
            )}
            {error && (
              <Notice t={t} tone="danger">
                {error}
              </Notice>
            )}

            <ButtonStack>
              {/* "Review", not "Continue".
                  the reference design says Continue, and MoveSheet already says
                  Review for the very same act: leave the compose step and go to
                  the screen where you approve. two doors to one consequence must
                  not describe it differently, and Review is the one that says
                  what actually happens next. */}
              <Button t={t} disabled={!ready} busy={building} onClick={() => void review()}>
                {building ? "Checking" : "Review"}
              </Button>
            </ButtonStack>
          </>
        )}
      </Screen>

      <AssetPicker
        t={t}
        open={picking}
        balances={balances}
        onPick={(b) => {
          setAssetId(b.id);
          setPicking(false);
        }}
        onClose={() => setPicking(false)}
      />
    </>
  );
}

/** the amount, as the largest thing on the page. */
function AmountCard({
  t,
  code,
  amount,
  onAmount,
  spendable,
  onMax,
  onPick,
  mark,
}: {
  t: Theme;
  code: string;
  amount: string;
  onAmount: (v: string) => void;
  spendable: string | null;
  onMax: () => void;
  /** absent for the private pocket, which holds exactly one asset. */
  onPick?: () => void;
  mark: React.ReactNode;
}) {
  return (
    <div
      style={{
        background: t.field,
        border: `1px solid ${t.line}`,
        borderRadius: radius.lg,
        padding: space.gutter,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <button
          type="button"
          onClick={onPick}
          disabled={!onPick}
          aria-label={onPick ? `Asset: ${code}. Choose another` : `Asset: ${code}`}
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: onPick ? "pointer" : "default",
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: `6px 10px`,
            borderRadius: radius.pill,
            background: t.surface,
            minWidth: 0,
          }}
        >
          {mark}
          <span style={{ ...text.rowTitle, color: t.text }}>{code}</span>
          {onPick && <span style={{ color: t.faint }}>▾</span>}
        </button>
        <div style={{ flex: 1 }} />
        <button
          type="button"
          onClick={onMax}
          disabled={!spendable}
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: spendable ? "pointer" : "not-allowed",
            padding: "6px 12px",
            borderRadius: radius.pill,
            background: t.accentSoft,
            color: t.dark ? t.accent : t.text,
            ...text.rowSub,
            fontWeight: 700,
          }}
        >
          Use max
        </button>
      </div>

      <input
        inputMode="decimal"
        value={amount}
        onChange={(e) => onAmount(e.target.value)}
        placeholder="0"
        aria-label={`Amount (${code})`}
        autoFocus
        style={{
          all: "unset",
          boxSizing: "border-box",
          display: "block",
          width: "100%",
          marginTop: space.md,
          textAlign: "center",
          fontSize: fontSizes.hero,
          fontWeight: 800,
          letterSpacing: "-0.035em",
          color: t.text,
          fontVariantNumeric: "tabular-nums",
        }}
      />
      <div
        style={{ ...text.caption, color: t.faint, textAlign: "center", minHeight: 18 }}
      >
        {spendable ? `${spendable} ${code} can be sent` : " "}
      </div>
    </div>
  );
}

/** quarter, half, three quarters, all. */
function Fractions({
  t,
  disabled,
  onPick,
}: {
  t: Theme;
  disabled: boolean;
  onPick: (n: bigint, d: bigint) => void;
}) {
  const steps: [string, bigint, bigint][] = [
    ["25%", 1n, 4n],
    ["50%", 1n, 2n],
    ["75%", 3n, 4n],
    ["Max", 1n, 1n],
  ];
  return (
    <div style={{ display: "flex", gap: space.sm, marginTop: space.md }}>
      {steps.map(([label, n, d]) => (
        <button
          key={label}
          type="button"
          disabled={disabled}
          onClick={() => onPick(n, d)}
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: disabled ? "not-allowed" : "pointer",
            flex: 1,
            textAlign: "center",
            padding: "8px 0",
            borderRadius: radius.pill,
            background: t.field,
            border: `1px solid ${t.line}`,
            color: disabled ? t.faint : t.text,
            ...text.rowSub,
            fontWeight: 700,
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** which asset is being sent. a sheet, because it is an aside from composing. */
function AssetPicker({
  t,
  open,
  balances,
  onPick,
  onClose,
}: {
  t: Theme;
  open: boolean;
  balances: PublicBalance[];
  onPick: (b: PublicBalance) => void;
  onClose: () => void;
}) {
  return (
    <Sheet t={t} open={open} onClose={onClose} title="Choose an asset">
      <div style={{ padding: `0 ${space.gutter}px ${space.gutter}px` }}>
        {balances.map((b, i) => (
          <Row
            key={b.id}
            t={t}
            index={i}
            icon={<AssetMark t={t} code={b.code} />}
            title={b.code}
            sub={b.id === "native" ? "Stellar Lumens" : undefined}
            value={b.amount}
            onClick={() => onPick(b)}
          />
        ))}
      </div>
    </Sheet>
  );
}

