// what one asset is, and what you hold of it.
//
// every row here is either read from the ledger or read from the Stellar DEX.
// there is deliberately no "liquidity" row: horizon publishes no such figure,
// and a row we cannot source is a row we do not draw. the same rule kills
// "market cap".
import { useEffect, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Amount } from "../Amount";
import { shortAddress } from "../Address";
import { Button, Row, Sheet } from "../primitives";
import { ChangeChip, ValueChartBlock, useValueChart } from "../Chart";
import { FRAME, space, text } from "../theme";
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
    <Sheet t={t} open={asset !== null} onClose={onClose} title={code} focusKey={code}>
      <div style={{ padding: `0 ${space.gutter}px ${space.gutter}px` }}>
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            <div style={{ ...text.display, color: t.text }}>
              {price === null ? "Price unavailable" : usd(price)}
            </div>
            <div style={{ ...text.caption, color: t.faint }}>
              {asset.id === "native" ? "Stellar Lumens" : asset.issuer ? shortAddress(asset.issuer) : code}
            </div>
          </div>
          <ChangeChip t={t} pct={scrubAt === null ? (market?.change24h ?? null) : null} />
        </div>

        <ValueChartBlock
          t={t}
          chart={chart}
          loading={loading}
          range={range}
          onRange={setRange}
          onScrub={setScrubAt}
          width={FRAME.width - space.gutter * 2}
          style={{ marginTop: space.md }}
        />

        <div style={{ marginTop: space.lg }}>
          <Row
            t={t}
            title="Your holdings"
            value={<Amount t={t} value={asset.amount} code={code} size="row" />}
          />
          {holdingsValue !== null && (
            <Row t={t} title="Holdings value" value={usd(holdingsValue)} />
          )}
          {asset.reserved && /[1-9]/.test(asset.reserved) && (
            <Row
              t={t}
              title="Held as reserve"
              sub="Locked by the network. Cannot be sent."
              value={<Amount t={t} value={asset.reserved} code={code} size="row" />}
            />
          )}
          {market?.volume24h !== null && market?.volume24h !== undefined && (
            <Row t={t} title="24h volume" value={compactUsd(market.volume24h)} />
          )}
        </div>

        <div style={{ marginTop: space.lg }}>
          <Button t={t} onClick={() => onSend(asset)}>
            Send {code}
          </Button>
        </div>
      </div>
    </Sheet>
  );
}
