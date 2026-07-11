// the wallet's overflow menu.
//
// the lock lived as a bare padlock in the header, one press from locking the
// wallet by accident. it moves in here, alongside the other whole-wallet
// actions, behind a "more" affordance so nothing destructive is a stray tap.
import type { ReactNode } from "react";
import { useWallet } from "../WalletProvider";
import { Sheet } from "../primitives";
import { QrIcon, Copy, Lock, Gear } from "../icons";
import { space, text, radius, type Theme } from "../theme";

function Item({
  t,
  icon,
  label,
  onClick,
  tone = "plain",
}: {
  t: Theme;
  icon: ReactNode;
  label: string;
  onClick: () => void;
  tone?: "plain" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        all: "unset",
        boxSizing: "border-box",
        cursor: "pointer",
        display: "flex",
        alignItems: "center",
        gap: space.md,
        width: "100%",
        padding: `${space.md}px ${space.sm}px`,
        borderRadius: radius.md,
        color: tone === "danger" ? t.danger : t.text,
      }}
    >
      <span style={{ display: "flex", color: tone === "danger" ? t.danger : t.sub }}>{icon}</span>
      <span style={{ ...text.rowTitle }}>{label}</span>
    </button>
  );
}

export function MenuSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const address = w.status?.address;

  const go = (fn: () => void) => () => {
    onClose();
    fn();
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Wallet">
      <div style={{ display: "flex", flexDirection: "column", paddingBottom: space.gutter }}>
        <Item t={t} icon={<QrIcon size={20} />} label="Receive" onClick={go(() => w.openSheet("receive"))} />
        {address && (
          <Item
            t={t}
            icon={<Copy size={18} />}
            label="Copy address"
            onClick={go(() => w.copy(address))}
          />
        )}
        <Item t={t} icon={<Gear size={20} />} label="Settings" onClick={go(() => w.setTab("settings"))} />
        <Item t={t} icon={<Lock size={18} />} label="Lock wallet" onClick={go(() => void w.lock())} />
      </div>
    </Sheet>
  );
}
