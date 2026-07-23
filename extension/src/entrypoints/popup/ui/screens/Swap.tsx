// swap, as a page rather than a panel.
//
// the same full-frame compose step as send: the amount in is the largest thing,
// the asset out and the live quote sit under it, and the confirm is a popup over
// the top. the review and signing path are the worker's buildSwap -> confirmSwap,
// shown through the shared ConfirmSheet exactly like a payment.
import { useEffect, useRef, useState } from "react";
import { Figure } from "../Amount";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, Frame, Header, Notice, Row, Sheet } from "../primitives";
import { InfoTip } from "../Tooltip";
import { fiatOf } from "../money";
import { AmountComposer, amountReady, AmountSlider, sliderPercent } from "../AmountComposer";
import { AssetPath } from "../AssetPath";
import { findHeld, holdingAmount } from "../holdings";
import { ConfirmSheet, useOnce } from "../flow";
import { AssetMark } from "./Home";
import { ArrowDown } from "../icons";
import {
  fractionOf,
  sendableAfterFee,
  composeAmount,
  SOROBAN_FEE_RESERVE_STROOPS,
} from "../../../../core/chain/balances";
import { NETWORKS, type NetworkId } from "../../../../core/config";
import { chipPad, radius, space, text, type Theme } from "../theme";
import type { PublicBalance, SwapQuoteView, SwapSummary } from "../../../../core/messages";

/** what a swap's network fee is charged in, in stroops, for the MAX buffer on XLM. */

/** one asset the user can swap from or to: an id the worker resolves, a code to show. */
interface SwapAsset {
  id: string;
  code: string;
}

/**
 * the assets a swap can touch: native XLM and every configured classic asset
 * (USDC today). sourced from config, not from the held balances, because a user
 * can swap INTO an asset they do not hold yet (the worker refuses without a
 * trustline, and the message says so).
 */
function swapUniverse(network: NetworkId): SwapAsset[] {
  const known = NETWORKS[network].knownAssets ?? [];
  return [
    { id: "native", code: "XLM" },
    ...known.map((a) => ({ id: `${a.code}:${a.issuer}`, code: a.code })),
  ];
}

export function Swap({ onClose }: { onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const network = w.status?.network ?? "testnet";
  const assets = swapUniverse(network);
  const usdc = assets.find((a) => a.code === "USDC");

  const [inId, setInId] = useState("native");
  // default the output to USDC when it is configured, else the next asset that is
  // not the input; a swap needs two different assets.
  const [outId, setOutId] = useState(usdc?.id ?? assets[1]?.id ?? "native");
  const [amount, setAmount] = useState("");
  const [slippageBps, setSlippageBps] = useState(100);

  const [quote, setQuote] = useState<SwapQuoteView | null>(null);
  // WHEN this quote was read. a pool price moves, and the screen showed an
  // estimate with nothing saying how old it was: the binding numbers come from
  // `buildSwap` at review, so a stale one can never be signed, but a figure a
  // decision is made on should say when it was true.
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [quoteAge, setQuoteAge] = useState(0);
  const [quoting, setQuoting] = useState(false);
  const [price, setPrice] = useState<number | null>(null);

  const [error, setError] = useState<string | null>(null);
  // set only when `failOp` says the worker still holds an in-flight record for
  // this submission. it is not an error, so it is not drawn as one, and Approve
  // stays down while it is true.
  const [unresolved, setUnresolved] = useState(false);

  // a build error describes the inputs that produced it, so it must not outlive
  // them. it was cleared in the amount handler alone, which meant every OTHER
  // input latched the primary action off for good: correct a mistyped address and
  // Continue stayed grey, change the pair after "no swap route was found for that
  // pair and amount" and Continue stayed grey. keyed on the inputs rather than
  // repeated in each setter, so an input added later cannot forget to do it.
  useEffect(() => {
    setError(null);
  }, [inId, outId, amount, slippageBps]);

  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<SwapSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const [picking, setPicking] = useState<null | "in" | "out">(null);
  const once = useOnce();
  const opId = useRef<string | null>(null);
  const leaving = useRef(false);

  const inAsset = assets.find((a) => a.id === inId) ?? assets[0]!;
  const outAsset = assets.find((a) => a.id === outId) ?? assets[1] ?? assets[0]!;
  // FOUR answers, not two. `(w.balances ?? []).find(...)` reads an unloaded or
  // failed balance list as "you do not hold this", which the notice below then
  // states as a fact and acts on by blocking Continue.
  const inFound = findHeld(w.balances, w.balanceError, (b) => b.id === inId);
  const outFound = findHeld(w.balances, w.balanceError, (b) => b.id === outId);
  const outHeld = outFound.kind === "held";
  const spendable = holdingAmount(inFound);

  // a price for the input, for the dollar readout under the amount, exactly as send
  // does it. absent leaves the figure in its own unit rather than a fabricated dollar.
  useEffect(() => {
    let live = true;
    setPrice(null);
    call({ type: "assetMarket", symbol: inAsset.code })
      .then((m) => live && setPrice(m.price))
      .catch(() => live && setPrice(null));
    return () => {
      live = false;
    };
  }, [inAsset.code]);

  // tick while a quote is on screen, so its age is stated rather than implied.
  useEffect(() => {
    if (quotedAt === null) {
      setQuoteAge(0);
      return;
    }
    setQuoteAge(0);
    const id = setInterval(() => setQuoteAge(Math.round((Date.now() - quotedAt) / 1000)), 1000);
    return () => clearInterval(id);
  }, [quotedAt]);

  // a live quote as the user types: a read, debounced, so every keystroke does not
  // hit Aquarius. it shows the estimated out and the route; the binding numbers
  // (minimum received, fee) come from buildSwap at review.
  useEffect(() => {
    setQuote(null);
    if (amount === "" || Number(amount) <= 0 || inId === outId) {
      setQuoting(false);
      return;
    }
    setQuoting(true);
    let live = true;
    const id = setTimeout(() => {
      call({ type: "swapQuote", assetIn: inId, assetOut: outId, amount })
        .then((q) => {
          if (live) {
            setQuote(q);
            setQuotedAt(Date.now());
            setQuoting(false);
          }
        })
        .catch(() => {
          // a quote that cannot be found (no route, or a bad amount) clears the
          // estimate rather than shouting; buildSwap gives the real error at review.
          if (live) {
            setQuote(null);
            setQuoting(false);
          }
        });
    }, 400);
    return () => {
      live = false;
      clearTimeout(id);
    };
  }, [inId, outId, amount]);

  const flip = () => {
    setInId(outId);
    setOutId(inId);
    setAmount("");
  };

  /**
   * a fraction of the balance, so every compose screen offers the same control.
   *
   * the slider was on two of five flows: Send and Move had it and a swap, a yield
   * move and a bridge, which spend a fraction of a balance in exactly the same
   * way, did not. `setMax` stays the whole-balance case and keeps whatever fee
   * reserve it already applies.
   */
  const setFraction = (numerator: bigint, denominator: bigint) => {
    if (!spendable) return;
    if (numerator === denominator) {
      setMax();
      return;
    }
    setAmount(composeAmount(fractionOf(spendable, numerator, denominator), 4));
  };

  const setMax = () => {
    if (!spendable) return;
    const part = fractionOf(spendable, 1n, 1n);
    // swapping the whole XLM balance leaves nothing for the network fee; take it
    // off, the same as send's MAX. a classic asset pays its fee from XLM, so its
    // whole balance is swappable.
    // A SOROBAN operation, so the reserve is the Soroban one. `BASE_FEE` is 100
    // stroops and pays for a classic payment; this call pays a resource fee decided
    // by simulation, measured in the hundreds of thousands. Reserving 100 stroops
    // produced a "use max" amount that left nothing for the real fee.
    const raw = inId === "native" ? sendableAfterFee(part, SOROBAN_FEE_RESERVE_STROOPS) : part;
    setAmount(composeAmount(raw, 4));
  };

  const review = async () => {
    setError(null);
    setBuilding(true);
    try {
      const r = await call({
        type: "buildSwap",
        assetIn: inId,
        assetOut: outId,
        amount,
        slippageBps,
      });
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
      verb: "Swap",
      pocket: "public",
      code: summary?.assetIn ?? inAsset.code,
      amount: summary?.amountIn ?? amount,
      fiat,
      fee: summary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
      const r = await call({ type: "confirmSwap", handle });
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

  // receiving a classic asset needs a trustline for it first, or the swap reverts;
  // XLM is native and always receivable. this gates Continue so the swap is never
  // offered when it cannot land.
  //
  // Not-yet-read blocks Continue too, and must: offering a swap whose output
  // trustline is unknown is offering one that may revert. It just does not get
  // TOLD to the user as a fact about their account.
  const canReceive = outAsset.code === "XLM" || outHeld;
  // Continue is offered only when the swap can be funded AND received: a positive
  // amount, two different assets, enough of the input asset (spendable is null
  // when the input is not held), and a trustline for the output.
  const ready = amountReady(amount, spendable) && inId !== outId && canReceive;
  const fiat = fiatOf(amount, price);

  return (
    <>
      <Frame t={t} className="pocket-page">
        {!result && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>
              <Header
                t={t}
                title="Swap"
                onBack={onClose}
                right={
                  <InfoTip t={t} label="About swapping">
                    Swaps route through Aquarius pools on Stellar. Both the amount and your address
                    are public on the ledger. You receive at least the minimum shown, or the swap
                    reverts.
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
              {/* the out-asset trustline blocker comes FIRST, before the amount: the
                  reason the swap is disabled should be the first thing read, not the
                  last (the same order the CCTP screens put "you hold no USDC" in). it
                  reads as an error because it BLOCKS the swap; the way to resolve it,
                  Manage assets, is a link inside the sentence rather than a control. */}
              {/* moved ABOVE the composer, to the same place as the blocker
                  below it: this file states the ordering rule two comments down
                  ("the reason the swap is disabled should be the first thing
                  read, not the last") and then rendered this one last. it is the
                  worker's own sentence; sending someone to Manage assets to add
                  an asset they may already hold is a specific instruction to do
                  wasted work. */}
              {outFound.kind === "unreadable" && (
                <div style={{ marginBottom: space.md }}>
                  <Notice t={t} tone="danger" bare>
                    {outFound.message}
                  </Notice>
                </div>
              )}

              {inId !== outId && outAsset.code !== "XLM" && outFound.kind === "absent" && (
                <div style={{ marginBottom: space.md }}>
                  <Notice t={t} tone="danger" bare>
                    You do not hold {outAsset.code} yet. Add it in{" "}
                    <button
                      type="button"
                      onClick={() => w.openSheet("assets")}
                      style={{
                        all: "unset",
                        cursor: "pointer",
                        fontWeight: 700,
                        textDecoration: "underline",
                        color: "inherit",
                      }}
                    >
                      Manage assets
                    </button>{" "}
                    first, then you can swap into it.
                  </Notice>
                </div>
              )}

              <AmountComposer
                t={t}
                code={inAsset.code}
                amount={amount}
                onAmount={(v) => {
                  setAmount(v);
                  setError(null);
                }}
                spendable={spendable}
                fiat={fiat}
                onMax={setMax}
                onPick={() => setPicking("in")}
                mark={<AssetMark t={t} id={inId} code={inAsset.code} />}
                onSubmit={() => ready && void review()}
              />

              {/* the same fraction control Send and Move offer. this spends a fraction of a
                  balance in exactly the same way and had only a whole-balance pill. */}
              <AmountSlider
                t={t}
                code={inAsset.code}
                disabled={!spendable}
                percent={sliderPercent(amount, spendable)}
                onPercent={(pc) => setFraction(BigInt(pc), 100n)}
              />

              {/* the flip, between the two assets: a swap is symmetric, so one tap
                  turns "XLM to USDC" into "USDC to XLM". */}
              <div style={{ display: "flex", justifyContent: "center", margin: `${space.sm}px 0` }}>
                <button
                  type="button"
                  aria-label="Flip the assets"
                  onClick={flip}
                  className="pk-tap"
                  style={{
                    all: "unset",
                    boxSizing: "border-box",
                    cursor: "pointer",
                    width: 36,
                    height: 36,
                    borderRadius: "50%",
                    background: t.field,
                    color: t.accentOnSoft,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <ArrowDown size={18} />
                </button>
              </div>

              <ReceiveCard
                t={t}
                asset={outAsset}
                quote={quote}
                quoting={quoting}
                quoteAge={quoteAge}
                onPick={() => setPicking("out")}
              />

              {/* the slippage tolerance: the minimum the swap will accept before it
                  reverts. three plain choices rather than a raw basis-point field. */}
              <div style={{ marginTop: space.lg }}>
                <div
                  style={{
                    ...text.rowSub,
                    color: t.sub,
                    marginBottom: space.sm,
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  Max slippage
                  <InfoTip t={t} label="About slippage">
                    The most the price may move against you before the swap reverts instead of
                    filling. A wider tolerance fills more often but can receive less.
                  </InfoTip>
                </div>
                <div style={{ display: "flex", gap: space.sm }}>
                  {[
                    { label: "0.5%", bps: 50 },
                    { label: "1%", bps: 100 },
                    { label: "2%", bps: 200 },
                  ].map((s) => (
                    <SlipChip
                      key={s.bps}
                      t={t}
                      label={s.label}
                      active={slippageBps === s.bps}
                      onClick={() => setSlippageBps(s.bps)}
                    />
                  ))}
                </div>
              </div>

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

      <SwapAssetPicker
        t={t}
        open={picking !== null}
        assets={assets.filter((a) => a.id !== (picking === "in" ? outId : inId))}
        balances={w.balances}
        balanceError={w.balanceError}
        onPick={(a) => {
          if (picking === "in") setInId(a.id);
          else setOutId(a.id);
          setPicking(null);
        }}
        onClose={() => setPicking(null)}
      />

      <ConfirmSheet
        t={t}
        open={confirming}
        heading="Confirm swap"
        verb="Swap"
        mark={<AssetMark t={t} id={inId} code={inAsset.code} />}
        amount={summary?.amountIn}
        code={summary?.assetIn ?? inAsset.code}
        fee={summary?.fee}
        fiat={fiat}
        // `minOut` is the number the transaction ENFORCES: below it the swap
        // reverts. the screen's own header tip already promises "you receive at
        // least the minimum shown, or the swap reverts", and no minimum was shown
        // anywhere in the flow. `estOut` is the expectation; this is the floor.
        facts={[
          ...(summary?.estOut
            ? [{ label: "Estimated", value: `${summary.estOut} ${summary.assetOut}` }]
            : []),
          ...(summary?.minOut
            ? [{ label: "Minimum received", value: `${summary.minOut} ${summary.assetOut}` }]
            : []),
        ]}
        effects={summary?.effects ?? []}
        error={error}
        unresolved={unresolved}
        busy={busy}
        result={result}
        network={w.status?.network}
        onApprove={() => void approve()}
        onCancel={closeConfirm}
        onDone={closeConfirm}
        onGoHome={w.goHome}
        onClosed={onConfirmClosed}
      />
    </>
  );
}

/** the estimated output: a read-only figure with the asset badge, from the live quote. */
function ReceiveCard({
  t,
  asset,
  quote,
  quoting,
  quoteAge,
  onPick,
}: {
  t: Theme;
  asset: SwapAsset;
  quote: SwapQuoteView | null;
  quoting: boolean;
  /** seconds since this quote was read. */
  quoteAge: number;
  onPick: () => void;
}) {
  const est = quote?.estOut ?? null;
  return (
    <div style={{ background: t.field, borderRadius: radius.lg, padding: space.gutter }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        <span style={{ ...text.rowSub, color: t.sub, flex: 1 }}>You receive (estimate)</span>
        <button
          type="button"
          onClick={onPick}
          aria-label={`Receive: ${asset.code}. Choose another`}
          className="pk-tap"
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            padding: chipPad.pill,
            borderRadius: radius.pill,
            background: t.surface,
          }}
        >
          <span style={{ width: 24, height: 24, display: "flex", flex: "0 0 auto" }}>
            <AssetMark t={t} id={asset.id} code={asset.code} />
          </span>
          <span style={{ ...text.rowTitle, color: t.text }}>{asset.code}</span>
          <span aria-hidden style={{ color: t.faint, display: "flex" }}>
            <ArrowDown size={14} />
          </span>
        </button>
      </div>
      <div
        // the figure the decision to swap is made on. it was a plain <div>, so a
        // screen reader was told nothing when the estimate arrived or changed.
        role="status"
        aria-live="polite"
        style={{
          marginTop: space.md,
          ...text.display,
          color: est ? t.text : t.faint,
          fontVariantNumeric: "tabular-nums lining-nums",
          textAlign: "center",
          overflowWrap: "anywhere",
        }}
      >
        {est ? `${est}` : quoting ? "…" : "—"}
      </div>
      {quote && quote.route.length > 2 && <AssetPath t={t} route={quote.route} />}
      {/* how old this estimate is. a pool price moves and the figure above it was
          drawn with nothing saying when it was read. the minimum received and the
          fee still come from `buildSwap` at review, so a stale quote can never be
          SIGNED; this is about the number the decision is made on. */}
      {est && !quoting && (
        <div style={{ ...text.caption, color: t.faint, textAlign: "center", marginTop: 4 }}>
          {quoteAge < 5
            ? "Live estimate"
            : `Estimate from ${quoteAge}s ago. The exact amount is set when you review.`}
        </div>
      )}
    </div>
  );
}

function SlipChip({
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
        ...text.chip,
        padding: "8px 14px",
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

/** choose the asset to swap from or to. a sheet, like send's asset picker. */
function SwapAssetPicker({
  t,
  open,
  assets,
  balances,
  balanceError,
  onPick,
  onClose,
}: {
  t: Theme;
  open: boolean;
  assets: SwapAsset[];
  /** the RAW list: null is "not read yet", which is not an empty wallet. */
  balances: PublicBalance[] | null;
  balanceError: string | null;
  onPick: (a: SwapAsset) => void;
  onClose: () => void;
}) {
  return (
    <Sheet t={t} open={open} onClose={onClose} title="Choose an asset">
      <div style={{ paddingBottom: space.gutter }}>
        {assets.map((a, i) => {
          // "Not held" is a POSITIVE CLAIM about the account, and it was being
          // derived from `?? []`, which reads a failed or unfinished balance read
          // as an empty wallet: with the first `balances` call failing, every
          // asset in this list said "Not held". the four-answer question is what
          // `findHeld` exists for, and this file already uses it correctly for
          // the swap's own input asset under a comment saying so.
          const h = findHeld(balances, balanceError, (b) => b.id === a.id);
          const amount = holdingAmount(h);
          return (
            <Row
              key={a.id}
              t={t}
              index={i}
              iconRing
              icon={<AssetMark t={t} id={a.id} code={a.code} />}
              title={a.code}
              sub={a.id === "native" ? "Stellar Lumens" : undefined}
              value={amount !== null ? <Figure value={amount} /> : undefined}
              // an unauthorised trustline is held and unusable, which is a third
              // thing again. Send's picker already draws it inert with the reason;
              // this one offered it as ordinary and let a whole swap be composed
              // against it before the network refused.
              tone={h.kind === "held" && !h.balance.authorized ? "inert" : "plain"}
              valueSub={
                h.kind === "held" && !h.balance.authorized
                  ? "Not authorised by the issuer"
                  : amount !== null
                    ? undefined
                    : h.kind === "loading"
                      ? "Reading"
                      : h.kind === "unreadable"
                        ? "Balance unavailable"
                        : "Not held"
              }
              {...(h.kind === "held" && !h.balance.authorized ? {} : { onClick: () => onPick(a) })}
            />
          );
        })}
      </div>
    </Sheet>
  );
}
