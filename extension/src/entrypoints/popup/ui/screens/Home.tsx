import { useEffect, useState } from "react";
import { call } from "../rpc";
import { Button, Frame, Header, Notice, Spinner } from "../primitives";
import { AddressBlock } from "../AddressBlock";
import { Money } from "../Money";
import { text, type Theme } from "../theme";
import type { PublicBalance, WalletStatus } from "../../../../core/messages";

export function Home({
  t,
  status,
  onLock,
  onSend,
}: {
  t: Theme;
  status: WalletStatus;
  onLock: () => void;
  onSend: () => void;
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

  return (
    <Frame t={t}>
      <Header
        title="Pocket"
        t={t}
        right={
          <button
            onClick={onLock}
            style={{
              ...text.caption,
              background: "none",
              border: "none",
              color: t.sub,
              cursor: "pointer",
            }}
          >
            Lock
          </button>
        }
      />
      <div style={{ padding: 18, flex: 1 }}>
        <div style={{ ...text.caption, color: t.faint, marginBottom: 6 }}>PUBLIC POCKET</div>

        {/* Never fabricate a zero while loading: an empty state is honest, a
            made-up balance is not. */}
        {balances === null && !error ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, height: 48 }}>
            <Spinner t={t} />
            <span style={{ ...text.body, color: t.sub }}>Reading the ledger…</span>
          </div>
        ) : error ? (
          <Notice tone="danger" t={t}>
            {error}
          </Notice>
        ) : (
          <div style={{ marginBottom: 18 }}>
            <Money amount={native?.amount ?? "0.0000000"} code="XLM" size={34} t={t} />
          </div>
        )}

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginTop: 8 }}>
          <Button t={t} onClick={onSend}>
            Send
          </Button>
          <Button t={t} variant="quiet" onClick={() => setShowReceive((v) => !v)}>
            Receive
          </Button>
        </div>

        {showReceive && status.address && (
          <div style={{ marginTop: 18 }}>
            <div style={{ ...text.label, color: t.sub, marginBottom: 6 }}>Your address</div>
            <AddressBlock address={status.address} t={t} />
          </div>
        )}

        <div style={{ marginTop: 26 }}>
          <div style={{ ...text.caption, color: t.faint, marginBottom: 8 }}>PRIVATE POCKET</div>
          <Notice t={t}>
            Not set up yet. The private pocket hides amounts, never addresses, and needs a one-time
            registration that is permanent and publicly visible.
          </Notice>
        </div>
      </div>
    </Frame>
  );
}
