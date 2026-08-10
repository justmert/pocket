import { useEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, UIEvent } from "react";
import { nativeOf, useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { canRebuild } from "../copy";
import { ChangeChip, ValueChartBlock, useValueChart } from "../Chart";
import { NAV_SPACE } from "../BottomNav";
import { Amount, HeroAmount, Figure, MASK } from "../Amount";
import { shortAddress } from "../Address";
import { Avatar, useAvatarReaction } from "../Avatar";
import { AssetLogo, tokenIconFile } from "../AssetIcon";
import { phraseNeverConfirmed, clearPhraseNeverConfirmed } from "../onboardingTab";
import { InfoTip } from "../Tooltip";
import { FundTestnetCard } from "../FundTestnet";
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
import { NETWORKS, type NetworkId } from "../../../../core/config";
import { capDecimals, displayAmount, parseAmount } from "../../../../core/chain/balances";
import type { PrivatePocket, PrivatePocketState, PublicBalance } from "../../../../core/messages";

/** the issuer out of a canonical `CODE:ISSUER` id; undefined for native XLM. */
function issuerOf(id: string): string | undefined {
  const i = id.indexOf(":");
  return i === -1 ? undefined : id.slice(i + 1);
}

export function Home() {
  const w = useWallet();
  const t = w.t;
  const status = w.status;
  const priv = w.priv;
  const privAssets = w.privAssets;
  const native = nativeOf(w.balances);
  // a freshly onboarded account exists only on this device: `balances()` reports
  // its native line with an amount but NO `total` (there is no on-ledger reserve
  // to report yet), which a funded account always carries. on testnet that is the
  // cue to offer friendbot funding; mainnet has no faucet, so the prompt is absent.
  const needsFunding =
    status?.network === "testnet" && native != null && native.total === undefined;
  const isPrivate = w.pocket === "private";
  // the header mascot reacts to wallet activity (a confirmed submit, a copy, an
  // in-flight proof, the hide-amounts toggle, ...). derived once, here.
  const avatar = useAvatarReaction();
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
  //
  // a signature of the public balances is passed as the revalidate key: now that
  // Home stays mounted across tab switches, the chart is not rebuilt on return
  // (no skeleton), but a send or swap that actually changes a balance refetches it
  // in place so it never goes stale. a tab switch does not change the signature.
  const balanceSig = (w.balances ?? []).map((b) => `${b.code}:${b.total ?? b.amount}`).join(",");
  const {
    chart,
    loading: chartLoading,
    range,
    setRange,
  } = useValueChart(
    status?.address ?? "none",
    (r) => call({ type: "valueSeries", range: r }),
    balanceSig,
  );
  const [scrubAt, setScrubAt] = useState<number | null>(null);
  // whether the backup check was ever completed. read once on mount; the flag
  // lives in local storage so it survives the browser closing, which is the
  // whole point of it.
  const [phraseUnconfirmed, setPhraseUnconfirmed] = useState(false);
  useEffect(() => {
    let live = true;
    void phraseNeverConfirmed().then((yes) => {
      if (live) setPhraseUnconfirmed(yes);
    });
    return () => {
      live = false;
    };
  }, []);
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

  // a market price per held asset, for the dollar value shown under each row. one
  // fetch per distinct asset code (there are one or two), each falling back to null
  // so a missing price leaves the row in its own unit rather than a fabricated $0.
  const [prices, setPrices] = useState<Record<string, number | null>>({});
  // the private assets are priced too, so the private hero can total their value
  // and each private row can show its own dollar figure, exactly like public.
  const privateSymbols = (status?.privateAssets ?? []).map((a) => a.symbol);
  // keyed by code AND issuer, because the code alone is not identity and the
  // price table is a code table: `balances()` now lists every trustline the
  // account really holds, so an asset a user added called "USDC" would otherwise
  // be priced at exactly $1 per unit and summed into the pocket total.
  const priceable = [
    ...(w.balances ?? []).map((b) => ({ code: b.code, issuer: issuerOf(b.id) })),
    ...privateSymbols.map((symbol) => ({ code: symbol, issuer: undefined })),
  ];
  const codeKey = priceable.map((a) => `${a.code}:${a.issuer ?? ""}`).join(",");
  useEffect(() => {
    const seen = new Map<string, { code: string; issuer?: string }>();
    for (const a of priceable) seen.set(`${a.code}:${a.issuer ?? ""}`, a);
    if (seen.size === 0) return;
    let live = true;
    Promise.all(
      [...seen.values()].map((a) =>
        call({ type: "assetMarket", symbol: a.code, ...(a.issuer ? { issuer: a.issuer } : {}) })
          .then((m) => [a.code, m.price] as const)
          .catch(() => [a.code, null] as const),
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
  // the midpoint it springs back rather than committing: so it resists a single
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

  // a fallback for non-wheel scrolls (keyboard, scrollbar, touch panning): commit
  // the collapse, and let it back OUT again at the top.
  //
  // it only ever collapsed. both directions live inside the wheel listener, and a
  // trackpad two-finger pan or a touch drag produces no wheel event, so a header
  // collapsed that way could not be expanded again by any gesture: scrolling back
  // to the very top left the balance hidden with nothing to press.
  const onScroll = (e: UIEvent<HTMLDivElement>) => {
    const top = e.currentTarget.scrollTop;
    if (progressRef.current < 1 && top > 8) {
      setSnapping(true);
      setP(1);
    } else if (progressRef.current > 0 && top <= 0) {
      setSnapping(true);
      setP(0);
    }
  };

  // the same figure the headline carries, shown small in the pinned tab row once
  // the headline itself has scrolled away. the latest value, never the scrubbed
  // one: the chart the scrub reads from is not on screen when this figure is.
  // the present PUBLIC-pocket value, summed from the SAME per-asset prices the rows
  // below use, so the headline can never disagree with the sum of those rows. the
  // value chart uses a separate historical price series and drifted from the rows by
  // cents (holding only XLM, the hero and the XLM row differed by ~$1). null until
  // every held asset is priced, exactly as the rows abandon a total they cannot fully
  // value. the chart stays the trend line; this is the number.
  const publicUsd = publicTotalUsd(w.balances, prices, vaultUnderlying());
  // the collapsed header echoes the HERO, so it falls back the same way the hero
  // does: to the ledger's own XLM figure, never to the chart's latest point. the
  // two disagreeing is the whole reason the hero was rebuilt off per-asset prices
  // in the first place, and `publicLatest` reintroduced the disagreement in
  // exactly the case where the prices are missing.
  const privTotal = privateTotalUsd();
  const headerAmount = isPrivate ? (
    multiPrivate ? (
      privTotal !== null ? (
        <span style={{ ...text.rowTitle, color: t.text }}>
          {w.hidden ? `$${MASK}.${MASK}` : usd(privTotal)}
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
  ) : publicUsd !== null ? (
    <span style={{ ...text.rowTitle, color: t.text }}>
      {w.hidden ? `$${MASK}.${MASK}` : usd(publicUsd)}
    </span>
  ) : native ? (
    <Amount t={t} value={native.amount} code="XLM" size="row" hidden={w.hidden} />
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

        {/* a status read that FAILED, on a wallet that is already loaded.
            `bootError` was rendered in exactly one place, `App`'s `if
            (!w.status)` branch, so it could only ever be seen before the first
            status arrived. Every later failure set the field and showed
            nothing: `refresh` returns early on it, so the balances and the
            private pocket are not read either, and the screen simply stops
            updating with no sign that it has. Both pockets, because the read
            that failed serves both. */}
        {w.bootError && (
          <div style={{ marginTop: space.gutter }}>
            <Notice t={t} tone="danger">
              {w.bootError}
            </Notice>
          </div>
        )}

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
          No balance reported.
        </Notice>
      );
    }
    // a fresh account that is not on the ledger yet (no reserve reported) has no
    // value and no history to chart. show a plain zero and nothing else, not a
    // shimmering chart skeleton for data that will never arrive. the funding card
    // below is the real next step.
    if (native && native.total === undefined) {
      return <HeroAmount t={t} value={usd(0)} code="" hidden={w.hidden} />;
    }
    // while the chart is scrubbed the headline shows the value at the touched
    // moment. on release it returns to the present: a chart nobody is touching
    // must not leave a past number standing where the balance belongs.
    const scrubbed = scrubAt === null ? null : (chart?.points[scrubAt]?.value ?? null);
    // NOT `publicShown`. that falls back to the chart's own latest point when the
    // reconciled total cannot be computed, and the chart is built from a separate
    // mainnet price series: with that host unreachable an XLM-only account
    // shimmered forever, and an XLM+USDC account (the shipped testnet pair) read
    // the USDC holding ALONE as the pocket's value, because an empty XLM series is
    // dropped and USDC's is synthesised at exactly 1. the rule three lines up is
    // "null until every held asset is priced", and the fallback undid it.
    //
    // so when the dollar total is unavailable, fall back to the LEDGER's own
    // figure in its own unit, which is what `multiAssetHero` does in the same
    // situation, rather than to a dollar figure that is missing an asset.
    const shown = scrubbed ?? publicUsd;
    const fallback = ledgerFallback(shown, native?.amount ?? null);
    if (fallback) {
      return <HeroAmount t={t} value={fallback.value} code={fallback.code} hidden={w.hidden} />;
    }

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
          <ChangeChip
            t={t}
            pct={scrubAt === null ? (chart?.changePct ?? null) : null}
            // the POCKET's value, not the market's. it counts money arriving
            // and leaving, so it can be up on a day the market fell.
            label="Value"
            describedAs={`Value change over ${range}, including money moved in and out`}
          />
        </div>

        {/* the number on screen is the last one the ledger gave us, and the most
            recent attempt to refresh it did not answer.

            this is the ONLY place that says so, and until it existed the fact
            was unsayable: `balanceError` was read once, in the branch above,
            behind `!native`. a figure can only be stale when a previous one is
            still on screen, which is exactly when `native` is truthy and that
            branch is skipped. so the warning was gated on there being no
            balance to be stale, and fired only in the case it was not written
            for. the provider states the intent it could not keep, four lines
            above where it sets this: "the previous balance stays on screen
            rather than being replaced by a zero. the error says the number is
            stale; a zero would be a lie."

            `exposed`, not `danger`. the figure is probably correct, it is
            merely unconfirmed, and a red banner over a balance that is fine
            reads as "your money is wrong". */}
        {/* `bootError` counts too. when the STATUS call is what failed, `refresh`
            sets `bootError`, returns null, and its `if (next)` guard skips the
            balance, private and yield loads, so `balanceError` is never set
            either. the only reader of `bootError` sits inside `if (!w.status)`,
            which is false on a screen that is already drawn, so pressing Refresh
            on Home after the extension was reloaded ran the spinner and changed
            nothing on the page at all. */}
        {(w.balanceError || w.bootError) && native && (
          <div style={{ marginTop: space.xs }}>
            <Notice t={t} tone="exposed" bare>
              Could not refresh. This may be out of date.
            </Notice>
          </div>
        )}

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

  // the private spendable, valued in dollars across every asset. null unless the
  // whole thing can be valued, so the caller falls back to a unit figure rather
  // than showing a partial sum as a total.
  //
  // this used to return the sum as soon as ANY asset could be priced, skipping
  // the rest. with XLM priced and USDC not, the wallet drew the XLM value alone
  // under a heading that says it is everything, and the missing part is
  // invisible: there is no shape a partial total has that a complete one does
  // not. a pocket that cannot be fully valued has no dollar total, which is a
  // fact the unit figure states honestly.
  //
  // a state that is not "ready" invalidates it too, unless it is one of the two
  // that mean the pocket provably holds nothing. "diverged" and "needsRecovery"
  // hold an amount this device cannot read, and leaving them out of the sum
  // says they are worth zero.
  function privateTotalUsd(): number | null {
    if (!privAssets) return null;
    const HOLDS_NOTHING: PrivatePocketState[] = ["unavailable", "unfunded", "unregistered"];
    let total = 0;
    let any = false;
    for (const p of privAssets) {
      if (HOLDS_NOTHING.includes(p.state)) continue;
      if (p.state !== "ready" || !p.spendable) return null;
      const price = prices[p.symbol ?? ""] ?? null;
      if (price == null) return null;
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
          {/* THE SAME sentence the multi-asset hero uses for the same state.
              This one said "Not reported. Close and reopen the wallet to read
              it again.", which is a different answer to the same question, on a
              path no shipped build reaches: testnet configures two confidential
              assets so `multiPrivate` is always true, and mainnet configures
              none so the tab is hidden. Two answers that cannot both be seen
              cannot be compared either, which is exactly how they drifted. */}
          <span style={{ ...text.heading, color: t.sub }}>
            {priv.state !== "ready" ? HERO_STATE[priv.state] : "Nothing spendable yet"}
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
    // nothing priceable: show the LARGEST spendable holding in its own unit
    // rather than a $0.00 that would read as empty, or a muted line if nothing
    // is spendable yet (the list below says what each asset needs).
    //
    // `find` returned the FIRST one, which is configuration order, so the
    // comment described a choice the code did not make: with 0.5 XLM and 900
    // USDC the hero read "0.5 XLM". Amounts across assets are not comparable in
    // general, which is exactly why this branch only runs when NOTHING can be
    // priced; between two unpriceable figures the larger number is the more
    // informative one, and it is what the sentence has always promised.
    const spendableAssets = privAssets.filter(
      (p) => p.state === "ready" && p.spendable && /[1-9]/.test(p.spendable),
    );
    const held = spendableAssets.reduce<(typeof spendableAssets)[number] | undefined>(
      (best, p) => (best && parseAmount(best.spendable!) >= parseAmount(p.spendable!) ? best : p),
      undefined,
    );
    if (held) {
      return (
        <HeroAmount t={t} value={held.spendable!} code={held.symbol ?? ""} hidden={w.hidden} />
      );
    }
    // nothing spendable, and WHY is not one answer. D17 records the decision:
    // "Not open yet" is true for `unavailable`, `unfunded` and `unregistered` and
    // false for `archived`, `needsRecovery` and `diverged`, where the pocket
    // exists, holds money, and this device merely cannot read it right now. that
    // fix was applied to `singleAssetHero`, which no shipped build reaches:
    // testnet configures two confidential assets, so `multiPrivate` is always
    // true, and mainnet configures none, so the tab is hidden. so the decision
    // stopped executing anywhere while still being recorded as made.
    //
    // with several assets the states can disagree, and the WORST one is named:
    // saying "nothing spendable" while one asset needs rebuilding is the reading
    // D17 exists to prevent, and it is the frightening one.
    const worst = privAssets
      .map((p) => p.state)
      .sort((a, b) => HERO_STATE_RANK.indexOf(b) - HERO_STATE_RANK.indexOf(a))[0];
    const label = worst && worst !== "ready" ? HERO_STATE[worst] : "Nothing spendable yet";
    return (
      <div
        style={{
          minHeight: Math.round(fontSizes.hero * 1.25),
          display: "flex",
          alignItems: "center",
        }}
      >
        <span style={{ ...text.heading, color: t.sub }}>{label}</span>
      </div>
    );
  }

  function publicBody() {
    return (
      <>
        {/* the backup check was never completed, and the browser has been closed
            since, so there is no tab to send anyone back to.

            The vault is installed before the words are ever drawn, so quitting
            at the phrase step leaves a complete, working wallet whose recovery
            phrase was never confirmed and, on the evidence available to the
            wallet, never written down. Reopening showed Home with an address
            and a balance, no notice, and no confirm step ever again: the one
            gate that asserts the phrase was recorded, skipped permanently by an
            action as ordinary as closing a laptop.

            NOT a blocking screen. There is nothing to return to and the wallet
            works; what is owed is the fact and the door, once. It goes away
            when the words have actually been seen again. */}
        {phraseUnconfirmed && (
          <div style={{ marginTop: space.gutter }}>
            <Notice t={t} tone="exposed">
              You never confirmed your recovery phrase. It is the only way back in.
            </Notice>
            <div style={{ marginTop: space.sm }}>
              <Button
                t={t}
                onClick={() => {
                  w.closeAllSheets();
                  w.setTab("settings");
                  void clearPhraseNeverConfirmed().then(() => setPhraseUnconfirmed(false));
                }}
              >
                Show my recovery phrase
              </Button>
            </div>
          </div>
        )}

        {/* a fresh, unfunded account gets nothing else moving until it exists on the
            ledger, so this sits above everything. it removes itself once the funds
            land: `needsFunding` reads false the moment the account has a reserve. */}
        {needsFunding && (
          <div style={{ marginTop: space.gutter }}>
            <FundTestnetCard t={t} />
          </div>
        )}

        {/* the private pocket is set up PER ASSET: `priv` is the selected asset, so a
            not-ready `priv` (USDC) would wrongly read as "the whole pocket is not set
            up" while another asset (XLM) is already live. only prompt to set up the
            pocket when NOTHING is ready yet; once any asset is live, adding another is
            a per-asset step in the private pocket, not a "set up your pocket" banner. */}
        {/* not while the funding card is up: an unfunded account showed BOTH this
            ("Fund first", no action) and the actionable funding card
            above, saying the same thing twice. once funded, `priv` becomes
            unregistered and this returns as the real "Set up" prompt. */}
        {status?.privateAvailable &&
          priv &&
          priv.state !== "ready" &&
          priv.state !== "unavailable" &&
          !privAssets?.some((p) => p.state === "ready") &&
          !needsFunding && <div style={{ marginTop: space.gutter }}>{privatePrompt(priv)}</div>}

        <div style={{ marginTop: space.xl }}>
          <Overline t={t}>Assets</Overline>
          {/* a failed read leaves `balances` null forever, so an unguarded skeleton
              shimmers for good: a wait that has already ended, drawn as one that
              has not. the error itself is already stated at the hero. */}
          {w.balances === null && (w.balanceError || w.bootError) ? (
            <div style={{ ...text.body, color: t.faint, paddingTop: space.sm }}>
              Could not load assets.
            </div>
          ) : w.balances === null ? (
            // the placeholders match the real Row PITCH: a row is 60px and the
            // grid gap is `space.sm`, and the comment here claimed 52 and a
            // matching count while three of them plus a `space.md` gap measured
            // 190px against a freshly funded XLM-only account's 60. two, because
            // a shipped testnet configures XLM and USDC.
            <div style={{ display: "grid", gap: space.sm, paddingTop: space.xs }}>
              <Skeleton width="100%" height={60} />
              <Skeleton width="100%" height={60} />
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
                  b.issuer ? (
                    // an issuer is verbatim address data, read one glyph at a time, so
                    // it belongs in the mono face like every other address in the wallet.
                    <span style={{ fontFamily: fonts.mono }}>{shortAddress(b.issuer)}</span>
                  ) : undefined
                }
                // the code stays OUT of the drawn figure (the row names the asset on its
                // left) and IN the accessible one, so a screen reader hears a unit and
                // the figure is still findable as money.
                value={<Amount t={t} value={b.amount} code={b.code} hideCode size="row" />}
                valueSub={
                  !b.authorized
                    ? "Not authorised"
                    : w.hidden
                      ? MASK
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
    // `unavailable` draws no card: it has no action by design, and
    // `privateAvailable` already hides the tab it would sit on.
    if (priv.state === "unavailable") return null;
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
              action={{ label: "Make spendable", onClick: () => w.openMove(priv) }}
            />
          </div>
        )}

        {/* a READY pocket can still have something to say: under protocol 27 an
            archived entry is auto-restored to answer a read, so it is both
            spendable and dormant, and the worker reports the second half here.
            `privatePrompt` renders `message` only for the not-ready states. */}
        {priv.message && (
          <div style={{ marginTop: space.gutter }}>
            <Notice t={t} tone="exposed">
              {priv.message}
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
        {/* a partial read is reported OVER the list, not instead of it. the hero's
            branch above only draws `privError` when there is no list at all, so
            the one case this sentence was written for, a list that loaded but is
            short, said nothing anywhere: an asset the user holds simply vanished
            and the total above it was short by its whole value. */}
        {w.privError && privAssets && (
          <div style={{ paddingTop: space.xs }}>
            <Notice t={t} tone="danger">
              {w.privError}
            </Notice>
          </div>
        )}
        {/* a read that FAILED leaves `privAssets` null forever, and nothing
            retries it: a wait that has already ended, drawn as one that has
            not. the same guard the public list above carries, for the same
            reason. `privError` is already stated over the list; what this
            branch removes is the shimmer that says it is still coming. */}
        {!privAssets && w.privError ? (
          <div style={{ ...text.body, color: t.faint, paddingTop: space.sm }}>
            Could not load assets.
          </div>
        ) : !privAssets ? (
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
    const open = () => w.openMove(priv);
    // "Rebuild" is only a real offer where an archive exists to replay from,
    // and this is the screen a user lands on. D-009 gated the settings row and
    // the move sheet on `canRebuild` and left this map untouched, so the very
    // first thing a diverged wallet showed was a button whose only outcome is
    // the worker refusing, in a sentence that says it cannot be done.
    const label = PROMPT_ACTION[priv.state];
    const action =
      NEEDS_ARCHIVE.includes(priv.state) && !canRebuild(w.status?.network ?? "testnet")
        ? null
        : label;
    return (
      // tighter vertical padding than the default card: this is a single-row nudge,
      // so it should sit at about the height of an asset row below rather than a tall
      // block that reads as inconsistent with them.
      <Card
        t={t}
        tone="accent"
        style={{ padding: `${space.sm}px ${space.md}px`, background: t.promptBg }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: space.sm,
            // ONE ROW: no wrap. the title shrinks (and ellipsises only at the very
            // narrowest zoom) so the action pill stays on the same line beside it,
            // rather than being pushed onto a second line under the title.
            flexWrap: "nowrap",
            // no marginBottom: the message it once spaced for now lives in the InfoTip,
            // so a bottom margin here just left dead space that made the card tall and
            // pushed the row up off centre.
          }}
        >
          <IconDisc t={t} size={32}>
            <Shield size={18} />
          </IconDisc>
          <span
            style={{
              flex: "1 1 auto",
              minWidth: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
              overflow: "hidden",
            }}
          >
            <span
              style={{
                // smaller and lighter than a row title: a prompt card is a nudge, not a
                // heading, and 16/600 was too big for it (and truncated more of the title).
                ...text.rowTitle,
                fontSize: 14,
                fontWeight: 500,
                color: t.text,
                minWidth: 0,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {privateStateTitle(priv.state)}
            </span>
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
            // the solid-accent pill, the same as the send screen's "Use max".
            <Button t={t} size="pill" onClick={open}>
              {action}
            </Button>
          )}
        </div>
      </Card>
    );
  }

  /**
   * What is sitting in the yield vault, in its underlying asset. Null when
   * there is no position, or none the vault has valued.
   *
   * The vault reports SHARES (`balance`) and, when it can, what they are worth
   * in the underlying (`underlyingBalance`). Only the second is money in a unit
   * anything else on this screen can price, so a position the vault has not
   * valued is reported as no position here rather than guessed at.
   */
  function vaultUnderlying(): { code: string; amount: number } | null {
    const y = w.yieldPosition;
    if (!y?.available || !y.underlyingBalance || !y.underlying) return null;
    const amount = Number(y.underlyingBalance);
    if (!Number.isFinite(amount) || amount === 0) return null;
    return { code: y.underlying, amount };
  }

  function yieldRow() {
    const y = w.yieldPosition;
    const held = vaultUnderlying();
    const vaultValue =
      held === null || prices[held.code] == null ? null : held.amount * prices[held.code]!;
    // A read that FAILED is not a build without a vault. Returning null for
    // both removed the whole section, so "the service is down" and "this
    // feature does not exist" looked identical, and the second one is not
    // something a refresh can fix.
    if (!y) {
      if (!w.yieldError) return null;
      return (
        <div style={{ marginTop: space.xl }}>
          <Overline t={t}>Yield</Overline>
          <div style={{ marginTop: space.sm }}>
            <Notice t={t} tone="exposed" bare>
              {w.yieldError}
            </Notice>
          </div>
        </div>
      );
    }
    // a withdraw only makes sense against an existing position; a fresh vault
    // shows only Deposit until there is something to take back out.
    const hasPosition = Boolean(y.balance && /[1-9]/.test(y.balance));
    // deposit and withdraw live on the FAB's Yield action now, so this section is
    // a quiet summary rather than a control surface: the rate figure and the
    // Deposit/Withdraw buttons were removed to declutter it. with no controls and
    // nothing deposited, an available-but-empty vault has nothing to show, so the
    // section stays hidden until there is a position (a refresh error still shows).
    if (y.available && !hasPosition && !w.yieldError) return null;
    return (
      <div style={{ marginTop: space.xl }}>
        {/* a refresh that failed WITH a position already on screen is the case
            `yieldError` was written for, and it was the one case it could not
            reach: both readers sat inside `if (!y)`. the provider's own comment
            says it keeps the position rather than nulling it, "so replacing it
            with null deletes the section rather than reporting that the refresh
            failed" -- and then nothing reported that the refresh failed, so the
            figure below simply went stale in silence. */}
        {w.yieldError && (
          <div style={{ marginBottom: space.sm }}>
            <Notice t={t} tone="exposed" bare>
              {w.yieldError}
            </Notice>
          </div>
        )}
        {/* the measurement-window rate rides on the header, the same figure the
            Yield screen reports, so the section says what it earns at a glance
            without reopening the flow. drawn only when a rate is actually
            reported (apyChip is empty otherwise). */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: space.sm,
          }}
        >
          <Overline t={t}>Yield</Overline>
          {y.apy?.figure && (
            <span
              style={{
                ...text.caption,
                fontWeight: 600,
                color: t.positive,
                whiteSpace: "nowrap",
                background: t.field,
                padding: "3px 10px",
                borderRadius: radius.pill,
                flex: "0 0 auto",
              }}
            >
              {apyChip(y.apy)}
            </span>
          )}
        </div>
        {/* no position, no row: an empty vault has nothing to report, and a row
            saying so is the section header spelled out. */}
        {y.available ? (
          hasPosition && (
            <div style={{ display: "flex", alignItems: "center", gap: space.sm, minHeight: 44 }}>
              <span
                style={{
                  ...text.rowTitle,
                  color: t.text,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                Vault position
              </span>
              {/* the SAME figure the Yield screen shows, in the same unit and at
                  the same precision. this printed the raw share count uncapped
                  while Yield preferred `underlyingBalance` with the asset code,
                  so one deposit read "0.0019987 shares" here and "3.3331 XLM"
                  one tap away. */}
              <span
                style={{
                  ...text.rowTitle,
                  color: t.text,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "flex-end",
                }}
              >
                <Figure
                  value={
                    y.underlyingBalance
                      ? `${displayAmount(y.underlyingBalance)} ${y.underlying ?? ""}`.trim()
                      : `${displayAmount(y.balance!)} shares`
                  }
                />
                {/* the same holding in dollars, because the headline above now
                    counts it and a figure that is inside a total has to be
                    readable in the total's own unit. every other holding on
                    this screen carries one. */}
                {vaultValue !== null && (
                  <span style={{ ...text.rowSub, color: t.sub }}>
                    {w.hidden ? MASK : usd(vaultValue)}
                  </span>
                )}
              </span>
            </div>
          )
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
          <Avatar t={t} size={44} reaction={avatar.reaction} nonce={avatar.nonce} />
        ) : (
          // a 44px CIRCLE, so its placeholder is one: at the default radius it was
          // a rounded square that visibly changed shape when the mark landed.
          <Skeleton width={44} height={44} radius={22} />
        )}
        <div style={{ minWidth: 0, flex: "1 1 90px" }}>
          {/* the wordmark is set in the app's own face (figtree) at its heaviest
              weight, not a packaged image: it stays crisp, takes the theme ink, and
              needs no asset. lowercase to match the brand. */}
          <h1
            style={{
              margin: 0,
              fontFamily: fonts.display,
              fontSize: 23,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              lineHeight: 1,
              color: t.text,
            }}
          >
            pocket
            {/* which ledger this whole screen is about. every shipped build is
                testnet (`controller.ts` throws for mainnet), and no screen that
                stated a dollar figure said so: the hero, the asset rows and the
                Receive address were all identical to a real-money wallet. read
                from `status.network`, so the badge disappears by itself the day
                mainnet ships rather than needing to be remembered. */}
            {status && status.network !== "mainnet" && (
              <span
                style={{
                  marginLeft: space.sm,
                  padding: "2px 8px",
                  borderRadius: radius.pill,
                  background: t.exposedSoft,
                  color: t.exposed,
                  ...text.caption,
                  fontWeight: 600,
                  letterSpacing: 0,
                  verticalAlign: "middle",
                }}
              >
                Testnet
              </span>
            )}
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
                {w.hidden ? `${MASK} ${MASK}` : shortAddress(status.address)}
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
            // the private pocket's menu is the tinted card tone; the light pocket's
            // was pure white and read as a stray sheet, so there it takes the pocket-
            // tinted field, carrying the sky accent the way the private one carries teal.
            background: t.dark ? t.sheet : t.field,
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
 * which non-ready state a mixed list is named by, least to most serious.
 *
 * "your money is here and unreadable" outranks "you have not opened this yet":
 * the first is the one a user needs to act on, and the one whose absence reads
 * as the money having gone.
 */
const HERO_STATE_RANK: PrivatePocket["state"][] = [
  "ready",
  "unavailable",
  "unfunded",
  "unregistered",
  "diverged",
  "archived",
  "needsRecovery",
];

/**
 * what stands in the balance slot when there is no number to put there.
 *
 * two groups, not one. a pocket that was never opened and a pocket whose balance
 * this device cannot currently read are different facts about the user's money,
 * and "Not open yet" is false for the second: the money is there, and saying it
 * was never opened is the most frightening available reading of a state that is
 * usually one press from fixed.
 *
 * this is the ONLY table of state words. the hero, the prompt card, the asset row
 * and the asset sheet all read it, so four surfaces cannot call one state by four
 * names, which is exactly what happened while there were four tables.
 */
export const HERO_STATE: Record<PrivatePocket["state"], string> = {
  unavailable: "Not open yet",
  unfunded: "Not open yet",
  unregistered: "Not open yet",
  archived: "Dormant",
  needsRecovery: "Needs rebuilding",
  diverged: "Out of step",
  ready: "",
};

/**
 * the prompt card's title, one per state.
 *
 * NOT `HERO_STATE`. ux/decisions.md D17 decided this: "Not open yet" is true for
 * `unavailable`, `unfunded` and `unregistered` and FALSE for `archived`,
 * `needsRecovery` and `diverged`, where the pocket exists, holds money, and this
 * device merely cannot read it. Collapsing the six into three phrasings puts the
 * most frightening reading, "the money is gone", in front of the user first.
 */
const PROMPT_TITLE: Record<PrivatePocket["state"], string> = {
  unavailable: "No private pocket on this network",
  unfunded: "Fund this account first",
  unregistered: "Private pocket not set up",
  archived: "Private pocket is dormant",
  needsRecovery: "Balances need rebuilding",
  diverged: "Records do not match the ledger",
  ready: "",
};

export function privateStateTitle(state: PrivatePocket["state"]): string {
  return PROMPT_TITLE[state];
}

/** the asset row's value slot: the VERB, so the row says what to do about it. */
const ROW_STATE_LABEL: Record<PrivatePocket["state"], string> = {
  unavailable: "—",
  unfunded: "Fund first",
  unregistered: "Set up",
  archived: "Dormant",
  needsRecovery: "Rebuild",
  diverged: "Rebuild",
  ready: "",
};

/** the asset row's subtitle: what the state means, not what to press. */
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
 * the rate chip on the Yield header: "14.67% · 7d".
 *
 * the measurement window only reaches the popup inside `apy.sentence` (the worker
 * interpolates it there), and it is what makes the figure honest, so it is lifted
 * back out rather than lost with the sentence.
 */
export function apyChip(apy: { figure: string | null; sentence: string }): string {
  const days = apy.sentence.match(/last (\d+) days?/)?.[1];
  return days ? `${apy.figure} · ${days}d` : (apy.figure ?? "");
}

/** states whose only route out is a rebuild, which needs an archive. */
const NEEDS_ARCHIVE: PrivatePocket["state"][] = ["needsRecovery", "diverged"];

const PROMPT_ACTION: Record<PrivatePocket["state"], string | null> = {
  unavailable: null,
  unfunded: null,
  unregistered: "Set up",
  archived: "Reactivate",
  needsRecovery: "Rebuild",
  diverged: "Rebuild",
  ready: null,
};

/**
 * the logo id for a private asset. native wears its real mark; a wrapped classic
 * asset falls to AssetMark's safe monogram, because its verified issuer is not on
 * the wire and a code-matched logo could be the wrong issuer's mark. shared so the
 * list, the forms, and the detail sheet all draw one asset the same way.
 */
export function privateMarkId(symbol: string, network?: NetworkId): string {
  if (symbol === "XLM") return "native";
  // a CONFIGURED private asset (USDC) is the same verified classic asset the public
  // pocket holds, so resolve its canonical CODE:ISSUER and its real logo shows, like
  // public. an unknown symbol stays the bare code and draws the safe monogram.
  const known = network
    ? (NETWORKS[network].knownAssets ?? []).find((k) => k.code === symbol)
    : undefined;
  return known ? `${known.code}:${known.issuer}` : symbol;
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
  const w = useWallet();
  const network = w.status?.network ?? "testnet";
  const symbol = p.symbol ?? "XLM";
  const ready = p.state === "ready";
  const receiving = ready && p.receiving && /[1-9]/.test(p.receiving) ? p.receiving : null;

  // a READY pocket with no spendable figure has not answered yet; it does not
  // hold nothing. `?? "0"` drew a confident 0.0000000 for it, which is the one
  // thing WalletProvider says must never happen: "a zero would be a lie". the
  // hero on this very screen already refuses to do it, so the row and the hero
  // disagreed about the same pocket.
  const value = !ready ? (
    <span style={{ ...text.value, color: t.exposed }}>
      {NEEDS_ARCHIVE.includes(p.state) && !canRebuild(network)
        ? "Needs rebuilding"
        : ROW_STATE_LABEL[p.state]}
    </span>
  ) : p.spendable ? (
    // the symbol reaches the accessibility tree; `hideCode` keeps it out of the
    // drawn figure, where the row already names the asset on its left.
    <Amount t={t} value={p.spendable} code={symbol} hideCode size="row" hidden={hidden} />
  ) : (
    <Skeleton width={72} height={16} />
  );

  const valueSub = ready
    ? hidden
      ? MASK
      : p.spendable
        ? (usdOf(p.spendable, price) ?? undefined)
        : undefined
    : undefined;

  const sub = receiving ? (
    <span style={{ color: t.accent }}>
      Receiving <Figure value={capDecimals(receiving, 4)} announce="amount hidden" />
    </span>
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
      icon={<AssetMark t={t} id={privateMarkId(symbol, w.status?.network)} code={symbol} />}
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

/**
 * What the public headline shows when no dollar figure can be computed.
 *
 * `publicUsd` is null the moment ANY held asset's price is missing, which is
 * the right rule: a total that silently omits an asset is worse than no total.
 * Rendering that null as a shimmer was not: an unreachable mainnet price host
 * left a funded wallet showing no balance at all on the first screen, with the
 * ledger's own figure sitting in memory unused. The comment above the hero has
 * always promised "the one that can go missing is never the one that carries
 * the balance"; this is that promise.
 *
 * Null when a dollar figure IS available (the caller renders it) and null when
 * there is no ledger figure either, because inventing one would be worse than
 * the shimmer.
 *
 * A named function rather than three lines inline so it can be tested: Home
 * needs the whole provider to render, and this decision does not.
 */
export function ledgerFallback(
  usdValue: number | null,
  nativeAmount: string | null,
): { value: string; code: string } | null {
  if (usdValue !== null) return null;
  if (nativeAmount === null) return null;
  return { value: nativeAmount, code: "XLM" };
}

/**
 * The public pocket's whole value in dollars, or null.
 *
 * Summed from the SAME per-asset prices the rows use, so the headline can never
 * disagree with the sum of what is on screen, and null until everything held
 * can be priced: a partial sum has no shape that distinguishes it from a
 * complete one, so a pocket that cannot be fully valued has no dollar total.
 *
 * `vault` is what is sitting in the yield vault, in its underlying asset. It is
 * public-pocket money that has been deposited, not money that has left, and
 * leaving it out made a deposit read as a loss: the headline dropped by the
 * amount deposited and nothing on the screen accounted for the difference in
 * money terms, because the vault section reports its position in the underlying
 * and never in dollars.
 */
export function publicTotalUsd(
  balances: PublicBalance[] | null,
  prices: Record<string, number | null>,
  vault: { code: string; amount: number } | null,
): number | null {
  if (!balances) return null;
  let total = 0;
  for (const b of balances) {
    const price = prices[b.code];
    if (price == null) return null;
    total += Number(b.amount) * price;
  }
  if (vault !== null) {
    const price = prices[vault.code];
    if (price == null) return null;
    total += vault.amount * price;
  }
  return total;
}
