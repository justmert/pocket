import { useEffect, useState } from "react";
import { call } from "../rpc";
import {
  Button,
  Content,
  Frame,
  Header,
  Label,
  Loading,
  Notice,
  SectionLabel,
  TextButton,
} from "../primitives";
import { AddressBlock } from "../AddressBlock";
import { Money } from "../Money";
import { space, text, type Theme, leading } from "../theme";
import type { PublicBalance, WalletStatus, YieldPosition } from "../../../../core/messages";

export function Home({
  t,
  status,
  onLock,
  onSend,
  onPrivate,
}: {
  t: Theme;
  status: WalletStatus;
  onLock: () => void;
  onSend: () => void;
  onPrivate: () => void;
}) {
  const [balances, setBalances] = useState<PublicBalance[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showReceive, setShowReceive] = useState(false);
  const [yield_, setYield] = useState<YieldPosition | null>(null);

  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const b = await call({ type: "balances" });
        if (live) setBalances(b);
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  // Yield is a PUBLIC-pocket fact. Read separately so a yield outage cannot
  // take the balance down with it.
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const y = await call({ type: "yieldPosition" });
        if (live) setYield(y);
      } catch {
        // Reported as unavailable rather than as a broken wallet.
        if (live) setYield({ available: false, reason: "Yield could not be read right now." });
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const native = balances?.find((b) => b.id === "native");
  // The reserve is real money the account holds and cannot send. Showing only
  // the spendable figure made a freshly funded 10,000 XLM account read 9999
  // with nothing on screen to explain the missing one.
  const reserved = native?.reserved && Number(native.reserved) > 0 ? native.reserved : null;

  return (
    <Frame t={t}>
      <Header
        title="Pocket"
        t={t}
        right={
          <TextButton t={t} onClick={onLock}>
            Lock
          </TextButton>
        }
      />
      <Content>
        <SectionLabel t={t}>PUBLIC POCKET</SectionLabel>

        {/* Never fabricate a zero while loading: an empty state is honest, a
            made-up balance is not. */}
        {balances === null && !error ? (
          <div style={{ height: 40, display: "flex", alignItems: "center" }}>
            <Loading label="Reading the ledger…" t={t} />
          </div>
        ) : error ? (
          <Notice tone="danger" t={t}>
            {error}
          </Notice>
        ) : native ? (
          <div style={{ marginBottom: reserved ? space.xs : space.gutter }}>
            <Money amount={native.amount} code="XLM" size="hero" t={t} />
          </div>
        ) : (
          <Notice tone="danger" t={t}>
            The ledger did not report a balance for this account. Reopen the wallet to try again.
          </Notice>
        )}

        {/* The row is ALWAYS here, empty until the reserve is known.
            Rendering it only once the balance arrived dropped the Send and
            Receive buttons 29px, under a finger already aimed at Send: a press
            at the old centre lands 6px above the new button, does nothing, and
            the natural response on a wallet is to press again. Cumulative
            Layout Shift scored this 0.0021, well inside "good", which is why
            the assertion is the pixel delta and not CLS. */}
        <div
          style={{
            ...text.caption,
            color: t.faint,
            marginBottom: space.gutter,
            minHeight: text.caption.fontSize * leading.normal,
          }}
        >
          {reserved ? `Plus ${reserved} XLM locked by the network as a reserve.` : "\u00a0"}
        </div>

        <div
          style={{
            display: "grid",
            // `1fr` means `minmax(auto, 1fr)`, and `auto` here is the item's
        // min-content width, so the track refuses to shrink below its label.
        // At 200% zoom the pair needs 176px in a 156px track and `Frame` is
        // `overflow: hidden`, so the control CLIPS rather than scrolls: it is
        // gone, not merely awkward. Spelling the minimum as 0 is what lets it
        // shrink. WCAG 1.4.4.
        gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
            gap: space.md,
            marginTop: space.sm,
          }}
        >
          <Button t={t} onClick={onSend}>
            Send
          </Button>
          <Button t={t} variant="quiet" onClick={() => setShowReceive((v) => !v)}>
            Receive
          </Button>
        </div>

        {showReceive && status.address && (
          <div style={{ marginTop: space.gutter }}>
            <Label t={t}>Your address</Label>
            <AddressBlock address={status.address} t={t} />
          </div>
        )}

        {yield_ && (
          <div style={{ marginTop: 26 }}>
            <div style={{ ...text.caption, color: t.faint, marginBottom: 8 }}>YIELD</div>
            {yield_.available ? (
              <>
                <div style={{ ...text.body, color: t.text }}>
                  {yield_.balance} shares at {yield_.apy}
                </div>
                <Notice t={t}>
                  Yield is public-pocket only. A confidential balance is a commitment, which can
                  be added and subtracted and nothing else, so a vault cannot compute a share
                  price over one.
                </Notice>
              </>
            ) : (
              <Notice t={t}>{yield_.reason}</Notice>
            )}
          </div>
        )}

        {status.privateAvailable && (
          <div style={{ marginTop: space.xl }}>
            <SectionLabel t={t}>PRIVATE POCKET</SectionLabel>
            {/* The honest framing, on the surface rather than buried in a
                settings page: amounts are hidden, addresses never are. */}
            <Notice t={t}>
              Hides amounts, never addresses. Who you pay stays public on the ledger.
            </Notice>
            <Button t={t} variant="quiet" onClick={onPrivate}>
              {status.privateEnabled ? "Open private pocket" : "Set up private pocket"}
            </Button>
          </div>
        )}
      </Content>
    </Frame>
  );
}
