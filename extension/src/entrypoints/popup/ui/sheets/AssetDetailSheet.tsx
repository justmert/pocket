// what one asset is, and what you hold of it.
//
// ported to match the reference's detail view: a token badge and name up top
// with the price and change beside it, then the chart, then rows that each carry
// a leading icon. every value is read from the ledger or from the Stellar DEX.
//
// there is deliberately no "liquidity" row and no "market cap" row: Horizon
// publishes neither, and a row we cannot source is a row we do not draw. there
// is no "swap" button either, because the wallet cannot swap, and a control that
// does nothing when pressed is its own small dead end.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Amount, Rolling, Figure } from "../Amount";
import { Button, IconDisc, Sheet, Skeleton, useRetained } from "../primitives";
import { ChangeChip, ValueChartBlock, useValueChart } from "../Chart";
import { AssetMark } from "../screens/Home";
import { InfoTip } from "../Tooltip";
import { compactUsd, price as priceUsd, usdOf } from "../money";
import { FRAME, fontSizes, space, text, type Theme } from "../theme";
import type { AssetMarketView, PublicBalance } from "../../../../core/messages";

/**
 * a token's mark on the pocket-tinted tile every other surface draws it on. the
 * mark itself is the shared AssetMark (Home, History, Send, Move all use it), so
 * the detail header wears the same logo tile as the rows it opens from rather
 * than a bespoke white plate. AssetMark owns the logo-vs-initial choice and the
 * vendored, never-fetched artwork; this wrapper only owns the round tile shape
 * and its accentSoft fill, which is the colour every other tile uses.
 */
function AssetTile({ t, id, code, size }: { t: Theme; id: string; code: string; size: number }) {
  return (
    <IconDisc t={t} size={size} tone="accentSoft">
      <AssetMark t={t} id={id} code={code} />
    </IconDisc>
  );
}

/** a small circled glyph for a detail row. the disc is the shared IconDisc on
 *  its neutral `field` plate, so the row mark cannot drift from the discs the
 *  rest of the product draws; this only adds the bold, on-scale type the "$"
 *  glyph reads at (harmless on the svg volume glyph, which sizes itself). */
function RowIcon({ t, children }: { t: Theme; children: ReactNode }) {
  return (
    <IconDisc t={t} size={28} tone="field">
      <span style={{ fontWeight: 700, fontSize: fontSizes.small }}>{children}</span>
    </IconDisc>
  );
}

/** a tiny line-chart glyph, for the volume row. */
function VolumeGlyph({ color }: { color: string }) {
  return (
    <svg width="15" height="15" viewBox="0 0 15 15" fill="none" aria-hidden>
      <path
        d="M1 10 L5 6 L8 8 L14 2"
        stroke={color}
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** label with a leading icon on the left, value on the right. */
function DetailRow({
  t,
  icon,
  label,
  labelTip,
  children,
}: {
  t: Theme;
  icon: ReactNode;
  label: string;
  /** the "why", on a hover tip rather than a caption under the label. */
  labelTip?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.md, minHeight: 44 }}>
      {icon}
      <div
        style={{
          flex: 1,
          minWidth: 0,
          ...text.rowTitle,
          color: t.sub,
          display: "flex",
          alignItems: "center",
          gap: 6,
        }}
      >
        {label}
        {labelTip && (
          <InfoTip t={t} label={label} size={16}>
            {labelTip}
          </InfoTip>
        )}
      </div>
      <div style={{ ...text.rowTitle, color: t.text, textAlign: "right" }}>{children}</div>
    </div>
  );
}

export function AssetDetailSheet({
  asset,
  onClose,
  onSend,
}: {
  /** null when nothing is selected; the sheet is closed. */
  asset: PublicBalance | null;
  onClose: () => void;
  onSend: (asset: PublicBalance) => void;
}) {
  const w = useWallet();
  const t = w.t;
  // hold the last asset through the close, so the sheet slides DOWN still showing it
  // instead of emptying to a blank card the instant `asset` is nulled. `asset` (live)
  // drives open/close; `shown` drives the body.
  const shown = useRetained(asset, 300);
  const code = shown?.code ?? "";

  const [market, setMarket] = useState<AssetMarketView | null>(null);
  // whether the market fetch has come back yet, so the price can shimmer while
  // it is in flight rather than reading "Price unavailable" before it has tried.
  const [marketLoaded, setMarketLoaded] = useState(false);
  const [scrubAt, setScrubAt] = useState<number | null>(null);

  // the price series for THIS asset. keyed on the code, so opening a different
  // asset refetches rather than showing the last one's curve.
  const { chart, loading, range, setRange } = useValueChart(code || "none", (r) =>
    call({ type: "assetSeries", symbol: code || "XLM", range: r }),
  );

  useEffect(() => {
    if (!code) return;
    let live = true;
    setMarket(null);
    setMarketLoaded(false);
    call({ type: "assetMarket", symbol: code })
      .then((m) => {
        if (live) setMarket(m);
      })
      .catch(() => {
        // a market we cannot read is an absent row, never an error banner over
        // a balance the ledger answered for perfectly well.
        if (live) setMarket(null);
      })
      .finally(() => {
        if (live) setMarketLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [code]);

  if (!shown) return null;

  const scrubbed = scrubAt === null ? null : (chart?.points[scrubAt]?.value ?? null);
  const price = scrubbed ?? market?.price ?? null;
  // holdings * price through the shared money formatter, so this fiat value
  // rounds the same as every other dollar figure in the product. null (no price)
  // renders as a dash, not a fabricated zero-dollar holding.
  //
  // Priced on the SAME figure the row above it shows. This read `total ?? amount`
  // while the row rendered `amount`, so on native XLM the two adjacent lines
  // described different quantities and differed by the account's reserve: the
  // sheet said you hold 9,999 XLM and, directly beneath, said that is worth what
  // 10,000 XLM is worth. Neither number was wrong; the pair was, and nothing on
  // the sheet accounted for the gap. Whichever figure the row states, the value
  // has to be the value OF IT.
  const holdingsValue = usdOf(shown.amount, market?.price ?? null);

  return (
    // `full`: the sheet opens at full height from the first frame. without it the
    // sheet sized to its content, then grew as the chart and market loaded, so it
    // "became" a full page a beat after opening instead of arriving as one.
    //
    // the Send action rides the sheet's `footer` slot, which pins it to the true
    // bottom of the full-height sheet. it used to be a `position: sticky` div at
    // the end of the content, and on the short, few-row detail view sticky had
    // nothing to stick against, so the button floated in the middle of the sheet.
    <Sheet
      t={t}
      open={asset !== null}
      onClose={onClose}
      focusKey={code}
      full
      footer={
        // Same rule as the send picker: an unauthorised trustline cannot send,
        // the wallet knows it and says so on Home, and offering the action
        // anyway spends the user's attention on a form the network will refuse.
        <Button t={t} disabled={!shown.authorized} onClick={() => onSend(shown)}>
          {shown.authorized ? "Send" : "Not authorised by the issuer"}
        </Button>
      }
    >
      <div>
        {/* the badge, then the name with its change on one line so the percent
            reads against the token it belongs to, then the price beneath. */}
        <AssetTile t={t} id={shown.id} code={code} size={44} />
        <div style={{ marginTop: space.md }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: space.md,
            }}
          >
            <div style={{ ...text.screenTitle, color: t.text, lineHeight: 1.1, minWidth: 0 }}>
              {code}
            </div>
            <ChangeChip t={t} pct={scrubAt === null ? (market?.change24h ?? null) : null} />
          </div>
          <div style={{ marginTop: 3 }}>
            {price !== null ? (
              <span style={{ ...text.heading, color: t.text, fontVariantNumeric: "tabular-nums" }}>
                {/* rolls its digits on a scrub, the same as the home hero. the
                    per-unit price keeps six sub-dollar places via money.price;
                    the holding VALUE below goes through money.usdOf (four). */}
                <Rolling value={priceUsd(price)} />
              </span>
            ) : marketLoaded ? (
              <span style={{ ...text.heading, color: t.faint }}>Price unavailable</span>
            ) : (
              // shimmer while the price is in flight, the same as the home hero.
              <Skeleton width={120} height={26} />
            )}
          </div>
        </div>

        <ValueChartBlock
          t={t}
          chart={chart}
          loading={loading}
          range={range}
          onRange={setRange}
          onScrub={setScrubAt}
          width={FRAME.width}
          bleed={space.gutter}
          style={{ marginTop: space.lg }}
        />

        <div
          style={{ marginTop: space.xl, display: "flex", flexDirection: "column", gap: space.sm }}
        >
          <DetailRow
            t={t}
            icon={<AssetTile t={t} id={shown.id} code={code} size={28} />}
            label="Your holdings"
          >
            <Amount t={t} value={shown.amount} code={code} size="row" />
          </DetailRow>

          {/* market rows shimmer while the fetch is in flight instead of popping
              in a beat late. once loaded, a row we could not source is simply
              absent. */}
          <DetailRow t={t} icon={<RowIcon t={t}>$</RowIcon>} label="Holdings value">
            {holdingsValue !== null ? (
              <Figure value={holdingsValue} />
            ) : marketLoaded ? (
              <span style={{ color: t.faint }}>—</span>
            ) : (
              <Skeleton width={64} height={16} />
            )}
          </DetailRow>

          <DetailRow
            t={t}
            icon={
              <RowIcon t={t}>
                <VolumeGlyph color={t.sub} />
              </RowIcon>
            }
            label="24h volume"
          >
            {market?.volume24h !== null && market?.volume24h !== undefined ? (
              compactUsd(market.volume24h)
            ) : marketLoaded ? (
              <span style={{ color: t.faint }}>—</span>
            ) : (
              <Skeleton width={64} height={16} />
            )}
          </DetailRow>
        </div>
      </div>
    </Sheet>
  );
}
