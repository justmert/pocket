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
import { canRebuild } from "../copy";
import { Amount } from "../Amount";
import { Button, IconDisc, Notice, Sheet, Skeleton } from "../primitives";
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
/** states whose only route out is a rebuild, which needs an archive. */
const NEEDS_ARCHIVE: PrivatePocketState[] = ["needsRecovery", "diverged"];

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
  const priv = w.privateDetail;
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

  // A rebuild is only offerable where there is an archive to replay from. See
  // the comment at the button.
  const label = priv ? STATE_ACTION[priv.state] : null;
  const action =
    priv && NEEDS_ARCHIVE.includes(priv.state) && !canRebuild(w.status?.network ?? "testnet")
      ? null
      : label;

  // an action REPLACES this sheet with the form, so the form's close returns to the
  // pocket rather than back into this detail. the asset is already selected, so the
  // form (and the op it builds) runs against it.
  const go = (sheet: SheetId) => () => {
    w.closeSheet();
    w.openSheet(sheet);
  };

  return (
    <Sheet
      t={t}
      open={open}
      onClose={onClose}
      title=" "
      ariaLabel="Private asset detail"
      focusKey={priv?.token ?? symbol}
    >
      {priv && (
        <div>
          <div style={{ display: "flex", alignItems: "center", gap: space.md }}>
            <IconDisc t={t} size={44} tone="accentSoft">
              <AssetMark t={t} id={privateMarkId(symbol, w.status?.network)} code={symbol} />
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
                {/* a ready pocket with no spendable figure has not answered
                    yet; it does not hold nothing. `?? "0"` drew a confident
                    0.0000000, which is what WalletProvider means by "a zero
                    would be a lie", and this is the biggest number on the
                    sheet. */}
                {priv.spendable ? (
                  <Amount
                    t={t}
                    value={priv.spendable}
                    code={symbol}
                    size="display"
                    hidden={w.hidden}
                  />
                ) : (
                  <Skeleton width={160} height={34} />
                )}
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

              {/* a READY pocket can still have something to say. under protocol
                  27 an archived entry is auto-restored to answer a read, so the
                  pocket is genuinely spendable AND genuinely dormant at the same
                  time, and only the first half was being reported. the message
                  is the worker's, and until this it was rendered on the
                  not-ready branch only, so a ready pocket's message went
                  nowhere. */}
              {priv?.message && (
                <div style={{ marginBottom: space.md }}>
                  <Notice t={t} tone="exposed">
                    {priv.message}
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
              {/* "Rebuild" is only a real offer where an archive exists to
                  replay from. D-009 gated the settings row and the move sheet
                  on `canRebuild` and left this map untouched, so on a build
                  with no archive this button sat under the worker's own
                  sentence saying it cannot be done, and the only way to learn
                  which was true was to press it. every other action here is
                  always available, so only this one is gated. */}
              {action && (
                <div style={{ marginTop: space.lg }}>
                  <Button t={t} onClick={go("move")}>
                    {action}
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
