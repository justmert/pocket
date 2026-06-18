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
import { space, text, type Theme } from "../theme";
import type { PublicBalance, WalletStatus } from "../../../../core/messages";

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

        {reserved && (
          <div style={{ ...text.caption, color: t.faint, marginBottom: space.gutter }}>
            Plus {reserved} XLM locked by the network as a reserve.
          </div>
        )}

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
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
