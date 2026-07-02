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
import { space, text, type Theme, leading, fontSizes } from "../theme";
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
            made-up balance is not.

            ONE box, the same height in every state. The loading placeholder was
            a hard-coded 40px and the balance that replaced it is a 40px hero on
            a 1.3 line box, so arriving data pushed everything below it down 4px
            — including the Send button, under a finger already aimed at it. The
            earlier 29px version of this bug is described below; this is the same
            bug, four pixels wide, left behind when that one was fixed. A
            placeholder whose height is written as a number and a content box
            whose height is computed from type metrics WILL drift apart, so the
            reservation is computed from the same metrics the content uses. */}
        <div
          style={{
            minHeight: fontSizes.display * leading.tight,
            display: "flex",
            alignItems: "center",
            // CONSTANT. Keying it on `reserved` moved everything below by the
            // difference between the two spacings (18 and 6) at the moment the
            // balance arrived: twelve pixels, upward, under a finger aimed at
            // Send. The reserve caption below reserves its own line whether or
            // not it has text, so this margin has no reason to vary.
            marginBottom: space.xs,
          }}
        >
          {balances === null && !error ? (
            <Loading label="Reading the ledger…" t={t} />
          ) : error ? (
            <Notice tone="danger" t={t}>
              {error}
            </Notice>
          ) : native ? (
            <Money amount={native.amount} code="XLM" size="hero" t={t} />
          ) : (
            <Notice tone="danger" t={t}>
              The ledger did not report a balance for this account. Reopen the wallet to try again.
            </Notice>
          )}
        </div>

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
