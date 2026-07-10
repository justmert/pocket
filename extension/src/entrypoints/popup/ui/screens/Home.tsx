import { useState } from "react";
import type { CSSProperties } from "react";
import { nativeOf, useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { ChangeChip, ValueChartBlock, useValueChart } from "../Chart";
import { NAV_SPACE } from "../BottomNav";
import { Amount, HeroAmount } from "../Amount";
import { shortAddress } from "../Address";
import { Avatar } from "../Avatar";
import { Card, IconButton, Notice, Overline, Row, ScrollArea, Skeleton } from "../primitives";
import { Held } from "../Held";
import { Check, Copy, Lock, Refresh, Shield } from "../icons";
import { FRAME, fontSizes, radius, space, text, type Pocket, type Theme } from "../theme";
import type { PrivatePocket } from "../../../../core/messages";

/**
 * a dollar figure, formatted the way money is read rather than the way a float
 * prints.
 *
 * sub-dollar amounts keep more places, because a testnet wallet holding a few
 * XLM rounds to "$0.00" at two, and a balance that reads as nothing when it is
 * not is the same class of lie as a fabricated curve.
 */
function usd(v: number): string {
  const places = Math.abs(v) >= 1 || v === 0 ? 2 : 4;
  return `$${v.toFixed(places)}`;
}

export function Home() {
  const w = useWallet();
  const t = w.t;
  const status = w.status;
  const priv = w.priv;
  const native = nativeOf(w.balances);
  const isPrivate = w.pocket === "private";

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

  return (
    <ScrollArea background={t.canvas}>
      {t.dark && <div aria-hidden style={glow(t)} />}
      <div style={{ position: "relative", padding: `${space.gutter}px ${space.gutter}px ${NAV_SPACE}px` }}>
        {accountRow()}

        <div style={{ display: "flex", gap: space.lg, marginTop: space.lg, flexWrap: "wrap" }}>
          {pocketTab("public", "Public pocket")}
          {status?.privateAvailable && pocketTab("private", "Private pocket")}
        </div>

        <div style={{ marginTop: space.sm }}>
          {isPrivate ? privateHero() : publicHero()}
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
    const latest = chart?.points.length ? chart.points[chart.points.length - 1]!.value : null;
    const shown = scrubbed ?? latest;

    return (
      <>
        <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
          <div style={{ flex: "1 1 auto", minWidth: 0 }}>
            {/* dollars on top, the ledger's own figure underneath. the dollar
                value depends on a market that may be unreadable; the XLM figure
                does not. the one that can go missing is never the one that
                carries the balance. */}
            <HeroAmount t={t} value={shown === null ? null : usd(shown)} code="" />
          </div>
          <ChangeChip t={t} pct={scrubAt === null ? (chart?.changePct ?? null) : null} />
        </div>

        <div style={{ ...text.caption, color: t.faint, minHeight: 16 }}>
          {native ? `${native.amount} XLM` : " "}
        </div>

        <ValueChartBlock
          t={t}
          chart={chart}
          loading={chartLoading}
          range={range}
          onRange={setRange}
          onScrub={setScrubAt}
          width={FRAME.width - space.gutter * 2}
          style={{ marginTop: space.md }}
        />

        <div style={{ ...text.caption, color: t.faint, minHeight: 16, marginTop: space.sm }}>
          {/* not `Number(reserved) > 0`. a balance is an int64 of stroops as a
              decimal string, and putting it through a float to ask "is it more
              than nothing" is the one place a float was still touching the value
              path. asking the string whether it contains a non-zero digit is
              exact, and it cannot be wrong at any magnitude. */}
          {native?.reserved && /[1-9]/.test(native.reserved)
            ? `Plus ${native.reserved} XLM locked by the network as a reserve.`
            : " "}
        </div>
      </>
    );
  }

  function privateHero() {
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
          <HeroAmount t={t} value={null} code="XLM" />
          <div style={{ ...text.caption, color: t.faint, minHeight: 16 }}>
            Looking for payments you have received.
          </div>
        </>
      );
    }
    if (priv.state !== "ready") {
      return (
        <div style={{ minHeight: Math.round(fontSizes.hero * 1.25), display: "flex", alignItems: "center" }}>
          <span style={{ ...text.display, color: t.faint }}>{HERO_STATE[priv.state]}</span>
        </div>
      );
    }
    if (!priv.spendable) {
      return (
        <div style={{ minHeight: Math.round(fontSizes.hero * 1.25), display: "flex", alignItems: "center" }}>
          <span style={{ ...text.body, color: t.sub }}>
            Not reported. Close and reopen the wallet to read it again.
          </span>
        </div>
      );
    }
    return (
      <>
        <HeroAmount t={t} value={priv.spendable} code="XLM" />
        <div style={{ ...text.caption, color: t.faint, minHeight: 16 }}>
          Amounts here are hidden on the ledger. Addresses are not.
        </div>
      </>
    );
  }

  function publicBody() {
    return (
      <>
        {status?.privateAvailable && priv && priv.state !== "ready" && (
          <div style={{ marginTop: space.gutter }}>
            {privatePrompt(priv)}
          </div>
        )}

        <div style={{ marginTop: space.xl }}>
          <Overline t={t}>Assets</Overline>
          {w.balances === null ? (
            <div style={{ display: "grid", gap: space.md, paddingTop: space.xs }}>
              <Skeleton width="100%" height={40} />
            </div>
          ) : (
            w.balances.map((b, i) => (
              <Row
                key={b.id}
                t={t}
                index={i}
                icon={<AssetMark t={t} code={b.code} />}
                title={b.code}
                sub={b.id === "native" ? "Stellar Lumens" : b.issuer ? shortAddress(b.issuer) : undefined}
                value={<Amount t={t} value={b.amount} size="row" />}
                valueSub={!b.authorized ? "Not authorised" : undefined}
              />
            ))
          )}
        </div>

        {yieldRow()}
      </>
    );
  }

  function privateBody() {
    if (!priv) return null;
    if (priv.state !== "ready") {
      return (
        <div style={{ marginTop: space.gutter }}>
          {privatePrompt(priv)}
        </div>
      );
    }
    return (
      <>
        {priv.receiving !== undefined && (
          <div style={{ marginTop: space.gutter }}>
            <Held
              t={t}
              label="Receiving"
              amount={priv.receiving}
              code="XLM"
              holding="Received funds sit here until you make them spendable. One signature, no fee beyond the network's."
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

        <div style={{ marginTop: space.xl }}>
          <Overline t={t}>How this pocket works</Overline>
          <Row
            t={t}
            icon={<Shield size={20} />}
            title="Amounts are hidden"
            sub="Every address stays public on the ledger."
          />
        </div>
      </>
    );
  }

  function privatePrompt(priv: PrivatePocket) {
    const open = () => w.openSheet("move");
    const action = PROMPT_ACTION[priv.state];
    return (
      <Card t={t} tone="accent">
        <div style={{ display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap", marginBottom: priv.message ? space.sm : 0 }}>
          <span
            style={{
              width: 36,
              height: 36,
              borderRadius: "50%",
              background: t.accentFill,
              color: t.onAccent,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flex: "0 0 auto",
            }}
          >
            <Shield size={19} />
          </span>
          <span style={{ ...text.rowTitle, color: t.text, flex: 1, minWidth: 0 }}>
            {PROMPT_TITLE[priv.state]}
          </span>
          {action && (
            <button
              type="button"
              onClick={open}
              style={{
                all: "unset",
                cursor: "pointer",
                ...text.chip,
                color: t.dark ? t.accent : t.text,
                background: t.field,
                padding: `8px ${space.md}px`,
                borderRadius: radius.pill,
              }}
            >
              {action}
            </button>
          )}
        </div>
        {priv.message && (
          <div style={{ ...text.body, color: t.sub, lineHeight: 1.5 }}>{priv.message}</div>
        )}
        {/* measured, not chosen: faint on this card is 3.67:1 in the private
            pocket, and this line is the product's honesty statement rather than
            decoration. */}
        <div style={{ ...text.caption, color: t.sub, marginTop: space.xs }}>
          Hides amounts, never addresses. Who you pay stays public on the ledger.
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
          <Row
            t={t}
            title="Vault position"
            sub={y.apy ? `${y.apy} reported` : undefined}
            value={y.balance ? `${y.balance} shares` : undefined}
          />
        ) : (
          <div style={{ ...text.body, color: t.sub, lineHeight: 1.5 }}>{y.reason}</div>
        )}
      </div>
    );
  }

  function accountRow() {
    return (
      <div style={{ display: "flex", alignItems: "center", gap: space.md, flexWrap: "wrap" }}>
        {status?.address ? <Avatar address={status.address} size={44} /> : <Skeleton width={44} height={44} />}
        <div style={{ minWidth: 0, flex: "1 1 90px" }}>
          <h1 style={{ ...text.heading, color: t.text, margin: 0 }}>Pocket</h1>
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
              <span style={{ ...text.rowSub, fontVariantNumeric: "tabular-nums" }}>
                {shortAddress(status.address)}
              </span>
              {w.copied ? <Check size={14} sw={2.4} /> : <Copy size={13} />}
            </button>
          ) : (
            <Skeleton width={120} height={13} />
          )}
        </div>
        <IconButton t={t} size={40} label="Refresh" onClick={() => void w.refresh()}>
          <Refresh size={18} className={w.refreshing ? "pocket-spinner" : undefined} />
        </IconButton>
        <IconButton t={t} size={40} label="Lock wallet" onClick={() => void w.lock()}>
          <Lock size={18} />
        </IconButton>
      </div>
    );
  }

  function pocketTab(pocket: Pocket, label: string) {
    const on = w.pocket === pocket;
    const style: CSSProperties = {
      all: "unset",
      cursor: "pointer",
      ...text.rowTitle,
      fontWeight: 800,
      letterSpacing: "-0.01em",
      color: on ? t.text : t.faint,
      paddingBottom: 4,
      borderBottom: `2px solid ${on ? t.accent : "transparent"}`,
      transition: "color 200ms ease, border-color 200ms ease",
    };
    return (
      <button type="button" aria-pressed={on} onClick={() => w.setPocket(pocket)} style={style}>
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

/**
 * one letter, not the whole code.
 *
 * the row already says the code and its name. three letters in the mark is the
 * same word twice, and at 500% zoom it is the same word twice overflowing a
 * 40px box.
 */
function AssetMark({ t, code }: { t: Theme; code: string }) {
  return (
    <span
      style={{
        ...text.rowTitle,
        fontWeight: 800,
        color: t.dark ? t.accent : t.text,
        lineHeight: 1,
      }}
    >
      {code.slice(0, 1)}
    </span>
  );
}

function glow(t: Theme): CSSProperties {
  return {
    position: "absolute",
    top: -40,
    left: 0,
    right: 0,
    height: 220,
    background: `radial-gradient(80% 100% at 50% 0%, ${t.accentSoft}, transparent 62%)`,
    pointerEvents: "none",
  };
}
