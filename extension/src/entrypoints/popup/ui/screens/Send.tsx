// send, as a page rather than a panel.
//
// composing a payment is the task, so it fills the frame: the amount is the
// largest thing on screen, the recipient sits under it, a slider sets a fraction
// of the balance, and the confirm is a popup over the top. the review and the
// signing path are untouched underneath; this only changes how the compose step
// looks and hands off to ConfirmSheet.
import { useEffect, useState } from "react";
import { BASE_FEE } from "@stellar/stellar-sdk/base";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, ButtonStack, Header, Notice, Screen, Sheet, Row } from "../primitives";
import { ConfirmSheet, useOnce, usePhase } from "../flow";
import { AssetMark } from "./Home";
import { fractionOf, sendableAfterFee, formatAmount } from "../../../../core/chain/balances";
import { fonts, radius, space, text, type Theme } from "../theme";
import type { PrivateOpSummary, PublicBalance, TransferSummary } from "../../../../core/messages";

/** what a payment costs, in stroops. read from the sdk so "max" matches what chain/payment.ts charges. */
const BASE_FEE_STROOPS = BigInt(BASE_FEE);

/**
 * why there is nothing to send yet, in the words the rest of the product uses.
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

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [publicSummary, setPublicSummary] = useState<TransferSummary | null>(null);
  const [privateSummary, setPrivateSummary] = useState<PrivateOpSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [assetId, setAssetId] = useState("native");
  const [price, setPrice] = useState<number | null>(null);
  const [asFiat, setAsFiat] = useState(false);
  const once = useOnce();
  const phase = usePhase(busy);

  const balances = w.balances ?? [];
  const asset = balances.find((b) => b.id === assetId) ?? balances[0] ?? null;
  const code = isPrivate ? "XLM" : (asset?.code ?? "XLM");

  // what can actually leave, which is not the same as what is held. the public
  // pocket's spendable already excludes the network reserve.
  const spendable = isPrivate ? (w.priv?.spendable ?? null) : (asset?.amount ?? null);

  // a price, for the fiat readout under the amount. absent leaves the wallet in
  // its own unit, which is always true, rather than a dollar it cannot source.
  useEffect(() => {
    let live = true;
    setPrice(null);
    call({ type: "assetMarket", symbol: code })
      .then((m) => {
        if (live) setPrice(m.price);
      })
      .catch(() => {
        if (live) setPrice(null);
      });
    return () => {
      live = false;
    };
  }, [code]);

  const review = async () => {
    setError(null);
    setBuilding(true);
    try {
      if (isPrivate) {
        const r = await call({ type: "buildPrivateOp", op: { kind: "transfer", to, amount } });
        setHandle(r.handle);
        setPrivateSummary(r.summary);
      } else {
        const r = await call({ type: "buildPayment", to, amount, assetId, memo: memo || undefined });
        setHandle(r.xdr);
        setPublicSummary(r.summary);
      }
      setConfirming(true);
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
      void w.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
      once.release();
    }
  };

  const closeConfirm = () => {
    if (busy) return;
    setConfirming(false);
    once.release();
    if (result) onClose();
  };

  /**
   * set the amount to a fraction of what can be sent, exactly, in bigint stroops.
   *
   * MAX on the public pocket also takes off the fee: offering the whole spendable
   * balance builds a transaction the account cannot afford. the private pocket
   * pays its fee from the public one, so its max is the whole balance.
   */
  const setFraction = (numerator: bigint, denominator: bigint) => {
    if (!spendable) return;
    const part = fractionOf(spendable, numerator, denominator);
    const whole = numerator === denominator;
    setAmount(whole && !isPrivate ? sendableAfterFee(part, BASE_FEE_STROOPS) : part);
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setTo(text.trim());
    } catch {
      /* clipboard blocked; the field still takes a typed or dropped address */
    }
  };

  const ready = to !== "" && amount !== "";
  const blocked = isPrivate && w.priv?.state !== "ready";
  const fiat = price !== null && amount !== "" ? Number(amount) * price : null;

  return (
    <>
      <Screen t={t}>
        <Header t={t} title={isPrivate ? "Send privately" : "Send"} onBack={onClose} />

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
              fiat={fiat}
              asFiat={asFiat}
              onToggleFiat={price !== null ? () => setAsFiat((v) => !v) : undefined}
              onMax={() => setFraction(1n, 1n)}
              onPick={isPrivate ? undefined : () => setPicking(true)}
              mark={<AssetMark t={t} code={code} />}
              onSubmit={() => ready && void review()}
            />

            <RecipientField t={t} value={to} onChange={setTo} onPaste={() => void paste()} />

            {!isPrivate && (
              <div style={{ marginTop: space.md }}>
                <MemoField t={t} value={memo} onChange={setMemo} />
              </div>
            )}

            <AmountSlider
              t={t}
              code={code}
              disabled={!spendable}
              percent={sliderPercent(amount, spendable)}
              onPercent={(p) => setFraction(BigInt(p), 100n)}
            />

            {isPrivate && (
              <Notice t={t}>The amount is hidden. Both addresses stay public on the ledger.</Notice>
            )}
            {error && !confirming && (
              <Notice t={t} tone="danger">
                {error}
              </Notice>
            )}

            <ButtonStack>
              <Button t={t} disabled={!ready} busy={building} onClick={() => void review()}>
                {building ? "Checking" : "Continue"}
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

      <ConfirmSheet
        t={t}
        open={confirming}
        heading={isPrivate ? "Confirm private send" : "Confirm send"}
        amount={publicSummary?.amount ?? privateSummary?.amount}
        code={publicSummary?.assetCode ?? code}
        to={publicSummary?.to ?? privateSummary?.to}
        memo={isPrivate ? undefined : { value: publicSummary?.memo }}
        fee={
          // the public summary carries fee in STROOPS; the private one is
          // already XLM. normalise here so the row is never off by 10^7.
          publicSummary
            ? formatAmount(BigInt(publicSummary.fee))
            : privateSummary?.fee
        }
        effects={publicSummary?.effects ?? privateSummary?.effects ?? []}
        warning={publicSummary?.warning}
        blocked={
          publicSummary && !publicSummary.decoded
            ? "Pocket could not determine what this transaction does. Do not approve it."
            : undefined
        }
        error={error}
        busy={busy}
        phase={phase}
        result={result}
        onApprove={() => void approve()}
        onCancel={closeConfirm}
        onDone={closeConfirm}
      />
    </>
  );
}

/** the fraction a typed amount is of the spendable balance, 0..100, for the slider. */
function sliderPercent(amount: string, spendable: string | null): number {
  if (!spendable || amount === "") return 0;
  const a = Number(amount);
  const s = Number(spendable);
  if (!Number.isFinite(a) || !Number.isFinite(s) || s <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((a / s) * 100)));
}

/** the amount, as the largest thing on the page, in a soft card with no hard border. */
function AmountCard({
  t,
  code,
  amount,
  onAmount,
  spendable,
  fiat,
  asFiat,
  onToggleFiat,
  onMax,
  onPick,
  mark,
  onSubmit,
}: {
  t: Theme;
  code: string;
  amount: string;
  onAmount: (v: string) => void;
  spendable: string | null;
  fiat: number | null;
  asFiat: boolean;
  onToggleFiat?: () => void;
  onMax: () => void;
  onPick?: () => void;
  mark: React.ReactNode;
  onSubmit: () => void;
}) {
  return (
    <div
      style={{
        background: t.field,
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
            padding: `6px 12px`,
            borderRadius: radius.pill,
            background: t.surface,
            minWidth: 0,
          }}
        >
          <span
            aria-hidden
            style={{
              width: 24,
              height: 24,
              borderRadius: "50%",
              background: t.accent,
              color: t.onAccent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            {mark}
          </span>
          <span style={{ ...text.rowTitle, color: t.text }}>{code}</span>
          {onPick && <span style={{ color: t.faint, fontSize: 11 }}>▼</span>}
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
            padding: "6px 14px",
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

      {/* the big number. no visible box and no focus ring: a full-width bordered
          input drew a hard rectangle around the figure, which the caret already
          marks as focused. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "center",
          gap: space.sm,
          marginTop: space.lg,
        }}
      >
        <input
          className="pocket-bare"
          inputMode="decimal"
          value={amount}
          onChange={(e) => onAmount(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onSubmit();
          }}
          placeholder="0"
          aria-label="Amount (XLM)"
          autoFocus
          size={Math.max(1, amount.length || 1)}
          style={{
            all: "unset",
            boxSizing: "content-box",
            textAlign: "right",
            maxWidth: "70%",
            fontFamily: fonts.sans,
            fontSize: 44,
            fontWeight: 800,
            letterSpacing: "-0.035em",
            color: amount ? t.text : t.faint,
            caretColor: t.accent,
            fontVariantNumeric: "tabular-nums",
          }}
        />
        <span style={{ ...text.heading, color: t.sub, fontWeight: 800 }}>{code}</span>
      </div>

      {/* the fiat readout, and a toggle to type in it instead. absent price means
          no line rather than a fabricated dollar. */}
      <button
        type="button"
        onClick={onToggleFiat}
        disabled={!onToggleFiat}
        style={{
          all: "unset",
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          width: "100%",
          marginTop: space.xs,
          cursor: onToggleFiat ? "pointer" : "default",
          color: t.faint,
          ...text.caption,
          minHeight: 18,
        }}
      >
        {fiat !== null ? (
          <>
            <span>{asFiat ? `${amount || "0"} ${code}` : `$${fiat.toFixed(2)}`}</span>
            {onToggleFiat && <span aria-hidden>⇅</span>}
          </>
        ) : spendable ? (
          `${spendable} ${code} can be sent`
        ) : (
          " "
        )}
      </button>
    </div>
  );
}

/** the recipient, with a Paste affordance in the field. */
function RecipientField({
  t,
  value,
  onChange,
  onPaste,
}: {
  t: Theme;
  value: string;
  onChange: (v: string) => void;
  onPaste: () => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: space.sm,
        marginTop: space.md,
        background: t.field,
        borderRadius: radius.lg,
        padding: `2px 6px 2px ${space.md}px`,
      }}
    >
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Recipient address"
        aria-label="To"
        style={{
          all: "unset",
          boxSizing: "border-box",
          flex: 1,
          minWidth: 0,
          padding: `${space.md}px 0`,
          fontFamily: fonts.mono,
          ...text.rowSub,
          color: t.text,
        }}
      />
      <button
        type="button"
        onClick={onPaste}
        style={{
          all: "unset",
          boxSizing: "border-box",
          cursor: "pointer",
          padding: "8px 14px",
          borderRadius: radius.pill,
          background: t.accentSoft,
          color: t.dark ? t.accent : t.text,
          ...text.rowSub,
          fontWeight: 700,
        }}
      >
        Paste
      </button>
    </div>
  );
}

/** an optional memo. */
function MemoField({
  t,
  value,
  onChange,
}: {
  t: Theme;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="Memo (optional)"
      aria-label="Memo (optional)"
      style={{
        all: "unset",
        boxSizing: "border-box",
        display: "block",
        width: "100%",
        background: t.field,
        borderRadius: radius.lg,
        padding: `${space.md}px ${space.md}px`,
        ...text.rowSub,
        color: t.text,
      }}
    />
  );
}

/** a slider that sets the amount to a percentage of what can be sent. */
function AmountSlider({
  t,
  code,
  disabled,
  percent,
  onPercent,
}: {
  t: Theme;
  code: string;
  disabled: boolean;
  percent: number;
  onPercent: (p: number) => void;
}) {
  return (
    <div style={{ marginTop: space.lg }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          ...text.rowSub,
          color: t.sub,
          marginBottom: space.sm,
        }}
      >
        <span>Send {percent}%</span>
        <span>Max</span>
      </div>
      <input
        className="pocket-bare"
        type="range"
        min={0}
        max={100}
        value={percent}
        disabled={disabled}
        aria-label={`Send ${percent}% of your ${code}`}
        onChange={(e) => onPercent(Number(e.target.value))}
        // no outline box around the track: the global input:focus rule drew a
        // hard rectangle around the whole slider. accent-color paints the fill.
        style={{ width: "100%", accentColor: t.accent, cursor: disabled ? "not-allowed" : "pointer" }}
      />
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
      <div style={{ paddingBottom: space.gutter }}>
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
