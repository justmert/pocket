// yield deposit / withdraw, as a page.
//
// the same full-frame compose step as send: an amount, an approval popup, a
// receipt. the worker's buildYieldMove -> confirmYieldMove is the DeFindex
// non-custodial deposit/withdraw, shown through the shared ConfirmSheet like a
// payment. the position refreshes on its own once the move lands (completeOp
// triggers the provider refresh, which reloads yieldPosition).
import { useEffect, useRef, useState } from "react";
import { BASE_FEE } from "@stellar/stellar-sdk/base";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, Frame, Header, Notice } from "../primitives";
import { InfoTip } from "../Tooltip";
import { fiatOf } from "../money";
import { AmountComposer, withinSpendable } from "../AmountComposer";
import { ConfirmSheet, useOnce } from "../flow";
import { AssetMark } from "./Home";
import { fractionOf, sendableAfterFee, composeAmount } from "../../../../core/chain/balances";
import { radius, space, text, type Theme } from "../theme";
import type { YieldMoveSummary } from "../../../../core/messages";

const BASE_FEE_STROOPS = BigInt(BASE_FEE);

type Kind = "deposit" | "withdraw";

export function Yield({ kind: initial, onClose }: { kind: Kind; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const y = w.yieldPosition;

  const [kind, setKind] = useState<Kind>(initial);
  const [amount, setAmount] = useState("");
  const [price, setPrice] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<YieldMoveSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const once = useOnce();
  const opId = useRef<string | null>(null);
  const leaving = useRef(false);

  const code = y?.underlying ?? "XLM";
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
    const raw = markId === "native" ? sendableAfterFee(part, BASE_FEE_STROOPS) : part;
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
      w.failOp(id, reason);
      setError(reason);
      setBusy(false);
      once.release();
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
              <div style={{ display: "flex", gap: space.sm, marginBottom: space.lg }}>
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

              <AmountComposer
                t={t}
                code={code}
                amount={amount}
                onAmount={setAmount}
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
              <Button t={t} disabled={!ready} busy={building} onClick={() => void review()}>
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
        ...text.rowSub,
        fontWeight: 600,
        padding: "10px 0",
        borderRadius: radius.pill,
        background: active ? t.accentSoft : t.field,
        color: active ? t.accentOnSoft : t.sub,
        transition:
          "background-color var(--pocket-instant) var(--pocket-enter), color var(--pocket-instant) var(--pocket-enter)",
      }}
    >
      {label}
    </button>
  );
}
