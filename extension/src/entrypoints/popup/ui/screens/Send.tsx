// send, as a page rather than a panel.
//
// composing a payment is the task, so it fills the frame: the amount is the
// largest thing on screen, the recipient sits under it, a slider sets a fraction
// of the balance, and the confirm is a popup over the top. the review and the
// signing path are untouched underneath; this only changes how the compose step
// looks and hands off to ConfirmSheet.
import { useEffect, useRef, useState } from "react";
import { Close } from "../icons";
import { Figure } from "../Amount";
import { BASE_FEE } from "@stellar/stellar-sdk/base";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { selectPrivateAsset } from "../selectAsset";
import { Button, Field, Frame, Header, Notice, Sheet, Row } from "../primitives";
import { InfoTip } from "../Tooltip";
import { fiatOf } from "../money";
import { shortAddress } from "../Address";
import { AmountComposer, AmountSlider, sliderPercent, amountReady } from "../AmountComposer";
import { ConfirmSheet, useOnce } from "../flow";
import { privateAbsence } from "../holdings";
import { AssetMark, privateMarkId } from "./Home";
import { PrivateAssetPicker } from "../sheets/PrivateAssetPicker";
import {
  fractionOf,
  sendableAfterFee,
  formatAmount,
  composeAmount,
} from "../../../../core/chain/balances";
import { chipPad, fonts, radius, space, text, type Theme } from "../theme";
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
  // set only when `failOp` says the worker still holds an in-flight record for
  // this submission. it is not an error, so it is not drawn as one, and Approve
  // stays down while it is true.
  const [unresolved, setUnresolved] = useState(false);

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
  // Opens on the asset whose detail sheet sent the user here, when one did.
  //
  // `AssetDetailSheet`'s footer button passes the asset it is showing, and
  // App.tsx's handler took no argument and threw it away, so tapping Send on
  // the USDC sheet opened a form composing XLM. The amount, the spendable and
  // the built payment all belonged to an asset the user had not chosen, and the
  // picker showed XLM as though they had.
  const [assetId, setAssetId] = useState(w.assetDetail?.id ?? "native");
  // the private asset this form acts on, chosen LOCALLY (null = the primary). there
  // is no global selection, so picking here changes only this form.
  const [privToken, setPrivToken] = useState<string | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const once = useOnce();
  // the id of the background-op record for the send in flight, so the confirm's
  // resolver can flip it to done (or failed) even after this screen has gone to
  // home and unmounted. the closure outlives the component; the provider does too.
  const opId = useRef<string | null>(null);

  const balances = w.balances ?? [];
  const asset = balances.find((b) => b.id === assetId) ?? balances[0] ?? null;
  // a build error describes the inputs that produced it, so it must not outlive
  // them. it was cleared in the amount handler alone, which meant every OTHER
  // input latched the primary action off for good: correct a mistyped address and
  // Continue stayed grey, change the pair after "no swap route was found for that
  // pair and amount" and Continue stayed grey. keyed on the inputs rather than
  // repeated in each setter, so an input added later cannot forget to do it.
  useEffect(() => {
    setError(null);
  }, [to, amount, memo, assetId, isPrivate, privToken]);

  // the private send runs against the LOCALLY chosen private asset (default primary);
  // the public send against the picked balance. its pocket carries the symbol, the
  // spendable, the state and the wrapper token the private path reads.
  const privList = w.privAssets ?? [];
  // `selectPrivateAsset`, not `find(...) ?? privList[0]`. That fallback is the
  // rule the helper exists to abolish: when the chosen asset is not in the
  // loaded list it silently substitutes a different one, and this form then
  // shows that asset's spendable and SENDS that asset under a choice the user
  // did not make. Nothing chosen yet still defaults to the first, which is a
  // default rather than a substitution, and the helper distinguishes them.
  const localPriv = selectPrivateAsset(w.privAssets, privToken);
  const privSymbol = localPriv?.symbol ?? "XLM";
  const privMarkId = privateMarkId(privSymbol, w.status?.network);
  const code = isPrivate ? privSymbol : (asset?.code ?? "XLM");

  // what can actually leave, which is not the same as what is held. the public
  // pocket's spendable already excludes the network reserve.
  const spendable = isPrivate ? (localPriv?.spendable ?? null) : (asset?.amount ?? null);

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
          asset: localPriv?.token ?? undefined,
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
    // ...and only for XLM. the fee is paid in XLM and is not deducted from the
    // asset being sent, which `controller.ts` states beside the builder ("The fee
    // is XLM and is not deducted from THIS asset"). holding exactly 100 USDC and
    // pressing Use max filled 99.9999, so a credit balance could never be emptied
    // and its trustline could therefore never be closed: removal is refused while
    // anything is still held.
    const raw =
      whole && !isPrivate && assetId === "native" ? sendableAfterFee(part, BASE_FEE_STROOPS) : part;
    // four fraction digits is enough on the compose screen; the extra stellar
    // places only made a long, hard-to-read number. truncated, never rounded up.
    setAmount(composeAmount(raw, 4));
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (text) setTo(text.trim());
    } catch {
      /* clipboard blocked; the field still takes a typed or dropped address */
    }
  };

  // `withinSpendable` alone lets a typed zero through by construction, so
  // Continue turned live on "0" and the worker answered "A payment has to be for
  // more than zero." one gate for all five compose screens.
  const ready = to !== "" && amountReady(amount, spendable);
  const blocked = isPrivate && localPriv?.state !== "ready";
  const fiat = fiatOf(amount, price);

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
                  {localPriv
                    ? localPriv.state === "unregistered" && privSymbol !== "XLM"
                      ? // registration is PER ASSET: name the asset rather than implying
                        // the whole pocket is closed when another asset is already live.
                        `Setting up ${privSymbol} in your private pocket takes two transactions, and you review the second one.`
                      : PRIVATE_NOT_READY[localPriv.state]
                    : // three unrelated facts produce a null pocket and only one of
                      // them is "still reading". this asserted that one always, so a
                      // failed read and a network with no private pocket at all both
                      // told the user to wait for work that was over or had never
                      // started. `MoveSheet` already branched correctly; the helper is
                      // that branch, in one place.
                      privateAbsence(w.privError, w.status?.privateAvailable).message}
                </Notice>
              ) : (
                <>
                  <AmountComposer
                    t={t}
                    code={code}
                    amount={amount}
                    onAmount={(v) => {
                      setAmount(v);
                      setError(null);
                    }}
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

                  <RecipientField
                    t={t}
                    value={to}
                    onChange={setTo}
                    onPaste={() => void paste()}
                    // only once there is enough typed to judge: marking a
                    // half-typed address invalid is the irritation `Field`'s own
                    // callers avoid, so this waits for a full-length string.
                    invalid={to.trim().length >= 56 && !/^[GCM][A-Z2-7]{55}$/.test(to.trim())}
                  />

                  {/* the local address book, used from here: while the field is
                      empty, the addresses saved from past receipts are one tap away.
                      the chip is truncated (a convenience, not an approval); tapping
                      fills the field with the full address. */}
                  {to === "" && w.savedAddresses.length > 0 && (
                    <div style={{ marginTop: space.sm }}>
                      <div style={{ ...text.caption, color: t.faint, marginBottom: 6 }}>Saved</div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}>
                        {w.savedAddresses.slice(0, 4).map((addr) => (
                          <span
                            key={addr}
                            style={{
                              display: "inline-flex",
                              alignItems: "center",
                              background: t.field,
                              borderRadius: radius.pill,
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => setTo(addr)}
                              className="pk-tap"
                              style={{
                                all: "unset",
                                cursor: "pointer",
                                ...text.chip,
                                fontFamily: fonts.mono,
                                color: t.accent,
                                borderRadius: radius.pill,
                                padding: chipPad.pill,
                              }}
                            >
                              {shortAddress(addr)}
                            </button>
                            {/* forget ONE. the only way to remove a saved recipient
                                was erasing the wallet, and two near-identical
                                addresses render as the identical chip. */}
                            <button
                              type="button"
                              aria-label={`Forget ${shortAddress(addr)}`}
                              onClick={() => w.forgetAddress(addr)}
                              className="pk-tap"
                              style={{
                                all: "unset",
                                cursor: "pointer",
                                display: "flex",
                                color: t.faint,
                                padding: `0 ${space.sm}px 0 0`,
                                borderRadius: radius.pill,
                              }}
                            >
                              <Close size={14} />
                            </button>
                          </span>
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
                    if (localPriv) w.openMove(localPriv);
                  }}
                >
                  Open the private pocket
                </Button>
              ) : (
                <Button
                  t={t}
                  disabled={!ready || Boolean(error)}
                  busy={building}
                  onClick={() => void review()}
                >
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

      <PrivateAssetPicker
        open={pickingPrivate}
        onPick={(token) => {
          const picked = privList.find((p) => p.token === token);
          // picking an asset that is NOT set up goes STRAIGHT to setting it up rather
          // than switching to it and leaving the user on the blocked step.
          if (picked && picked.state !== "ready") {
            setPickingPrivate(false);
            onClose();
            w.openMove(picked);
          } else {
            setPrivToken(token);
          }
        }}
        onClose={() => setPickingPrivate(false)}
      />

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
        unresolved={unresolved}
        busy={busy}
        result={result}
        network={w.status?.network}
        onApprove={() => void approve()}
        onCancel={closeConfirm}
        onDone={closeConfirm}
        onGoHome={w.goHome}
        onSaveAddress={w.saveAddress}
        onClosed={onConfirmClosed}
      />
    </>
  );
}
/**
 * the recipient and the memo, through the SHARED field.
 *
 * these two were the only text inputs in the product that bypassed `Field`, on
 * the screen where an address is checked before money leaves: no label, no hint,
 * and no invalid state, while every other field in the wallet has all three. the
 * reason the copies existed was the Paste pill, and `Field` grew a `trailing`
 * slot for exactly that.
 */
function RecipientField({
  t,
  value,
  onChange,
  onPaste,
  invalid,
}: {
  t: Theme;
  value: string;
  onChange: (v: string) => void;
  onPaste: () => void;
  invalid?: boolean;
}) {
  return (
    <Field
      t={t}
      label="To"
      value={value}
      onChange={onChange}
      placeholder="Recipient address"
      mono
      invalid={invalid}
      hint={
        invalid
          ? "That is not a Stellar address. They are 56 characters and begin with G, C or M."
          : undefined
      }
      trailing={
        <Button t={t} size="pill" onClick={onPaste}>
          Paste
        </Button>
      }
    />
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
    <Field
      t={t}
      label="Memo (optional)"
      value={value}
      onChange={onChange}
      placeholder="For exchanges that ask for one"
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
            // An unauthorised trustline cannot send or receive: the issuer has
            // not authorised this account for it. Home already says so on the
            // row, and this picker offered it anyway, so a user could choose it
            // and fill in a whole send before the network refused. Drawn inert
            // with the reason instead of hidden, because hiding an asset Home
            // lists would be its own confusion.
            tone={b.authorized ? "plain" : "inert"}
            sub={
              !b.authorized
                ? "Not authorised by the issuer"
                : b.id === "native"
                  ? "Stellar Lumens"
                  : undefined
            }
            value={<Figure value={b.amount} />}
            {...(b.authorized ? { onClick: () => onPick(b) } : {})}
          />
        ))}
      </div>
    </Sheet>
  );
}
