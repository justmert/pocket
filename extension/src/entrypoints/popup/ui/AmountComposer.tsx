// the amount composer, shared by send and move.
//
// send and move each carried their own copy of this card, its slider and the
// `sliderPercent` helper, byte-for-byte the same but for the verb and whether an
// asset can be picked. they drifted (one grew a fiat readout before the other),
// which is the whole reason a shared piece exists: one place owns the big number,
// the asset badge, the "use max" pill and the fraction slider, and the two
// screens differ only in the props they hand it.
import type { ReactNode } from "react";
import { Button, IconDisc } from "./primitives";
import { ArrowDown } from "./icons";
import { usd } from "./money";
import { capDecimals } from "../../../core/chain/balances";
import { fontSizes, radius, space, text, type Theme } from "./theme";

/** the fraction a typed amount is of the spendable balance, 0..100, for the slider. */
export function sliderPercent(amount: string, spendable: string | null): number {
  if (!spendable || amount === "") return 0;
  const a = Number(amount);
  const s = Number(spendable);
  if (!Number.isFinite(a) || !Number.isFinite(s) || s <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((a / s) * 100)));
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
            reset in each screen. */}
        <Button t={t} size="pill" disabled={!spendable} onClick={onMax}>
          Use max
        </Button>
      </div>

      {/* the big number. no visible box and no focus ring: a bordered input drew a
          hard rectangle around the figure, which the caret already marks. */}
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
          aria-label={`Amount (${code})`}
          autoFocus
          size={Math.max(1, amount.length || 1)}
          style={{
            all: "unset",
            boxSizing: "content-box",
            textAlign: "right",
            maxWidth: "100%",
            // the hero role, but at a size that shrinks to fit a long figure so the
            // number never runs under the code or off the card.
            ...text.hero,
            fontSize: amountPx,
            color: amount ? t.text : t.faint,
            caretColor: t.accent,
            fontVariantNumeric: "tabular-nums lining-nums",
            // MAX and the slider set this figure programmatically; ease the fit-scale
            // resize and the placeholder->value ink so it does not snap. the size
            // only changes at the width threshold, so typing stays responsive.
            transition: `font-size var(--pocket-quick) var(--pocket-enter), color var(--pocket-instant) var(--pocket-enter)`,
          }}
        />
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
