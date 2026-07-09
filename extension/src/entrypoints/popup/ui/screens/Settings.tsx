import { useWallet } from "../WalletProvider";
import { NAV_SPACE } from "../BottomNav";
import { Overline, Row, ScrollArea } from "../primitives";
import { canRebuild } from "../copy";
import { Chip } from "../primitives";
import { Alert, ChevronRight, External, Key, Lock, Refresh, Trash } from "../icons";
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

        {/* offered only where it can actually run. this build has no archive, so
            on every artifact a user can install this row is absent rather than
            present-and-refusing. it was shown to every user, gated only on the
            network having a confidential deployment, which is always true on
            testnet — including to wallets with no private pocket at all. */}
        {w.status?.privateAvailable && canRebuild(w.status.network) && (
          <div style={{ marginTop: space.lg }}>
            <Overline t={t}>Private pocket</Overline>
            <Row
              t={t}
              index={2}
              icon={<Refresh size={19} />}
              title="Rebuild from history"
              sub="Replay your event history from the archive"
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
