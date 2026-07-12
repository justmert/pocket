// one private asset, expanded: what you hold of it, what it is waiting on, and the
// three ways value moves through it. the private mirror of AssetDetailSheet, since
// a pocket is a list of assets in both and each asset opens to its own actions.
//
// it reads the live pocket off `priv` rather than a passed snapshot, so a balance
// that refreshes, or a receive that lands, updates the open sheet in place. `priv`
// is whichever asset the row that opened this selected, held in the provider.
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useWallet, type SheetId } from "../WalletProvider";
import { call } from "../rpc";
import { Amount } from "../Amount";
import { Button, IconDisc, Notice, Sheet } from "../primitives";
import { Held } from "../Held";
import { AssetMark, privateMarkId } from "../screens/Home";
import { Send as SendIcon, Shield, Unshield } from "../icons";
import { usdOf } from "../money";
import { radius, space, text, type Theme } from "../theme";
import type { PrivatePocketState } from "../../../../core/messages";

/** the names we can say for a private asset; unknown symbols show a neutral one. */
const NAME: Record<string, string> = { XLM: "Stellar Lumens", USDC: "USD Coin" };

// the not-ready states, as a title and the one action that fixes each. the action
// always opens the setup/rebuild sheet, whose own menu is driven by the state, so
// it lands on register / reactivate / rebuild without being told which.
const STATE_TITLE: Record<PrivatePocketState, string> = {
  unavailable: "Not available",
  unfunded: "Fund this account first",
  unregistered: "Not set up yet",
  archived: "Dormant",
  needsRecovery: "Needs rebuilding",
  diverged: "Out of step with the ledger",
  ready: "",
};
const STATE_ACTION: Record<PrivatePocketState, string | null> = {
  unavailable: null,
  unfunded: null,
  unregistered: "Set up",
  archived: "Reactivate",
  needsRecovery: "Rebuild",
  diverged: "Rebuild",
  ready: null,
};

export function PrivateAssetSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const priv = w.priv;
  const symbol = priv?.symbol ?? "XLM";

  // a price for the dollar line, fetched only while the sheet is open and refetched
  // if the asset changes under it. absent leaves the figure in its own unit.
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    if (!open) return;
    let live = true;
    setPrice(null);
    call({ type: "assetMarket", symbol })
      .then((m) => {
        if (live) setPrice(m.price);
      })
      .catch(() => {
        if (live) setPrice(null);
      });
    return () => {
      live = false;
    };
  }, [open, symbol]);

  const ready = priv?.state === "ready";
  const receiving =
    ready && priv?.receiving && /[1-9]/.test(priv.receiving) ? priv.receiving : null;
  const ttl =
    typeof priv?.daysRemaining === "number" && priv.daysRemaining < 8 ? priv.daysRemaining : null;

  // an action REPLACES this sheet with the form, so the form's close returns to the
  // pocket rather than back into this detail. the asset is already selected, so the
  // form (and the op it builds) runs against it.
  const go = (sheet: SheetId) => () => {
    w.closeSheet();
    w.openSheet(sheet);
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title=" " focusKey={priv?.token ?? symbol}>
      {priv && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <IconDisc t={t} size={44} tone="accentSoft">
              <AssetMark t={t} id={privateMarkId(symbol)} code={symbol} />
            </IconDisc>
            <div style={{ minWidth: 0 }}>
              <div style={{ ...text.heading, color: t.text }}>{symbol}</div>
              <div style={{ ...text.rowSub, color: t.sub, marginTop: 1 }}>
                {NAME[symbol] ?? "Private asset"}
              </div>
            </div>
          </div>

          {ready ? (
            <>
              <div style={{ textAlign: "center", margin: `${space.xl}px 0 ${space.md}px` }}>
                <Amount
                  t={t}
                  value={priv.spendable ?? "0"}
                  code={symbol}
                  size="display"
                  hidden={w.hidden}
                />
                <div style={{ ...text.body, color: t.sub, marginTop: 4 }}>
                  {!w.hidden && priv.spendable
                    ? (usdOf(priv.spendable, price) ?? "Spendable")
                    : "Spendable"}
                </div>
              </div>

              {receiving && (
                <div style={{ marginBottom: space.md }}>
                  <Held
                    t={t}
                    label="Receiving"
                    amount={receiving}
                    code={symbol}
                    holding="Received funds sit here until you make them spendable."
                    action={{ label: "Make spendable", onClick: go("move") }}
                  />
                </div>
              )}

              {ttl !== null && (
                <div style={{ marginBottom: space.md }}>
                  <Notice t={t} tone="exposed">
                    This pocket goes dormant in {ttl} days unless it is used. Opening the wallet
                    before then keeps it alive.
                  </Notice>
                </div>
              )}

              <ActionRow
                t={t}
                onShield={go("moveIn")}
                onUnshield={go("moveOut")}
                onSend={go("send")}
              />
            </>
          ) : (
            <div style={{ marginTop: space.lg }}>
              <div style={{ ...text.heading, color: t.text }}>{STATE_TITLE[priv.state]}</div>
              {priv.message && (
                <div style={{ marginTop: space.sm }}>
                  <Notice t={t} tone="exposed">
                    {priv.message}
                  </Notice>
                </div>
              )}
              <div style={{ ...text.body, color: t.sub, marginTop: space.sm }}>
                Hides amounts, never addresses. Who you pay stays public on the ledger.
              </div>
              {STATE_ACTION[priv.state] && (
                <div style={{ marginTop: space.lg }}>
                  <Button t={t} onClick={go("move")}>
                    {STATE_ACTION[priv.state]}
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

/** the three ways value moves through one private asset, side by side. */
function ActionRow({
  t,
  onShield,
  onUnshield,
  onSend,
}: {
  t: Theme;
  onShield: () => void;
  onUnshield: () => void;
  onSend: () => void;
}) {
  const items: { label: string; icon: ReactNode; onClick: () => void }[] = [
    { label: "Shield", icon: <Shield size={20} />, onClick: onShield },
    { label: "Send", icon: <SendIcon size={20} />, onClick: onSend },
    { label: "Unshield", icon: <Unshield size={20} />, onClick: onUnshield },
  ];
  return (
    <div style={{ display: "flex", gap: space.sm }}>
      {items.map((it) => (
        <button
          key={it.label}
          type="button"
          onClick={it.onClick}
          style={{
            all: "unset",
            boxSizing: "border-box",
            cursor: "pointer",
            flex: 1,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 6,
            padding: `${space.md}px 0`,
            borderRadius: radius.md,
            background: t.field,
          }}
        >
          <span style={{ display: "flex", color: t.accent }}>{it.icon}</span>
          <span style={{ ...text.chip, color: t.text }}>{it.label}</span>
        </button>
      ))}
    </div>
  );
}
