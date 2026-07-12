// send, as a page rather than a panel.
//
// composing a payment is the task, so it fills the frame: the amount is the
// largest thing on screen, the recipient sits under it, a slider sets a fraction
// of the balance, and the confirm is a popup over the top. the review and the
// signing path are untouched underneath; this only changes how the compose step
// looks and hands off to ConfirmSheet.
import { useEffect, useRef, useState } from "react";
import { BASE_FEE } from "@stellar/stellar-sdk/base";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, Frame, Header, Notice, Sheet, Row } from "../primitives";
import { InfoTip } from "../Tooltip";
import { AmountComposer, AmountSlider, sliderPercent } from "../AmountComposer";
import { ConfirmSheet, useOnce } from "../flow";
import { AssetMark } from "./Home";
import { PrivateAssetPicker } from "../sheets/PrivateAssetPicker";
import {
  capDecimals,
  fractionOf,
  sendableAfterFee,
  formatAmount,
} from "../../../../core/chain/balances";
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
  // the private pocket has an asset picker too once more than one is configured,
  // so a private send opened from the FAB can switch asset in the form rather than
  // being stuck on whichever one was last selected.
  const [pickingPrivate, setPickingPrivate] = useState(false);
  const multiPrivate = (w.status?.privateAssets?.length ?? 0) > 1;
  const [assetId, setAssetId] = useState("native");
  const [price, setPrice] = useState<number | null>(null);
  const once = useOnce();
  // the id of the background-op record for the send in flight, so the confirm's
  // resolver can flip it to done (or failed) even after this screen has gone to
  // home and unmounted. the closure outlives the component; the provider does too.
  const opId = useRef<string | null>(null);

  const balances = w.balances ?? [];
  const asset = balances.find((b) => b.id === assetId) ?? balances[0] ?? null;
  // the private send runs against the selected private asset; the public send
  // against the picked balance. symbol for display/price, token for the op.
  const privSymbol = w.priv?.symbol ?? "XLM";
  const privMarkId = privSymbol === "XLM" ? "native" : privSymbol;
  const code = isPrivate ? privSymbol : (asset?.code ?? "XLM");

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
        const r = await call({
          type: "buildPrivateOp",
          op: { kind: "transfer", to, amount },
          asset: w.privateAsset ?? undefined,
        });
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
    // record the send the moment it is submitted, so leaving the sheet (Go to
    // home) leaves behind a watch record rather than losing the transaction from
    // view. the worker runs the confirm to completion either way; this is what
    // lets the popup show it as processing and reconcile it when it lands.
    const id = w.beginOp({
      verb: isPrivate ? "Send privately" : "Send",
      pocket: w.pocket,
      code: publicSummary?.assetCode ?? code,
      amount: publicSummary?.amount ?? privateSummary?.amount ?? amount,
      fiat,
      to: publicSummary?.to ?? privateSummary?.to ?? to,
      // the public summary carries fee in stroops; the private one is already XLM.
      fee: publicSummary ? formatAmount(BigInt(publicSummary.fee)) : privateSummary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
      const r = isPrivate
        ? await call({ type: "confirmPrivateOp", handle })
        : await call({ type: "confirmPayment", handle });
      // the resolver may run after this screen has unmounted (went to home): it
      // touches only the provider, never this screen's state, so both paths are
      // safe. the completion updates the watched op wherever it is being shown.
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

  // both Cancel and the receipt's Done slide the sheet DOWN; where we land is
  // decided after the slide finishes. `leaving` remembers a completed op so
  // `onConfirmClosed` (fired by the sheet once it has animated out) leaves the
  // route to home, while a cancel returns to the compose screen. popping the route
  // mid-slide (the old code) unmounted the sheet and cut the animation, which read
  // as a glitch; the compose behind is blanked while a result is up, so the slide
  // reveals the clean canvas, not the form.
  const leaving = useRef(false);
  const closeConfirm = () => {
    if (busy) return;
    once.release();
    if (result) {
      // the receipt was seen and dismissed, so the watch record has served its
      // purpose: drop it rather than leave a done row in the processing list next
      // to the same transaction the history will show once it reconciles.
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
    const raw = whole && !isPrivate ? sendableAfterFee(part, BASE_FEE_STROOPS) : part;
    // four fraction digits is enough on the compose screen; the extra stellar
    // places only made a long, hard-to-read number. truncated, never rounded up.
    setAmount(capDecimals(raw, 4));
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
      {/* a full-frame column: header, a scrolling form, and the primary action
          pinned to the bottom on an opaque bar. the button no longer floats in
          the middle with a random gap below it; its bottom padding is the same
          as every other footer in the wallet. */}
      <Frame t={t} className="pocket-page">
        {/* blanked once a result is up: when the receipt slides away it reveals the
            clean canvas, not the filled form, then the route leaves to home. */}
        {!result && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>
              <Header
                t={t}
                title={isPrivate ? "Send privately" : "Send"}
                onBack={onClose}
                right={
                  isPrivate ? (
                    <InfoTip t={t} label="About sending privately">
                      The amount is hidden. Both addresses stay public on the ledger.
                    </InfoTip>
                  ) : undefined
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
              {blocked ? (
                <Notice t={t}>
                  {w.priv
                    ? PRIVATE_NOT_READY[w.priv.state]
                    : "Pocket is still reading this account. Try again in a moment."}
                </Notice>
              ) : (
                <>
                  <AmountComposer
                    t={t}
                    code={code}
                    amount={amount}
                    onAmount={setAmount}
                    spendable={spendable}
                    fiat={fiat}
                    onMax={() => setFraction(1n, 1n)}
                    onPick={
                      isPrivate
                        ? multiPrivate
                          ? () => setPickingPrivate(true)
                          : undefined
                        : () => setPicking(true)
                    }
                    mark={
                      <AssetMark
                        t={t}
                        id={isPrivate ? privMarkId : (asset?.id ?? "native")}
                        code={code}
                      />
                    }
                    onSubmit={() => ready && void review()}
                  />

                  <RecipientField t={t} value={to} onChange={setTo} onPaste={() => void paste()} />

                  {/* the local address book, used from here: while the field is
                      empty, the addresses saved from past receipts are one tap away.
                      the chip is truncated (a convenience, not an approval); tapping
                      fills the field with the full address. */}
                  {to === "" && w.savedAddresses.length > 0 && (
                    <div style={{ marginTop: space.sm }}>
                      <div style={{ ...text.caption, color: t.faint, marginBottom: 6 }}>Saved</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}>
                        {w.savedAddresses.slice(0, 4).map((addr) => (
                          <button
                            key={addr}
                            type="button"
                            onClick={() => setTo(addr)}
                            className="pk-tap"
                            style={{
                              all: "unset",
                              cursor: "pointer",
                              ...text.chip,
                              fontFamily: fonts.mono,
                              color: t.accent,
                              background: t.field,
                              borderRadius: radius.pill,
                              padding: "6px 12px",
                            }}
                          >
                            {addr.slice(0, 6)}…{addr.slice(-4)}
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

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

                  {error && !confirming && (
                    <Notice t={t} tone="danger">
                      {error}
                    </Notice>
                  )}
                </>
              )}
            </div>

            <div
              style={{ padding: `${space.md}px ${space.gutter}px ${space.lg}px`, background: t.bg }}
            >
              {blocked ? (
                <Button
                  t={t}
                  onClick={() => {
                    onClose();
                    w.openSheet("move");
                  }}
                >
                  Open the private pocket
                </Button>
              ) : (
                <Button t={t} disabled={!ready} busy={building} onClick={() => void review()}>
                  {building ? "Checking" : "Continue"}
                </Button>
              )}
            </div>
          </div>
        )}
      </Frame>

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

      <PrivateAssetPicker open={pickingPrivate} onClose={() => setPickingPrivate(false)} />

      <ConfirmSheet
        t={t}
        open={confirming}
        heading={isPrivate ? "Confirm private send" : "Confirm send"}
        mark={<AssetMark t={t} id={isPrivate ? privMarkId : (asset?.id ?? "native")} code={code} />}
        amount={publicSummary?.amount ?? privateSummary?.amount}
        code={publicSummary?.assetCode ?? code}
        to={publicSummary?.to ?? privateSummary?.to}
        memo={isPrivate ? undefined : { value: publicSummary?.memo }}
        fee={
          // the public summary carries fee in STROOPS; the private one is
          // already XLM. normalise here so the row is never off by 10^7.
          publicSummary ? formatAmount(BigInt(publicSummary.fee)) : privateSummary?.fee
        }
        fiat={fiat}
        effects={publicSummary?.effects ?? privateSummary?.effects ?? []}
        warning={publicSummary?.warning}
        blocked={
          publicSummary && !publicSummary.decoded
            ? "Pocket could not determine what this transaction does. Do not approve it."
            : undefined
        }
        error={error}
        busy={busy}
        result={result}
        network={w.status?.network}
        onApprove={() => void approve()}
        onCancel={closeConfirm}
        onDone={closeConfirm}
        onGoHome={onClose}
        onSaveAddress={w.saveAddress}
        onClosed={onConfirmClosed}
      />
    </>
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
      className="pk-field"
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
          ...text.rowSub,
          // the recipient is a stellar address: verbatim data, so mono wins over
          // the role's body face, at the mono weight of 500.
          fontFamily: fonts.mono,
          fontWeight: 500,
          color: t.text,
        }}
      />
      <Button t={t} size="pill" onClick={onPaste}>
        Paste
      </Button>
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
      className="pk-field"
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
            iconRing
            icon={<AssetMark t={t} id={b.id} code={b.code} />}
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
