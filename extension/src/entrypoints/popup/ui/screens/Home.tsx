import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, UIEvent } from "react";
import { nativeOf, useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { ChangeChip, ValueChartBlock, useValueChart } from "../Chart";
import { NAV_SPACE } from "../BottomNav";
import { Amount, HeroAmount } from "../Amount";
import { shortAddress } from "../Address";
import { Avatar } from "../Avatar";
import { AssetLogo, tokenIconFile } from "../AssetIcon";
import { InfoTip } from "../Tooltip";
import {
  Button,
  Card,
  IconButton,
  IconDisc,
  Notice,
  Overline,
  Row,
  ScrollArea,
  Skeleton,
  useLeave,
} from "../primitives";
import { Held } from "../Held";
import { Check, Copy, Dots, Eye, EyeOff, Gear, Lock, QrIcon, Refresh, Shield } from "../icons";
import {
  FRAME,
  fonts,
  fontSizes,
  motion,
  radius,
  space,
  text,
  type Pocket,
  type Theme,
} from "../theme";
import { usd, usdOf } from "../money";
import { capDecimals } from "../../../../core/chain/balances";
import type { PrivatePocket } from "../../../../core/messages";

export function Home() {
  const w = useWallet();
  const t = w.t;
  const status = w.status;
  const priv = w.priv;
  const privAssets = w.privAssets;
  const native = nativeOf(w.balances);
  const isPrivate = w.pocket === "private";
  // more than one confidential asset is configured: the private pocket becomes a
  // list of per-asset pockets, mirroring the public pocket. one asset (the common
  // case, and every past build) keeps the single-pocket hero and body unchanged.
  const multiPrivate = (status?.privateAssets?.length ?? 0) > 1;
  // transactions this popup is still watching in the pocket in view, surfaced as a
  // count next to the header's refresh so a backgrounded send is reachable from
  // home without going to Activity.
  const processingCount = w.backgroundOps.filter(
    (o) => o.pocket === w.pocket && o.status === "processing",
  ).length;

  // the public pocket's value over time. keyed on the address so switching
  // wallets refetches, and NOT on the pocket: the private pocket has no chart,
  // so re-running this when the tab flips would be a request for nothing.
  const {
    chart,
    loading: chartLoading,
    range,
    setRange,
  } = useValueChart(status?.address ?? "none", (r) => call({ type: "valueSeries", range: r }));
  const [scrubAt, setScrubAt] = useState<number | null>(null);
  // the header overflow menu, a dropdown anchored under the ⋯ button rather than a
  // bottom sheet. escape closes it, matching every other dismissable surface.
  const [menuOpen, setMenuOpen] = useState(false);
  // keep the dropdown mounted through its exit so it folds back into the button it
  // came from instead of blinking away.
  const menu = useLeave(menuOpen, 140);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const publicLatest =
    chart && chart.points.length ? chart.points[chart.points.length - 1]!.value : null;

  // a market price per held asset, for the dollar value shown under each row. one
  // fetch per distinct asset code (there are one or two), each falling back to null
  // so a missing price leaves the row in its own unit rather than a fabricated $0.
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  // the private assets are priced too, so the private hero can total their value
  // and each private row can show its own dollar figure, exactly like public.
  const privateSymbols = (status?.privateAssets ?? []).map((a) => a.symbol);
  const codeKey = [...(w.balances ?? []).map((b) => b.code), ...privateSymbols].join(",");
  useEffect(() => {
    const codes = Array.from(
      new Set([...(w.balances ?? []).map((b) => b.code), ...privateSymbols]),
    );
    if (codes.length === 0) return;
    let live = true;
    Promise.all(
      codes.map((c) =>
        call({ type: "assetMarket", symbol: c })
          .then((m) => [c, m.price] as const)
          .catch(() => [c, null] as const),
      ),
    ).then((entries) => {
      if (live) setPrices(Object.fromEntries(entries));
    });
    return () => {
      live = false;
    };
  }, [codeKey]);

  // the collapsing header: a RUBBER BAND, not a switch. the account row and pocket
  // tabs stay pinned; the balance/chart/range block collapses in place (max-height +
  // opacity) as you wheel down and expands as you wheel up, FOLLOWING the wheel by a
  // progress 0..1. a light scroll only pulls it partway, and if you let go short of
  // the midpoint it springs back rather than committing — so it resists a single
  // flick in either direction instead of flipping on one tick.
  const heroInner = useRef<HTMLDivElement>(null);
  const [heroH, setHeroH] = useState(0);
  useEffect(() => {
    const el = heroInner.current;
    if (!el) return;
    const measure = () => setHeroH(el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [isPrivate]);

  // progress 0 (open) .. 1 (collapsed). the ref is the live value the wheel drives;
  // `snapping` turns the spring transition ON at the end of a gesture and OFF while
  // the wheel is dragging it, so mid-gesture it tracks the finger and on release it
  // eases to whichever end it was past.
  const [progress, setProgress] = useState(0);
  const [snapping, setSnapping] = useState(false);
  const progressRef = useRef(0);
  const scRef = useRef<HTMLDivElement>(null);
  const snapTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const setP = (p: number) => {
    progressRef.current = p;
    setProgress(p);
  };

  // each pocket opens fully expanded rather than inheriting the other's progress.
  useEffect(() => {
    setSnapping(false);
    setP(0);
  }, [isPrivate]);
  useEffect(() => () => clearTimeout(snapTimer.current), []);

  // a NATIVE, non-passive wheel listener: it preventDefaults the browser scroll so
  // the block folds in place with no scroll-jump. `COLLAPSE_DIST` is the wheel
  // travel for the whole fold, so a larger value is more resistance.
  const COLLAPSE_DIST = 260;
  useEffect(() => {
    const sc = scRef.current;
    if (!sc) return;
    const spring = () => {
      clearTimeout(snapTimer.current);
      snapTimer.current = setTimeout(() => {
        setSnapping(true);
        setP(progressRef.current >= 0.5 ? 1 : 0);
      }, 90);
    };
    const onWheel = (e: WheelEvent) => {
      const p = progressRef.current;
      const atTop = sc.scrollTop <= 0;
      const canCollapse = p < 1 && e.deltaY > 0 && atTop;
      const canExpand = p > 0 && e.deltaY < 0 && atTop;
      if (!canCollapse && !canExpand) return; // let the token list scroll natively
      e.preventDefault();
      setSnapping(false);
      setP(Math.max(0, Math.min(1, p + e.deltaY / COLLAPSE_DIST)));
      spring();
    };
    sc.addEventListener("wheel", onWheel, { passive: false });
    return () => sc.removeEventListener("wheel", onWheel);
  }, []);

  // a fallback for non-wheel scrolls (keyboard, scrollbar): commit the collapse.
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    if (progressRef.current < 1 && e.currentTarget.scrollTop > 8) {
      setSnapping(true);
      setP(1);
    }
  };

  // the same figure the headline carries, shown small in the pinned tab row once
  // the headline itself has scrolled away. the latest value, never the scrubbed
  // one: the chart the scrub reads from is not on screen when this figure is.
  const privTotal = privateTotalUsd();
  const headerAmount = isPrivate ? (
    multiPrivate ? (
      privTotal !== null ? (
        <span style={{ ...text.rowTitle, color: t.text }}>
          {w.hidden ? "$∗∗∗.∗∗∗" : usd(privTotal)}
        </span>
      ) : null
    ) : priv && priv.state === "ready" && priv.spendable ? (
      <Amount
        t={t}
        value={priv.spendable}
        code={priv.symbol ?? "XLM"}
        size="row"
        hidden={w.hidden}
      />
    ) : null
  ) : publicLatest !== null ? (
    <span style={{ ...text.rowTitle, color: t.text }}>
      {w.hidden ? "$∗∗∗.∗∗∗" : usd(publicLatest)}
    </span>
  ) : null;

  return (
    <ScrollArea ref={scRef} className="pocket-page" background={t.canvas} onScroll={onScroll}>
      {/* pinned: the account and the pocket tabs never leave. the background and
          the hairline under it fade in only once the block is collapsed, so at rest
          the block is seamless with the canvas and, in the private pocket, lets the
          glow through. */}
      <div style={{ position: "sticky", top: 0, zIndex: 5 }}>
        <div aria-hidden style={headerVeil(t, progress, snapping)} />
        <div
          style={{
            position: "relative",
            padding: `${space.gutter}px ${space.gutter}px ${space.sm}px`,
          }}
        >
          {accountRow()}

          {/* one row: the tabs on the left, and the compact figure held OUT of
              flow on the right so it can never squeeze the tabs onto a second
              line the way an in-flow sibling did. */}
          <div
            style={{
              position: "relative",
              display: "flex",
              alignItems: "center",
              minHeight: 30,
              marginTop: space.lg,
            }}
          >
            <div style={{ display: "flex", gap: space.lg, flexWrap: "nowrap", minWidth: 0 }}>
              {pocketTab("public", "Public Pocket")}
              {status?.privateAvailable && pocketTab("private", "Private Pocket")}
            </div>
            {headerAmount && (
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  right: 0,
                  top: "50%",
                  transform: `translateY(-50%)`,
                  maxWidth: 150,
                  overflow: "hidden",
                  textAlign: "right",
                  opacity: progress,
                  transition: snapping ? `opacity ${motion.roll} ${motion.enter}` : "none",
                  pointerEvents: "none",
                }}
              >
                {headerAmount}
              </div>
            )}
          </div>
        </div>
      </div>

      <div style={{ position: "relative", padding: `0 ${space.gutter}px ${NAV_SPACE}px` }}>
        {/* the balance + chart + range tabs, as a block that COLLAPSES its height to
            0 on scroll so the token list slides up under the pinned tabs. the inner
            div is what is measured, so the max-height animates over the exact
            height rather than a guessed one. */}
        <div
          style={{
            maxHeight: heroH ? (heroH + space.xs) * (1 - progress) : undefined,
            opacity: 1 - progress,
            overflow: "hidden",
            // extend the clip box out to the frame edges (and pad the content back)
            // so the full-bleed chart is not sliced off by the vertical collapse
            // clip. the collapse itself only clips top and bottom.
            marginLeft: -space.gutter,
            marginRight: -space.gutter,
            paddingLeft: space.gutter,
            paddingRight: space.gutter,
            // no transition while the wheel is dragging progress (it tracks the
            // finger); the spring transition comes on only at the end of a gesture.
            transition: snapping
              ? `max-height ${motion.roll} ${motion.enter}, opacity ${motion.roll} ${motion.enter}`
              : "none",
          }}
        >
          <div ref={heroInner} style={{ marginTop: space.xs }}>
            {isPrivate ? privateHero() : publicHero()}
          </div>
        </div>

        {isPrivate ? privateBody() : publicBody()}
      </div>
    </ScrollArea>
  );

  function publicHero() {
    if (w.balanceError && !native) {
      return (
        <Notice t={t} tone="danger">
          {w.balanceError}
        </Notice>
      );
    }
    if (w.balances && !native) {
      return (
        <Notice t={t} tone="danger">
          The ledger did not report a balance for this account. Reopen the wallet to try again.
        </Notice>
      );
    }
    // while the chart is scrubbed the headline shows the value at the touched
    // moment. on release it returns to the present: a chart nobody is touching
    // must not leave a past number standing where the balance belongs.
    const scrubbed = scrubAt === null ? null : (chart?.points[scrubAt]?.value ?? null);
    const shown = scrubbed ?? publicLatest;

    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            {/* dollars on top, the ledger's own figure underneath. the dollar
                value depends on a market that may be unreadable; the XLM figure
                does not. the one that can go missing is never the one that
                carries the balance. */}
            <HeroAmount
              t={t}
              value={shown === null ? null : usd(shown)}
              code=""
              hidden={w.hidden}
            />
          </div>
          <ChangeChip t={t} pct={scrubAt === null ? (chart?.changePct ?? null) : null} />
        </div>

        <ValueChartBlock
          t={t}
          chart={chart}
          loading={chartLoading}
          range={range}
          onRange={setRange}
          onScrub={setScrubAt}
          width={FRAME.width}
          bleed={space.gutter}
          style={{ marginTop: space.sm }}
        />
      </>
    );
  }

  // the private spendable, valued in dollars across every asset we can price. null
  // when nothing ready can be priced, so the caller can fall back to a unit figure
  // rather than a fabricated total.
  function privateTotalUsd(): number | null {
    if (!privAssets) return null;
    let total = 0;
    let any = false;
    for (const p of privAssets) {
      if (p.state !== "ready" || !p.spendable) continue;
      const price = prices[p.symbol ?? ""] ?? null;
      if (price == null) continue;
      total += Number(p.spendable) * price;
      any = true;
    }
    return any ? total : null;
  }

  function privateHero() {
    return multiPrivate ? multiAssetHero() : singleAssetHero();
  }

  // one confidential asset (every past build): the pocket's own spendable, in its
  // own unit. symbol-driven, so the one asset need not be XLM.
  function singleAssetHero() {
    const symbol = priv?.symbol ?? "XLM";
    if (w.privError && !priv) {
      return (
        <Notice t={t} tone="danger">
          {w.privError}
        </Notice>
      );
    }
    if (!priv) {
      // reading this pocket means scanning the retained event window for
      // payments that arrived while the wallet was closed, and that can take
      // minutes. a shimmer alone says "wait" without saying what for.
      return (
        <>
          <HeroAmount t={t} value={null} code={symbol} />
          <div style={{ ...text.caption, color: t.faint, minHeight: 16 }}>
            Looking for payments you have received.
          </div>
        </>
      );
    }
    if (priv.state !== "ready") {
      return (
        <div
          style={{
            minHeight: Math.round(fontSizes.hero * 1.25),
            display: "flex",
            alignItems: "center",
          }}
        >
          <span style={{ ...text.display, color: t.faint }}>{HERO_STATE[priv.state]}</span>
        </div>
      );
    }
    if (!priv.spendable) {
      return (
        <div
          style={{
            minHeight: Math.round(fontSizes.hero * 1.25),
            display: "flex",
            alignItems: "center",
          }}
        >
          <span style={{ ...text.heading, color: t.sub }}>
            Not reported. Close and reopen the wallet to read it again.
          </span>
        </div>
      );
    }
    return <HeroAmount t={t} value={priv.spendable} code={symbol} hidden={w.hidden} />;
  }

  // more than one confidential asset: a dollar total across the ready ones, like
  // the public hero. the per-asset figures live in the list below.
  function multiAssetHero() {
    if (w.privError && !privAssets) {
      return (
        <Notice t={t} tone="danger">
          {w.privError}
        </Notice>
      );
    }
    if (!privAssets) {
      return (
        <>
          <HeroAmount t={t} value={null} code="" />
          <div style={{ ...text.caption, color: t.faint, minHeight: 16 }}>
            Looking for payments you have received.
          </div>
        </>
      );
    }
    const total = privateTotalUsd();
    if (total !== null) {
      return <HeroAmount t={t} value={usd(total)} code="" hidden={w.hidden} />;
    }
    // nothing priceable: show the largest spendable holding in its own unit rather
    // than a $0.00 that would read as empty, or a muted line if nothing is
    // spendable yet (the list below says what each asset needs).
    const held = privAssets.find(
      (p) => p.state === "ready" && p.spendable && /[1-9]/.test(p.spendable),
    );
    if (held) {
      return (
        <HeroAmount t={t} value={held.spendable!} code={held.symbol ?? ""} hidden={w.hidden} />
      );
    }
    return (
      <div
        style={{
          minHeight: Math.round(fontSizes.hero * 1.25),
          display: "flex",
          alignItems: "center",
        }}
      >
        <span style={{ ...text.heading, color: t.sub }}>Nothing spendable yet</span>
      </div>
    );
  }

  function publicBody() {
    return (
      <>
        {status?.privateAvailable && priv && priv.state !== "ready" && (
          <div style={{ marginTop: space.gutter }}>{privatePrompt(priv)}</div>
        )}

        <div style={{ marginTop: space.xl }}>
          <Overline t={t}>Assets</Overline>
          {w.balances === null ? (
            // the placeholders match the real Row height (52) and count, so the list
            // does not jump when the balances arrive.
            <div style={{ display: "grid", gap: space.md, paddingTop: space.xs }}>
              <Skeleton width="100%" height={52} />
              <Skeleton width="100%" height={52} />
              <Skeleton width="100%" height={52} />
            </div>
          ) : (
            w.balances.map((b, i) => (
              <Row
                key={b.id}
                t={t}
                index={i}
                iconRing
                icon={<AssetMark t={t} id={b.id} code={b.code} />}
                title={b.code}
                sub={
                  b.id === "native" ? (
                    "Stellar Lumens"
                  ) : b.issuer ? (
                    // an issuer is verbatim address data, read one glyph at a time, so
                    // it belongs in the mono face like every other address in the wallet.
                    <span style={{ fontFamily: fonts.mono }}>{shortAddress(b.issuer)}</span>
                  ) : undefined
                }
                value={<Amount t={t} value={b.amount} size="row" hidden={w.hidden} />}
                valueSub={
                  !b.authorized
                    ? "Not authorised"
                    : w.hidden
                      ? "∗∗∗"
                      : (usdOf(b.amount, prices[b.code] ?? null) ?? undefined)
                }
                onClick={() => w.openAsset(b)}
              />
            ))
          )}
        </div>

        {yieldRow()}
      </>
    );
  }

  function privateBody() {
    return multiPrivate ? multiAssetBody() : singleAssetBody();
  }

  // one confidential asset: the pocket's receiving card, TTL warning, or its
  // set-up prompt. symbol-driven so it need not be XLM.
  function singleAssetBody() {
    if (!priv) return null;
    const symbol = priv.symbol ?? "XLM";
    if (priv.state !== "ready") {
      return <div style={{ marginTop: space.gutter }}>{privatePrompt(priv)}</div>;
    }
    return (
      <>
        {/* only when something is actually waiting: a "Receiving 0" card is noise.
            the string test avoids a float parse in the value path. */}
        {priv.receiving && /[1-9]/.test(priv.receiving) && (
          <div style={{ marginTop: space.gutter }}>
            <Held
              t={t}
              label="Receiving"
              amount={priv.receiving}
              code={symbol}
              holding="Received funds sit here until you make them spendable."
              action={{ label: "Make spendable", onClick: () => w.openSheet("move") }}
            />
          </div>
        )}

        {typeof priv.daysRemaining === "number" && priv.daysRemaining < 8 && (
          <div style={{ marginTop: space.gutter }}>
            <Notice t={t} tone="exposed">
              This pocket goes dormant in {priv.daysRemaining} days unless it is used. Opening the
              wallet before then is what keeps it alive.
            </Notice>
          </div>
        )}
      </>
    );
  }

  // more than one confidential asset: a list, one row per asset, exactly like the
  // public pocket. each row carries its own spendable or its state, and opens that
  // asset's detail, where its actions live.
  function multiAssetBody() {
    return (
      <div style={{ marginTop: space.xl }}>
        <Overline t={t}>Assets</Overline>
        {!privAssets ? (
          <div style={{ display: "grid", gap: space.md, paddingTop: space.xs }}>
            <Skeleton width="100%" height={52} />
            <Skeleton width="100%" height={52} />
          </div>
        ) : (
          privAssets.map((p, i) => (
            <PrivateAssetRow
              key={p.token ?? p.symbol ?? i}
              t={t}
              p={p}
              index={i}
              price={prices[p.symbol ?? ""] ?? null}
              hidden={w.hidden}
              onClick={() => w.openPrivateAsset(p)}
            />
          ))
        )}
      </div>
    );
  }

  function privatePrompt(priv: PrivatePocket) {
    const open = () => w.openSheet("move");
    const action = PROMPT_ACTION[priv.state];
    return (
      <Card t={t} tone="accent">
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.md,
            flexWrap: "wrap",
            marginBottom: priv.message ? space.sm : 0,
          }}
        >
          <IconDisc t={t} size={36}>
            <Shield size={19} />
          </IconDisc>
          <span
            style={{
              ...text.rowTitle,
              color: t.text,
              flex: 1,
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {PROMPT_TITLE[priv.state]}
            {/* the long "why" moves off the card and into the tip. the card now
                says the state and offers the one action; the reasoning is a hover
                away rather than a paragraph nobody reads. */}
            <InfoTip t={t} label="About the private pocket">
              {priv.message ? (
                <span style={{ display: "block", marginBottom: 6 }}>{priv.message}</span>
              ) : null}
              Hides amounts, never addresses. Who you pay stays public on the ledger.
            </InfoTip>
          </span>
          {action && (
            // the compact field-fill CTA is the pill Button's quiet variant now, so
            // the five hand-rolled accent/field pills stop each re-deriving the fill.
            <Button t={t} variant="quiet" size="pill" onClick={open}>
              {action}
            </Button>
          )}
        </div>
      </Card>
    );
  }

  function yieldRow() {
    const y = w.yieldPosition;
    if (!y) return null;
    return (
      <div style={{ marginTop: space.xl }}>
        <Overline t={t}>Yield</Overline>
        {y.available ? (
          <div style={{ display: "flex", alignItems: "center", gap: space.sm, minHeight: 44 }}>
            <span
              style={{
                ...text.rowTitle,
                color: t.text,
                flex: 1,
                minWidth: 0,
                display: "flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              Vault position
              {/* the APY and its caveat were a sentence jammed into a subtitle
                  ("14.67% over the last 7 days, variable and not guaranteed
                  reported"). the figure stays; the sentence becomes a tip. */}
              {y.apy && (
                <InfoTip t={t} label="About this yield">
                  {y.apy} at the moment. It is variable and not guaranteed, and it is reported by
                  the vault rather than earned in the private pocket.
                </InfoTip>
              )}
            </span>
            <span style={{ ...text.rowTitle, color: t.text }}>
              {y.balance ? `${y.balance} shares` : "None deposited"}
            </span>
          </div>
        ) : (
          // the "not configured" case is short and factual, so it stays inline.
          <div style={{ ...text.caption, color: t.faint, lineHeight: 1.5 }}>{y.reason}</div>
        )}
      </div>
    );
  }

  function accountRow() {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
        {status?.address ? (
          <Avatar t={t} eyesClosed={isPrivate} size={44} />
        ) : (
          <Skeleton width={44} height={44} />
        )}
        <div style={{ minWidth: 0, flex: "1 1 90px" }}>
          <h1 style={{ margin: 0, lineHeight: 0 }}>
            <img
              src={chrome.runtime.getURL("logo.png")}
              alt="Pocket"
              style={{
                height: 20,
                width: "auto",
                display: "block",
                // the wordmark is black; on the dark private pocket it inverts to white.
                filter: t.dark ? "invert(1)" : "none",
              }}
            />
          </h1>
          {status?.address ? (
            <button
              type="button"
              onClick={() => w.copy(status.address!)}
              aria-label="Copy your address"
              style={{
                all: "unset",
                boxSizing: "border-box",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                minHeight: 28,
                color: t.sub,
              }}
            >
              {/* an address is verbatim data: mono at 500, like every other
                  address in the product, not the proportional row face. */}
              <span
                style={{
                  ...text.rowSub,
                  fontFamily: fonts.mono,
                  fontWeight: 500,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {w.hidden ? "∗∗∗ ∗∗∗" : shortAddress(status.address)}
              </span>
              {/* the check matches the copy glyph's size so the swap does not jog the icon. */}
              {w.copied ? <Check size={13} sw={2.4} /> : <Copy size={13} />}
            </button>
          ) : (
            <Skeleton width={120} height={13} />
          )}
        </div>
        {/* the in-progress count, opening the transactions sheet. only present while
            something is in flight, so at rest the header is the account and its two
            buttons and nothing more. */}
        {processingCount > 0 && (
          <button
            type="button"
            aria-label={`${processingCount} in progress`}
            onClick={() => w.openSheet("transactions")}
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: "pointer",
              width: 34,
              height: 34,
              flex: "0 0 auto",
              borderRadius: "50%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: t.accentSoft,
              color: t.accentOnSoft,
              ...text.value,
            }}
          >
            {processingCount > 9 ? "9+" : processingCount}
          </button>
        )}
        {/* size omitted: 34 is IconButton's default, so the header buttons and the
            Header component's back/close button are one size by the same source. */}
        <IconButton t={t} label="Refresh" onClick={() => void w.refresh()}>
          <Refresh size={18} className={w.refreshing ? "pocket-spinner" : undefined} />
        </IconButton>
        {/* a menu, not a bare padlock. locking is one item inside it rather than
            a stray tap in the header. a dropdown anchored under the button, not a
            bottom sheet, so it reads as belonging to the control it came from. */}
        <span style={{ position: "relative", display: "inline-flex", flex: "0 0 auto" }}>
          <IconButton
            t={t}
            label="More"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((o) => !o)}
          >
            <Dots size={18} />
          </IconButton>
          {menu.render && headerMenu(menu.leaving)}
        </span>
      </div>
    );
  }

  // the header overflow menu. a plain function that RETURNS jsx (not a nested
  // component), so it does not remount its tree on every Home render. anchored to
  // the ⋯ button's own relative span, opening down and left into the frame.
  function headerMenu(leaving: boolean) {
    const close = () => setMenuOpen(false);
    const go = (fn: () => void) => () => {
      close();
      fn();
    };
    const item = (icon: ReactNode, label: string, onClick: () => void, last = false) => (
      <button
        type="button"
        role="menuitem"
        onClick={onClick}
        className="pk-tap"
        style={{
          all: "unset",
          boxSizing: "border-box",
          cursor: "pointer",
          display: "flex",
          alignItems: "center",
          gap: space.md,
          width: "100%",
          padding: `${space.sm}px ${space.md}px`,
          color: t.text,
          borderBottom: last ? "none" : `1px solid ${t.line}`,
        }}
      >
        <span style={{ display: "flex", color: t.accent, flex: "0 0 auto" }}>{icon}</span>
        <span style={{ ...text.rowSub, fontWeight: 600 }}>{label}</span>
      </button>
    );
    return (
      <>
        {/* a transparent full-frame catcher: one tap outside closes the menu. */}
        <div aria-hidden onClick={close} style={{ position: "fixed", inset: 0, zIndex: 40 }} />
        <div
          role="menu"
          aria-label="Wallet menu"
          className={leaving ? "pocket-menu-out" : "pocket-menu-in"}
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 41,
            minWidth: 210,
            background: t.sheet,
            border: `1px solid ${t.line}`,
            borderRadius: radius.lg,
            boxShadow: t.shadow,
            overflow: "hidden",
          }}
        >
          {item(
            <QrIcon size={19} />,
            "Receive",
            go(() => w.openSheet("receive")),
          )}
          {item(
            w.hidden ? <Eye size={19} /> : <EyeOff size={19} />,
            w.hidden ? "Show balance" : "Hide balance",
            () => {
              w.toggleHidden();
              close();
            },
          )}
          {item(
            <Gear size={19} />,
            "Settings",
            go(() => {
              w.closeAllSheets();
              w.setTab("settings");
            }),
          )}
          {item(
            <Lock size={19} />,
            "Lock wallet",
            go(() => void w.lock()),
            true,
          )}
        </div>
      </>
    );
  }

  function pocketTab(pocket: Pocket, label: string) {
    const on = w.pocket === pocket;
    const style: CSSProperties = {
      all: "unset",
      cursor: "pointer",
      // the shared pocket-tab role: body size so the tabs and the compact figure
      // ride one row, heading weight and tracking so the active pocket reads as a
      // title rather than a control. the call site owns only colour and whiteSpace.
      ...text.pocketTab,
      // one line, always. the label is a value, not prose, so it must not break
      // onto a second line the way the account title is allowed to.
      whiteSpace: "nowrap",
      // no underline. the active pocket is said by weight and colour, and the
      // whole surface already flips light/dark to say which pocket you are in.
      color: on ? t.text : t.faint,
      transition: "color 200ms ease",
    };
    return (
      <button
        type="button"
        aria-pressed={on}
        // blur after a mouse press so the keyboard focus ring, which WCAG needs
        // dark on this near-white surface, does not sit as a black box around a
        // tab someone merely clicked. a keyboard-activated click reports
        // detail 0, so we only blur on a real pointer press and leave keyboard
        // focus on the tab the user just moved to.
        onClick={(e) => {
          w.setPocket(pocket);
          if (e.detail > 0) e.currentTarget.blur();
        }}
        style={style}
      >
        {label}
      </button>
    );
  }
}

/**
 * what stands in the balance slot when there is no number to put there.
 *
 * two groups, not one. a pocket that was never opened and a pocket whose balance
 * this device cannot currently read are different facts about the user's money,
 * and "Not open yet" is false for the second: the money is there, and saying it
 * was never opened is the most frightening available reading of a state that is
 * usually one press from fixed.
 *
 * the words are `Held`'s labels, so the hero and the sheet that fixes it call the
 * same state by the same name.
 */
const HERO_STATE: Record<PrivatePocket["state"], string> = {
  unavailable: "Not open yet",
  unfunded: "Not open yet",
  unregistered: "Not open yet",
  archived: "Dormant",
  needsRecovery: "Needs rebuilding",
  diverged: "Out of step",
  ready: "",
};

const PROMPT_TITLE: Record<PrivatePocket["state"], string> = {
  unavailable: "No private pocket on this network",
  unfunded: "Fund this account first",
  unregistered: "Private pocket not set up",
  archived: "Private pocket is dormant",
  needsRecovery: "Balances need rebuilding",
  diverged: "Records do not match the ledger",
  ready: "",
};

const PROMPT_ACTION: Record<PrivatePocket["state"], string | null> = {
  unavailable: null,
  unfunded: null,
  unregistered: "Set up",
  archived: "Reactivate",
  needsRecovery: "Rebuild",
  diverged: "Rebuild",
  ready: null,
};

/** the value-slot word for a private asset that is not ready to spend. */
const ROW_STATE_LABEL: Record<PrivatePocket["state"], string> = {
  unavailable: "—",
  unfunded: "Fund first",
  unregistered: "Set up",
  archived: "Dormant",
  needsRecovery: "Rebuild",
  diverged: "Rebuild",
  ready: "",
};

/** the one-line reason under a not-ready private asset row. */
const ROW_STATE_SUB: Record<PrivatePocket["state"], string> = {
  unavailable: "Not available on this network",
  unfunded: "Fund this account first",
  unregistered: "Not set up yet",
  archived: "Dormant from not being used",
  needsRecovery: "Balances need rebuilding",
  diverged: "Records differ from the ledger",
  ready: "",
};

/** the names we can say for a private asset; an unknown symbol shows no subtitle. */
const PRIVATE_ASSET_NAME: Record<string, string> = {
  XLM: "Stellar Lumens",
  USDC: "USD Coin",
};

/**
 * the logo id for a private asset. native wears its real mark; a wrapped classic
 * asset falls to AssetMark's safe monogram, because its verified issuer is not on
 * the wire and a code-matched logo could be the wrong issuer's mark. shared so the
 * list, the forms, and the detail sheet all draw one asset the same way.
 */
export function privateMarkId(symbol: string): string {
  return symbol === "XLM" ? "native" : symbol;
}

/**
 * one private asset in the pocket's list. its mark and symbol, then its spendable
 * when ready or its state word otherwise. anything needing attention (funds
 * waiting, a setup owed) is drawn in an accent so the list surfaces it without the
 * user opening each asset.
 */
export function PrivateAssetRow({
  t,
  p,
  index,
  price,
  hidden,
  onClick,
}: {
  t: Theme;
  p: PrivatePocket;
  index: number;
  price: number | null;
  hidden: boolean;
  onClick: () => void;
}) {
  const symbol = p.symbol ?? "XLM";
  const ready = p.state === "ready";
  const receiving = ready && p.receiving && /[1-9]/.test(p.receiving) ? p.receiving : null;

  const value = ready ? (
    <Amount t={t} value={p.spendable ?? "0"} size="row" hidden={hidden} />
  ) : (
    <span style={{ ...text.value, color: t.exposed }}>{ROW_STATE_LABEL[p.state]}</span>
  );

  const valueSub = ready
    ? hidden
      ? "∗∗∗"
      : p.spendable
        ? (usdOf(p.spendable, price) ?? undefined)
        : undefined
    : undefined;

  const sub = receiving ? (
    <span style={{ color: t.accent }}>Receiving {capDecimals(receiving, 4)}</span>
  ) : ready ? (
    PRIVATE_ASSET_NAME[symbol]
  ) : (
    ROW_STATE_SUB[p.state]
  );

  return (
    <Row
      t={t}
      index={index}
      iconRing
      icon={<AssetMark t={t} id={privateMarkId(symbol)} code={symbol} />}
      title={symbol}
      sub={sub}
      value={value}
      valueSub={valueSub}
      onClick={onClick}
    />
  );
}

/**
 * the asset's mark: its brand logo where we ship one, one letter otherwise.
 *
 * the logo is a vendored file keyed on the ISSUER (see AssetIcon), so a "USDC"
 * from an unverified issuer falls through to the letter rather than wearing
 * Circle's logo. the letter is one, not the whole code: the row already says the
 * code and its name, and three letters in the mark is the same word twice, which
 * at 500% zoom is the same word twice overflowing a 40px box.
 */
export function AssetMark({ t, id, code }: { t: Theme; id: string; code: string }) {
  // sized to sit inside Row's 40px tile with room to breathe.
  const file = tokenIconFile(id);
  // the token's own artwork, shown directly: no plate behind it. the caller's
  // tile (Row, the history mark) owns the shape and clips it.
  if (file) return <AssetLogo file={file} size="fill" />;
  return (
    <span
      style={{
        ...text.rowTitle,
        // a step heavier than the row title beside it: the lone fallback letter is
        // standing in for a logo, so it carries a badge's weight rather than prose's.
        fontWeight: 700,
        color: t.dark ? t.accent : t.text,
        lineHeight: 1,
      }}
    >
      {code.slice(0, 1)}
    </span>
  );
}

/**
 * the fill behind the pinned header, faded in by scroll.
 *
 * at rest (`collapse` 0) it is fully transparent, so the pinned block sits over
 * the canvas with nothing drawn between them and the private pocket's glow reads
 * through. as the balance scrolls under it the fill and a hairline come up to
 * full, so what passes beneath is hidden rather than showing through the tabs.
 */
function headerVeil(t: Theme, opacity: number, snapping: boolean): CSSProperties {
  return {
    position: "absolute",
    inset: 0,
    // the CANVAS (its hue gradient), not the flat bg, so the top-of-page hue stays
    // under the pinned header once it is collapsed instead of being painted over
    // by a flat fill. still opaque, so the content behind it is hidden.
    background: t.canvas,
    opacity,
    transition: snapping ? `opacity ${motion.roll} ${motion.enter}` : "none",
    backdropFilter: "blur(18px) saturate(1.6)",
    WebkitBackdropFilter: "blur(18px) saturate(1.6)",
    pointerEvents: "none",
  };
}
