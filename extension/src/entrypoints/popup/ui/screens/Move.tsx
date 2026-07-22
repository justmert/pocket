// moving value between the two pockets, as a page rather than a panel.
//
// move-in (shield) and move-out (unshield) are the same task with the direction
// flipped: an amount is the largest thing on screen, a slider sets a fraction of
// what can move, and the confirm is a popup over the top. it mirrors Send on
// purpose, because to the user this IS a send, just between their own pockets.
// the build/prove/submit path is the worker's `buildPrivateOp`/`confirmPrivateOp`,
// untouched: this file only composes the amount and hands off to ConfirmSheet.
import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { selectPrivateAsset } from "../selectAsset";
import { Button, Frame, Header, Notice } from "../primitives";
import { InfoTip } from "../Tooltip";
import { fiatOf } from "../money";
import { AmountComposer, AmountSlider, sliderPercent, amountReady } from "../AmountComposer";
import { ConfirmSheet, useOnce } from "../flow";
import { privateAbsence } from "../holdings";
import { AssetMark, privateMarkId } from "./Home";
import { PrivateAssetPicker } from "../sheets/PrivateAssetPicker";
import {
  fractionOf,
  sendableAfterFee,
  composeAmount,
  SOROBAN_FEE_RESERVE_STROOPS,
} from "../../../../core/chain/balances";
import { space } from "../theme";
import type { PrivateOpSummary } from "../../../../core/messages";

/** why there is nothing to move yet, in the words the rest of the product uses. */
const NOT_READY: Record<string, string> = {
  unavailable: "This network has no private pocket, so there is nothing to move.",
  unfunded:
    "This account does not exist on the network yet. Receive some XLM first, then you can open a private pocket.",
  unregistered:
    "The private pocket is not open yet. Setting it up takes two transactions, and you review the second one.",
  archived: "The private pocket went dormant from not being used. Reactivate it before moving.",
  needsRecovery:
    "This device's record of the private balances has to be rebuilt before anything can move.",
  diverged:
    "This device disagrees with the contract about the private balances, so it refuses to move until that is rebuilt.",
  ready: "",
};

export function Move({ kind, onClose }: { kind: "shield" | "unshield"; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const movingIn = kind === "shield";
  // the private asset this move runs against, chosen LOCALLY (default primary): no
  // global selection, so picking here changes only this form. its pocket carries the
  // symbol for display, the wrapper token for the op, and the state.
  //
  // it starts at the asset whose sheet OPENED this form, when one did.
  // `PrivateAssetSheet` is per asset and its Shield/Unshield rows call
  // `go("moveIn")`/`go("moveOut")`, and this screen never read `privateDetail`
  // at all: tapping Unshield on the USDC pocket opened a form composing against
  // XLM, with the amount, the balance and the built operation all belonging to
  // an asset the user had not chosen. Still LOCAL after that, so picking here
  // changes only this form.
  const [privToken, setPrivToken] = useState<string | null>(w.privateDetail?.token ?? null);
  const privList = w.privAssets ?? [];
  // `selectPrivateAsset`, not `find(...) ?? privList[0]`. That fallback is the
  // rule this helper exists to abolish: when the chosen asset is not in the
  // loaded list it silently substitutes a different one, and the form then
  // shows that asset's balance and builds that asset's operation under a choice
  // the user did not make. Nothing selected yet still defaults to the first,
  // which is a default rather than a substitution, and the helper says so.
  const localPriv = selectPrivateAsset(w.privAssets, privToken);
  const symbol = localPriv?.symbol ?? "XLM";
  const assetToken = localPriv?.token ?? undefined;
  const isNativeAsset = symbol === "XLM";
  // native wears its real logo; a wrapped classic asset falls to the safe monogram,
  // because its verified issuer is not on the wire and a code-matched logo could be
  // the wrong issuer's mark.
  const markId = privateMarkId(symbol, w.status?.network);
  // an asset picker once more than one is configured, so a shield/unshield opened
  // from the FAB can switch asset in the form rather than being stuck on the last
  // selected one.
  const multiPrivate = (w.status?.privateAssets?.length ?? 0) > 1;
  const [pickingPrivate, setPickingPrivate] = useState(false);

  const [amount, setAmount] = useState("");
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
  }, [amount, privToken]);

  const [building, setBuilding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [handle, setHandle] = useState<string | null>(null);
  const [summary, setSummary] = useState<PrivateOpSummary | null>(null);
  const [result, setResult] = useState<{ hash: string; ledger: number } | null>(null);
  const [price, setPrice] = useState<number | null>(null);
  const once = useOnce();
  // id of the background-op record for the move in flight, so the confirm's
  // resolver can flip it to done even after Go to home has unmounted this screen.
  const opId = useRef<string | null>(null);

  // a price for the dollar readout under the amount, mirroring Send. a moving user
  // still thinks in dollars, and absent a price the wallet stays in its own unit
  // rather than a figure it cannot source.
  useEffect(() => {
    let live = true;
    setPrice(null);
    call({ type: "assetMarket", symbol })
      .then((m) => {
        if (live) setPrice(m.price);
      })
      .catch(() => {
        if (live) setPrice(null);
      });
    return () => {
      live = false;
    };
  }, [symbol]);

  // re-read the pocket on open: a just-registered account shows its real state
  // rather than whatever was cached when the popup first loaded.
  useEffect(() => {
    void w.refresh();
  }, [w.refresh]);

  // move-in draws from the PUBLIC balance of this asset, move-out from the private
  // pocket. shielding USDC spends public USDC, not native, so the source follows
  // the asset. both are spendable figures the worker has already netted of what
  // cannot leave.
  const nativeBalance = (w.balances ?? []).find((b) => b.id === "native");
  const publicForAsset = isNativeAsset
    ? nativeBalance
    : ((w.balances ?? []).find((b) => b.code === symbol && b.authorized) ?? null);
  const spendable = movingIn ? (publicForAsset?.amount ?? null) : (localPriv?.spendable ?? null);

  // the private account must exist for either direction: you cannot deposit into
  // a pocket that is not open, and there is nothing to withdraw from one either.
  const blocked = localPriv?.state !== "ready";

  const review = async () => {
    setError(null);
    setBuilding(true);
    try {
      const r = await call({ type: "buildPrivateOp", op: { kind, amount }, asset: assetToken });
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
    // record the move as it is submitted, so Go to home leaves a watch record
    // rather than losing it from view. the worker runs the confirm to completion
    // regardless; this is only the popup's account of what it is still waiting on.
    const id = w.beginOp({
      verb: movingIn ? "Shield" : "Unshield",
      pocket: w.pocket,
      code: symbol,
      amount: summary?.amount ?? amount,
      fiat,
      fee: summary?.fee,
      network: w.status?.network,
    });
    opId.current = id;
    try {
      const r = await call({ type: "confirmPrivateOp", handle });
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

  // both Cancel and the receipt's Done slide the sheet DOWN (setConfirming false);
  // what differs is where we land, and that is decided after the slide finishes.
  // `leaving` remembers a completed op so `onConfirmClosed` (fired by the sheet
  // once it has animated out) leaves the whole route to home, while a cancel just
  // returns to the compose screen the sheet slid up from. popping the route mid-
  // slide (the old code) unmounted the sheet and cut the animation, which read as
  // a glitch; the compose behind is blanked while a result is up, so the slide
  // reveals the clean canvas, not the form.
  const leaving = useRef(false);
  const closeConfirm = () => {
    if (busy) return;
    once.release();
    if (result) {
      // the receipt was seen and dismissed: drop the watch record so it does not
      // linger in the processing list beside the same move history will show.
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
   * set the amount to a fraction of what can move, exactly, in bigint stroops.
   *
   * a NATIVE move-in pays its fee out of the same balance it is moving, so MAX
   * must leave the fee behind or the deposit builds a transaction the account
   * cannot afford. shielding a non-native asset pays the fee in XLM from a
   * separate balance, so its whole amount can move; move-out pays its fee from the
   * public pocket too, so its max is the whole private balance.
   */
  const setFraction = (numerator: bigint, denominator: bigint) => {
    if (!spendable) return;
    const part = fractionOf(spendable, numerator, denominator);
    const whole = numerator === denominator;
    const raw =
      // A SOROBAN operation, so the reserve is the Soroban one. `BASE_FEE` is 100
      // stroops and pays for a classic payment; this call pays a resource fee decided
      // by simulation, measured in the hundreds of thousands. Reserving 100 stroops
      // produced a "use max" amount that left nothing for the real fee.
      whole && movingIn && isNativeAsset
        ? sendableAfterFee(part, SOROBAN_FEE_RESERVE_STROOPS)
        : part;
    // four fraction digits is enough on the compose screen; truncated, not rounded.
    setAmount(composeAmount(raw, 4));
  };

  // Move was the only compose screen with NO ceiling at all, while driving a
  // percentage slider off the same `spendable` it did not check against.
  const ready = amountReady(amount, spendable);
  const percent = sliderPercent(amount, spendable);
  const fiat = fiatOf(amount, price);

  return (
    <>
      <Frame t={t} className="pocket-page">
        {/* blanked once a result is up: when the receipt slides away it reveals the
            clean canvas, not the filled form, then the route leaves to home. */}
        {!result && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
            <div style={{ padding: `${space.gutter}px ${space.gutter}px ${space.sm}px` }}>
              <Header
                t={t}
                title={movingIn ? "Shield" : "Unshield"}
                onBack={onClose}
                right={
                  <InfoTip t={t} label={movingIn ? "About shielding" : "About unshielding"}>
                    {movingIn
                      ? "The amount you shield is public. Only what you do inside the private pocket after that is hidden."
                      : "The amount you unshield becomes public when it lands in your public pocket."}
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
              {blocked ? (
                <Notice t={t}>
                  {localPriv
                    ? localPriv.state === "unregistered" && !isNativeAsset
                      ? // registration is PER ASSET: a not-open USDC pocket is not "the
                        // private pocket is not set up" when XLM is already live, so name
                        // the asset rather than implying the whole pocket is closed.
                        `Setting up ${symbol} in your private pocket takes two transactions, and you review the second one.`
                      : NOT_READY[localPriv.state]
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
                  {/* the shared composer. the mark and code follow the selected
                      asset; with more than one configured, the mark opens a picker
                      to switch it, mirroring the public send. */}
                  <AmountComposer
                    t={t}
                    code={symbol}
                    amount={amount}
                    onAmount={(v) => {
                      setAmount(v);
                      setError(null);
                    }}
                    spendable={spendable}
                    fiat={fiat}
                    onMax={() => setFraction(1n, 1n)}
                    onPick={multiPrivate ? () => setPickingPrivate(true) : undefined}
                    mark={<AssetMark t={t} id={markId} code={symbol} />}
                    onSubmit={() => ready && void review()}
                  />

                  <AmountSlider
                    t={t}
                    code={symbol}
                    disabled={!spendable}
                    percent={percent}
                    onPercent={(p) => setFraction(BigInt(p), 100n)}
                    verb="Move"
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

      <PrivateAssetPicker
        open={pickingPrivate}
        onPick={(token) => {
          const picked = privList.find((p) => p.token === token);
          // picking an asset that is NOT set up goes STRAIGHT to setting it up (the
          // same route "Open the private pocket" takes), rather than switching to it
          // and leaving the user on the blocked step to press a second button.
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
        heading={movingIn ? "Shield" : "Unshield"}
        mark={<AssetMark t={t} id={markId} code={symbol} />}
        verb={movingIn ? "Shield" : "Unshield"}
        amount={summary?.amount}
        code={symbol}
        treatment="exposed"
        to={summary?.to}
        fee={summary?.fee}
        fiat={fiat}
        effects={summary?.effects ?? []}
        error={error}
        unresolved={unresolved}
        busy={busy}
        approveLabel="Approve"
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
