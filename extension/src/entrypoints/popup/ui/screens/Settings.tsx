import { useWallet } from "../WalletProvider";
import { NAV_SPACE } from "../BottomNav";
import { Overline, Row, ScrollArea } from "../primitives";
import { Chip } from "../primitives";
import { Alert, ChevronRight, External, Key, Lock, Shield, Trash } from "../icons";
import { space, text } from "../theme";

export function Settings() {
  const w = useWallet();
  const t = w.t;

  return (
    <ScrollArea background={t.canvas}>
      <div style={{ padding: `${space.gutter}px ${space.gutter}px ${NAV_SPACE}px` }}>
        <h1 style={{ ...text.screenTitle, color: t.text, margin: `${space.xs}px 0 ${space.lg}px` }}>
          Settings
        </h1>

        <Overline t={t}>Network</Overline>
        <Row
          t={t}
          index={0}
          icon={<External size={19} />}
          title="Network"
          sub="Where this wallet reads and writes"
          value={<Chip t={t} tone="accent">{w.status?.network ?? "…"}</Chip>}
          onClick={() => w.openSheet("network")}
        />

        <div style={{ marginTop: space.lg }}>
          <Overline t={t}>Sites</Overline>
          <Row
            t={t}
            index={1}
            icon={<Key size={19} />}
            title="Connected sites"
            sub="What can ask this wallet to sign"
            value={<ChevronRight size={17} />}
            onClick={() => w.openSheet("connections")}
          />
        </div>

        {w.status?.privateAvailable && (
          <div style={{ marginTop: space.lg }}>
            <Overline t={t}>Private pocket</Overline>
            <Row
              t={t}
              index={2}
              icon={<Shield size={19} />}
              title="Rebuild from history"
              sub="Replay the ledger to recover balances"
              value={<ChevronRight size={17} />}
              onClick={() => w.openSheet("rebuild")}
            />
          </div>
        )}

        <div style={{ marginTop: space.lg }}>
          <Overline t={t}>This device</Overline>
          <Row
            t={t}
            index={3}
            icon={<Lock size={19} />}
            title="Lock now"
            sub="Clears the keys from memory"
            onClick={() => void w.lock()}
          />
          <Row
            t={t}
            index={4}
            tone="danger"
            icon={<Trash size={19} />}
            title="Erase this wallet"
            sub="Needs your recovery phrase to come back"
            value={<Alert size={17} />}
            onClick={() => w.openSheet("erase")}
          />
        </div>
      </div>
    </ScrollArea>
  );
}
