// yield deposit / withdraw, as a page.
//
// the same full-frame compose step as send: an amount, an approval popup, a
// receipt. the worker's buildYieldMove -> confirmYieldMove is the DeFindex
// non-custodial deposit/withdraw, shown through the shared ConfirmSheet like a
// payment. the position refreshes on its own once the move lands (completeOp
// triggers the provider refresh, which reloads yieldPosition).
import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, Frame, Header, Notice } from "../primitives";
import { InfoTip } from "../Tooltip";
import { fiatOf, usdOf } from "../money";
import { AmountComposer, withinSpendable } from "../AmountComposer";
import { ConfirmSheet, useOnce } from "../flow";
import { AssetMark } from "./Home";
import {
  fractionOf,
  sendableAfterFee,
  composeAmount,
  capDecimals,
  SOROBAN_FEE_RESERVE_STROOPS,
} from "../../../../core/chain/balances";
import { radius, space, text, type Theme } from "../theme";
import type { YieldMoveSummary } from "../../../../core/messages";

type Kind = "deposit" | "withdraw";

export function Yield({ kind: initial, onClose }: { kind: Kind; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const y = w.yieldPosition;

  const [kind, setKind] = useState<Kind>(initial);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  // set only when `failOp` says the worker still holds an in-flight record for
  // this submission. it is not an error, so it is not drawn as one, and Approve
  // stays down while it is true.
  const [unresolved, setUnresolved] = useState(false);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<YieldMoveSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const once = useOnce();
  const opId = useRef<string | null>(null);
  const leaving = useRef(false);

  // the vault's underlying is a SAC id; "native" is wrapped XLM, shown as XLM (never
  // the raw "native"), so the composer, the confirm and the marks all read as XLM.
  const rawUnderlying = y?.underlying ?? "XLM";
  const code = rawUnderlying === "native" ? "XLM" : rawUnderlying;
  const balances = w.balances ?? [];
  // the underlying's mark and held balance. XLM is the native row; a classic
  // underlying (USDC) is matched by code so its own logo and spendable are used.
  const markId = code === "XLM" ? "native" : (balances.find((b) => b.code === code)?.id ?? code);
  const held = balances.find((b) => b.id === markId) ?? null;
  // deposit spends the held wallet balance; withdraw draws from the vault, up to
  // what the held shares are worth in the underlying (underlyingBalance), when the
  // vault reports it. either way `spendable` drives MAX and the over-amount guard.
  const spendable = kind === "deposit" ? (held?.amount ?? null) : (y?.underlyingBalance ?? null);

  useEffect(() => {
    let live = true;
    setPrice(null);
    call({ type: "assetMarket", symbol: code })
      .then((m) => live && setPrice(m.price))
      .catch(() => live && setPrice(null));
    return () => {
      live = false;
    };
  }, [code]);

  const setMax = () => {
    if (!spendable) return;
    const part = fractionOf(spendable, 1n, 1n);
    // A SOROBAN operation, so the reserve is the Soroban one. `BASE_FEE` is 100
    // stroops and pays for a classic payment; this call pays a resource fee decided
    // by simulation, measured in the hundreds of thousands. Reserving 100 stroops
    // produced a "use max" amount that left nothing for the real fee.
    const raw = markId === "native" ? sendableAfterFee(part, SOROBAN_FEE_RESERVE_STROOPS) : part;
    setAmount(composeAmount(raw, 4));
  };

  const review = async () => {
    setError(null);
    setBuilding(true);
    try {
      const r = await call({ type: "buildYieldMove", kind, amount });
      setHandle(r.handle);
      setSummary(r.summary);
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
    const id = w.beginOp({
      verb: kind === "deposit" ? "Deposit" : "Withdraw",
      pocket: "public",
      code,
      amount: summary?.amount ?? amount,
      fiat,
      fee: summary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
      const r = await call({ type: "confirmYieldMove", handle });
      w.completeOp(id, { hash: r.hash, ledger: r.ledger });
      setResult({ hash: r.hash, ledger: r.ledger });
      setBusy(false);
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      setError(reason);
      setBusy(false);
      // ask the worker what this actually was BEFORE re-arming Approve. an
      // `unresolved` submission is one the worker still holds a durable in-flight
      // record for, so it may yet land, and the reason being shown is the wallet's
      // own "do not resend": releasing the one-shot guard under it is what turns a
      // stuck payment into a double spend. the guard stays claimed until then, so
      // a press in the gap does nothing.
      if ((await w.failOp(id, reason)) === "unresolved") setUnresolved(true);
      else once.release();
    }
  };

  const closeConfirm = () => {
    if (busy) return;
    once.release();
    if (result) {
      leaving.current = true;
      if (opId.current) w.dropOp(opId.current);
      opId.current = null;
    }
    setConfirming(false);
  };
  const onConfirmClosed = () => {
    if (leaving.current) {
      leaving.current = false;
      onClose();
    }
  };

  const switchKind = (next: Kind) => {
    if (next === kind) return;
    setKind(next);
    setAmount("");
    setError(null);
  };

  // deposit is gated on holding enough of the underlying. withdraw is gated on
  // the position's underlying value WHEN the vault reports it; when it does not
  // (spendable null), withdraw falls back to the worker validating at build.
  const ready =
    amount !== "" &&
    Number(amount) > 0 &&
    (kind === "withdraw" && spendable === null ? true : withinSpendable(amount, spendable));
  const fiat = fiatOf(amount, price);

  return (
    <>
      <Frame t={t} className="pocket-page">
        {!result && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>
              <Header
                t={t}
                title="Yield"
                onBack={onClose}
                right={
                  <InfoTip t={t} label="About the yield vault">
                    A non-custodial DeFindex vault. Deposits and withdrawals are in the PUBLIC
                    pocket and are visible on the ledger.
                    {y?.apy
                      ? ` The vault reports ${y.apy}; it is variable and not guaranteed.`
                      : ""}
                  </InfoTip>
                }
              />
            </div>

            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflowX: "hidden",
                overflowY: "auto",
                padding: `0 ${space.gutter}px`,
              }}
            >
              {/* a segmented control, matching the Activity screen's Public/Private
                  tabs: one field-coloured track holding two segments, the active one a
                  solid accent pill, rather than two separate buttons with a gap. */}
              <div
                role="group"
                aria-label="Deposit or withdraw"
                style={{
                  display: "flex",
                  gap: 4,
                  background: t.field,
                  borderRadius: radius.pill,
                  padding: 4,
                  marginBottom: space.lg,
                }}
              >
                <ModeTab
                  t={t}
                  label="Deposit"
                  active={kind === "deposit"}
                  onClick={() => switchKind("deposit")}
                />
                <ModeTab
                  t={t}
                  label="Withdraw"
                  active={kind === "withdraw"}
                  onClick={() => switchKind("withdraw")}
                />
              </div>

              {/* the position on the page itself: what is in the vault and the rate,
                  so the yield screen carries its own context, not only the form. */}
              {y && (y.underlyingBalance || y.balance || y.apy) && (
                <div
                  style={{
                    background: t.field,
                    borderRadius: radius.lg,
                    padding: `${space.md}px ${space.gutter}px`,
                    marginBottom: space.lg,
                    display: "flex",
                    flexDirection: "column",
                    gap: space.sm,
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "baseline",
                      gap: space.sm,
                    }}
                  >
                    <span style={{ ...text.rowSub, color: t.sub }}>In the vault</span>
                    <span
                      style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 }}
                    >
                      <span style={{ ...text.rowTitle, color: t.text }}>
                        {y.underlyingBalance
                          ? `${capDecimals(y.underlyingBalance, 4)} ${code}`
                          : y.balance
                            ? `${capDecimals(y.balance, 4)} shares`
                            : "None yet"}
                      </span>
                      {/* the FORMATTED dollar value ("$21.93"), like every other
                          balance the wallet shows: usdOf, not the raw fiatOf number.
                          the line is ALWAYS rendered (a non-breaking space until the
                          price arrives) so the card does not grow/jump when it loads. */}
                      <span style={{ ...text.caption, color: t.sub }}>
                        {(y.underlyingBalance && usdOf(y.underlyingBalance, price)) || " "}
                      </span>
                    </span>
                  </div>
                  {y.apy && (
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        gap: space.sm,
                      }}
                    >
                      <span style={{ ...text.rowSub, color: t.sub }}>Rate</span>
                      <span
                        style={{
                          ...text.rowSub,
                          fontWeight: 600,
                          color: t.positive,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {/* just the figure; "variable, not guaranteed" lives in the
                            header tip rather than wrapping across the card. */}
                        {y.apy.match(/[\d.]+%/)?.[0] ?? y.apy}
                      </span>
                    </div>
                  )}
                </div>
              )}

              <AmountComposer
                t={t}
                code={code}
                amount={amount}
                onAmount={(v) => {
                  setAmount(v);
                  // clear a prior build error so the button re-enables on a new amount.
                  setError(null);
                }}
                spendable={spendable}
                fiat={fiat}
                onMax={setMax}
                mark={<AssetMark t={t} id={markId} code={code} />}
                onSubmit={() => ready && void review()}
              />

              {kind === "withdraw" && (
                <div style={{ marginTop: space.md }}>
                  <Notice t={t} tone="neutral" bare>
                    {y?.underlyingBalance
                      ? `About ${y.underlyingBalance} ${code} is in the vault${y.balance ? ` (${y.balance} shares)` : ""}.`
                      : y?.balance
                        ? `You have ${y.balance} shares in the vault. Enter the ${code} amount to withdraw.`
                        : `Enter the ${code} amount to withdraw from the vault.`}
                  </Notice>
                </div>
              )}

              {error && !confirming && (
                <div style={{ marginTop: space.md }}>
                  <Notice t={t} tone="danger" bare>
                    {error}
                  </Notice>
                </div>
              )}
            </div>

            <div
              style={{ padding: `${space.md}px ${space.gutter}px ${space.lg}px`, background: t.bg }}
            >
              <Button
                t={t}
                disabled={!ready || Boolean(error)}
                busy={building}
                onClick={() => void review()}
              >
                {building ? "Checking" : "Continue"}
              </Button>
            </div>
          </div>
        )}
      </Frame>

      <ConfirmSheet
        t={t}
        open={confirming}
        heading={kind === "deposit" ? "Confirm deposit" : "Confirm withdrawal"}
        verb={kind === "deposit" ? "Deposit" : "Withdraw"}
        mark={<AssetMark t={t} id={markId} code={code} />}
        amount={summary?.amount}
        code={code}
        fee={summary?.fee}
        fiat={fiat}
        effects={summary?.effects ?? []}
        error={error}
        unresolved={unresolved}
        busy={busy}
        result={result}
        network={w.status?.network}
        onApprove={() => void approve()}
        onCancel={closeConfirm}
        onDone={closeConfirm}
        onGoHome={onClose}
        onClosed={onConfirmClosed}
      />
    </>
  );
}

function ModeTab({
  t,
  label,
  active,
  onClick,
}: {
  t: Theme;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="pk-tap"
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        flex: 1,
        textAlign: "center",
        ...text.pocketTab,
        padding: "8px 0",
        borderRadius: radius.pill,
        background: active ? t.accent : "transparent",
        color: active ? t.onAccent : t.sub,
        transition:
          "background-color var(--pocket-instant) var(--pocket-enter), color var(--pocket-instant) var(--pocket-enter)",
      }}
    >
      {label}
    </button>
  );
}
