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
import { Amount } from "../Amount";
import { Button, Sheet } from "../primitives";
import { ChangeChip, ValueChartBlock, useValueChart } from "../Chart";
import { Lock } from "../icons";
import { FRAME, space, text, type Theme } from "../theme";
import type { AssetMarketView, PublicBalance } from "../../../../core/messages";

/** a dollar figure. sub-dollar prices keep more places so a cheap asset is not rounded to nothing. */
function usd(v: number): string {
  const places = Math.abs(v) >= 1 || v === 0 ? 2 : 6;
  return `$${v.toFixed(places)}`;
}

/** a volume, which is large and does not need cents. */
function compactUsd(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}K`;
  return `$${v.toFixed(2)}`;
}

/**
 * a token's mark.
 *
 * a filled circle in the pocket's colour with the asset's initial, NOT a fetched
 * logo. the same stance the wallet takes everywhere: an image pulled per asset
 * from an issuer-controlled host would be a per-holding tracking pixel, so the
 * mark is drawn on the device from the code alone.
 */
function AssetBadge({ t, code, size }: { t: Theme; code: string; size: number }) {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        flex: "0 0 auto",
        background: t.accentFill,
        color: t.onAccent,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: Math.round(size * 0.42),
        lineHeight: 1,
      }}
    >
      {code.slice(0, 1)}
    </span>
  );
}

/** a small circled glyph for a detail row. */
function RowIcon({ t, children }: { t: Theme; children: ReactNode }) {
  return (
    <span
      aria-hidden
      style={{
        width: 28,
        height: 28,
        borderRadius: "50%",
        flex: "0 0 auto",
        background: t.field,
        color: t.sub,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontWeight: 800,
        fontSize: 13,
      }}
    >
      {children}
    </span>
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
  sub,
  children,
}: {
  t: Theme;
  icon: ReactNode;
  label: string;
  sub?: string;
  children: ReactNode;
}) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: space.md, minHeight: 44 }}>
      {icon}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ ...text.rowTitle, color: t.sub }}>{label}</div>
        {sub && <div style={{ ...text.caption, color: t.faint }}>{sub}</div>}
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
  const code = asset?.code ?? "";

  const [market, setMarket] = useState<AssetMarketView | null>(null);
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
    call({ type: "assetMarket", symbol: code })
      .then((m) => {
        if (live) setMarket(m);
      })
      .catch(() => {
        // a market we cannot read is an absent row, never an error banner over
        // a balance the ledger answered for perfectly well.
        if (live) setMarket(null);
      });
    return () => {
      live = false;
    };
  }, [code]);

  if (!asset) return null;

  const scrubbed = scrubAt === null ? null : (chart?.points[scrubAt]?.value ?? null);
  const price = scrubbed ?? market?.price ?? null;
  // holdings * price, and only when there is a price to multiply by. an absent
  // market must not render as a zero-dollar holding.
  const holdingsValue =
    market?.price !== null && market?.price !== undefined
      ? Number(asset.total ?? asset.amount) * market.price
      : null;

  return (
    <Sheet t={t} open={asset !== null} onClose={onClose} focusKey={code}>
      <div style={{ padding: `0 ${space.gutter}px ${space.gutter}px` }}>
        {/* identity: badge, name, price + change. the sheet's own header above
            this carries only the close button (no title passed), so the close
            sits top-right and the identity reads below it, as in the reference. */}
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <AssetBadge t={t} code={code} size={48} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...text.screenTitle, color: t.text, lineHeight: 1.1 }}>{code}</div>
            <div style={{ display: "flex", alignItems: "center", gap: space.sm, marginTop: 3 }}>
              <span style={{ ...text.heading, color: t.text, fontVariantNumeric: "tabular-nums" }}>
                {price === null ? "Price unavailable" : usd(price)}
              </span>
              <ChangeChip t={t} pct={scrubAt === null ? (market?.change24h ?? null) : null} />
            </div>
          </div>
        </div>

        <ValueChartBlock
          t={t}
          chart={chart}
          loading={loading}
          range={range}
          onRange={setRange}
          onScrub={setScrubAt}
          width={FRAME.width - space.gutter * 2}
          style={{ marginTop: space.lg }}
        />

        <div style={{ marginTop: space.xl, display: "flex", flexDirection: "column", gap: space.lg }}>
          <DetailRow
            t={t}
            icon={<AssetBadge t={t} code={code} size={28} />}
            label="Your holdings"
          >
            <Amount t={t} value={asset.amount} code={code} size="row" />
          </DetailRow>

          {holdingsValue !== null && (
            <DetailRow t={t} icon={<RowIcon t={t}>$</RowIcon>} label="Holdings value">
              {usd(holdingsValue)}
            </DetailRow>
          )}

          {asset.reserved && /[1-9]/.test(asset.reserved) && (
            <DetailRow
              t={t}
              icon={
                <RowIcon t={t}>
                  <Lock size={14} />
                </RowIcon>
              }
              label="Held as reserve"
              sub="Locked by the network. Cannot be sent."
            >
              <Amount t={t} value={asset.reserved} code={code} size="row" />
            </DetailRow>
          )}

          {market?.volume24h !== null && market?.volume24h !== undefined && (
            <DetailRow
              t={t}
              icon={
                <RowIcon t={t}>
                  <VolumeGlyph color={t.sub} />
                </RowIcon>
              }
              label="24h volume"
            >
              {compactUsd(market.volume24h)}
            </DetailRow>
          )}
        </div>

        <div style={{ marginTop: space.xl }}>
          <Button t={t} onClick={() => onSend(asset)}>
            Send {code}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
