// the amount composer, shared by send and move.
//
// send and move each carried their own copy of this card, its slider and the
// `sliderPercent` helper, byte-for-byte the same but for the verb and whether an
// asset can be picked. they drifted (one grew a fiat readout before the other),
// which is the whole reason a shared piece exists: one place owns the big number,
// the asset badge, the "use max" pill and the fraction slider, and the two
// screens differ only in the props they hand it.
import { useState, type ReactNode } from "react";
import { Button, IconDisc } from "./primitives";
import { Rolling } from "./Amount";
import { ArrowDown } from "./icons";
import { usd } from "./money";
import { capDecimals, parseAmount } from "../../../core/chain/balances";
import { fontSizes, radius, space, text, type Theme } from "./theme";

/** the fraction a typed amount is of the spendable balance, 0..100, for the slider. */
export function sliderPercent(amount: string, spendable: string | null): number {
  if (!spendable || amount === "") return 0;
  const a = Number(amount);
  const s = Number(spendable);
  if (!Number.isFinite(a) || !Number.isFinite(s) || s <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((a / s) * 100)));
}

/**
 * Whether a typed amount is one the balance can actually cover, in exact stroops.
 *
 * The compose screens gate their primary action on this so a payment that cannot
 * be funded is refused BEFORE it is built, rather than offered and then failing.
 * A null spendable (an asset the account does not hold) is never enough. A
 * half-typed value that does not parse yet is allowed through, so the button does
 * not flicker as the user types; the build is the final judge either way. bigint
 * throughout, so nothing here rounds.
 */
export function withinSpendable(amount: string, spendable: string | null): boolean {
  if (spendable === null) return false;
  try {
    return parseAmount(amount) <= parseAmount(spendable);
  } catch {
    return true;
  }
}

/** the amount, as the largest thing on the page, in a soft card with no hard border. */
export function AmountComposer({
  t,
  code,
  amount,
  onAmount,
  spendable,
  onMax,
  onSubmit,
  mark,
  onPick,
  fiat,
  asFiat = false,
  onToggleFiat,
}: {
  t: Theme;
  code: string;
  amount: string;
  onAmount: (v: string) => void;
  spendable: string | null;
  onMax: () => void;
  onSubmit: () => void;
  /** the asset's glyph, drawn inside the accent disc. the caller owns it because
   *  the mark component lives with the screens, not the primitives. */
  mark: ReactNode;
  /** when present, the asset badge becomes a button with a chevron: send can pick
   *  another asset, move is always XLM and passes nothing. */
  onPick?: () => void;
  /** a dollar figure for the entered amount, or null when there is no price. */
  fiat?: number | null;
  /** the optional dollars-vs-asset toggle state, and the handler that flips it.
   *  with no handler the fiat line is a static caption, which is what both screens
   *  show today; a screen that wants the toggle passes both. */
  asFiat?: boolean;
  onToggleFiat?: () => void;
}) {
  // whether the figure is being typed. the visible number rolls to a value the
  // slider or Use max sets (like the home balance), but a keystroke must land at
  // once, so while the field holds focus the roll is suppressed and the raw input
  // drives the digits; on blur (grabbing the slider, tapping Use max) it rolls.
  const [editing, setEditing] = useState(false);

  // the asset badge: an accent disc holding the mark, the code, and (when the
  // asset is pickable) a chevron. a button when it can be pressed, a plain span
  // otherwise, so a non-pickable badge is not a dead control.
  const badge = (
    <>
      <IconDisc t={t} size={24}>
        {mark}
      </IconDisc>
      <span style={{ ...text.rowTitle, color: t.text }}>{code}</span>
      {onPick && (
        <span aria-hidden style={{ color: t.faint, display: "flex" }}>
          <ArrowDown size={14} />
        </span>
      )}
    </>
  );
  const badgeStyle = {
    display: "flex",
    alignItems: "center",
    gap: space.sm,
    padding: `6px 12px`,
    borderRadius: radius.pill,
    background: t.surface,
    minWidth: 0,
  } as const;

  // the fiat line. a plain caption by default; a toggle when the screen supplies
  // onToggleFiat, so tapping it swaps between the dollar figure and the amount in
  // the asset's own unit.
  const fiatText =
    fiat != null
      ? asFiat && onToggleFiat
        ? `${amount || "0"} ${code}`
        : usd(fiat)
      : spendable
        ? `${capDecimals(spendable, 4)} ${code} available`
        : " ";

  // the raw input has none of Amount's fit(), so a long figure ran under the code
  // and clipped. scale the font down to keep the whole number inside the card. a
  // LAYOUT in pixels, not a value: what is sent is the string `amount`, untouched.
  const fitPx = Math.floor(430 / Math.max(1, amount.length));
  const amountPx = Math.min(fontSizes.hero, Math.max(fontSizes.title, fitPx));
  // one metric object shared by the visible Rolling layer and the transparent
  // input over it, so the digits and the caret sit in the very same box.
  const numberStyle = {
    ...text.hero,
    fontSize: amountPx,
    fontVariantNumeric: "tabular-nums lining-nums",
    lineHeight: 1.1,
  } as const;

  return (
    <div style={{ background: t.field, borderRadius: radius.lg, padding: space.gutter }}>
      <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
        {onPick ? (
          <button
            type="button"
            onClick={onPick}
            aria-label={`Asset: ${code}. Choose another`}
            style={{ all: "unset", boxSizing: "border-box", cursor: "pointer", ...badgeStyle }}
          >
            {badge}
          </button>
        ) : (
          <span style={badgeStyle}>{badge}</span>
        )}
        <div style={{ flex: 1 }} />
        {/* the compact accent pill, one primitive now rather than a hand-rolled
            reset in each screen. shown ONLY when there is a balance to max: a
            disabled pill on the field-coloured card is invisible (field on field)
            and reads as stray plain text, so an asset with nothing to send simply
            has no "Use max" rather than a ghost of one. */}
        {spendable && (
          <Button t={t} size="pill" onClick={onMax}>
            Use max
          </Button>
        )}
      </div>

      {/* the big number. no visible box and no focus ring: a bordered input drew a
          hard rectangle around the figure, which the caret already marks.

          the figure is a Rolling display so a programmatic set (Use max, the
          slider) tallies to its new value the way the home balance does; a
          transparent input sits exactly over it, keeping the caret, the decimal
          keypad and every keystroke. both are right-aligned, so the caret lands at
          the end of the rolled digits, and both carry the same hero metrics so the
          transparent text and the visible digits occupy the same box. */}
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "center",
          gap: space.sm,
          marginTop: space.lg,
        }}
      >
        <span
          style={{
            position: "relative",
            display: "inline-flex",
            alignItems: "baseline",
            justifyContent: "flex-end",
            minWidth: "0.7em",
            maxWidth: "100%",
            // the hero role, shrunk to fit a long figure so the number never runs
            // under the code or off the card. ease the fit-scale resize and the
            // placeholder->value ink so a programmatic set does not snap the size.
            ...numberStyle,
            color: amount ? t.text : t.faint,
            transition: `font-size var(--pocket-quick) var(--pocket-enter), color var(--pocket-instant) var(--pocket-enter)`,
          }}
        >
          <span aria-hidden>
            {amount === "" ? "0" : <Rolling value={amount} instant={editing} />}
          </span>
          <input
            className="pocket-bare"
            inputMode="decimal"
            value={amount}
            onChange={(e) => {
              setEditing(true);
              onAmount(e.target.value);
            }}
            onFocus={() => setEditing(true)}
            onBlur={() => setEditing(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") onSubmit();
            }}
            placeholder="0"
            aria-label={`Amount (${code})`}
            autoFocus
            style={{
              all: "unset",
              boxSizing: "border-box",
              position: "absolute",
              inset: 0,
              textAlign: "right",
              ...numberStyle,
              // the digits are drawn by the Rolling layer behind; the input is only
              // the caret and the keypad, so its own text is invisible.
              color: "transparent",
              caretColor: t.accent,
            }}
          />
        </span>
        <span style={{ ...text.heading, color: t.sub, flex: "0 0 auto" }}>{code}</span>
      </div>

      {/* the fiat readout, under the amount. absent price leaves the wallet in its
          own unit rather than a fabricated dollar. */}
      {onToggleFiat ? (
        <button
          type="button"
          onClick={onToggleFiat}
          aria-label="Switch the amount between dollars and the asset"
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: "pointer",
            display: "block",
            width: "100%",
            textAlign: "center",
            marginTop: space.xs,
            minHeight: 18,
            // sub, not faint: the composer card sits on the raised `tint`, where a
            // faint caption drops below readable contrast in the private pocket.
            color: t.sub,
            ...text.caption,
          }}
        >
          {fiatText}
        </button>
      ) : (
        <div
          style={{
            textAlign: "center",
            width: "100%",
            marginTop: space.xs,
            minHeight: 18,
            // sub, not faint: the composer card sits on the raised `tint`, where a
            // faint caption drops below readable contrast in the private pocket.
            color: t.sub,
            ...text.caption,
          }}
        >
          {fiatText}
        </div>
      )}
    </div>
  );
}

/** a slider that sets the amount to a percentage of what can be spent. */
export function AmountSlider({
  t,
  code,
  disabled,
  percent,
  onPercent,
  verb = "Send",
}: {
  t: Theme;
  code: string;
  disabled: boolean;
  percent: number;
  onPercent: (p: number) => void;
  /** the action word in the readout: "Send" on the send screen, "Move" on move. */
  verb?: string;
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
        <span>
          {verb} {percent}%
        </span>
        <span>100%</span>
      </div>
      <input
        className="pocket-bare pocket-slider"
        type="range"
        min={0}
        max={100}
        value={percent}
        disabled={disabled}
        aria-label={`${verb} ${percent}% of your ${code}`}
        onChange={(e) => onPercent(Number(e.target.value))}
      />
    </div>
  );
}
