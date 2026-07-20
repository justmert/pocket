import { useWallet } from "../WalletProvider";
import { useFundTestnet } from "../FundTestnet";
import { NAV_SPACE } from "../BottomNav";
import { Header, Overline, Row, ScrollArea } from "../primitives";
import { canRebuild } from "../copy";
import { Chip } from "../primitives";
import { autoLockLabel } from "../sheets/SettingsSheets";
import { Alert, ChevronRight, Clock, Coins, External, Key, Lock, Refresh, Trash } from "../icons";
import { space } from "../theme";

export function Settings() {
  const w = useWallet();
  const t = w.t;

  // testnet funding, from friendbot. the row has no body to grow an inline notice,
  // so the outcome is a toast; `funding` spins the row's trailing glyph and blocks
  // a second press mid-flight.
  const { fund, funding } = useFundTestnet();
  const runFund = () => {
    if (funding) return;
    void fund().then((err) =>
      w.showToast(err ?? "Testnet XLM added to your account.", err ? "neutral" : "positive"),
    );
  };

  // one running counter, incremented only for rows actually rendered, so the
  // entrance stagger stays contiguous. hardcoded 0..5 left a 90ms gap in the
  // cascade whenever the conditional Rebuild row (index 2) was absent, which is
  // the common case: no archive, or no private pocket.
  let i = 0;

  return (
    <ScrollArea className="pocket-page" background={t.canvas}>
      <div style={{ padding: `${space.gutter}px ${space.gutter}px ${NAV_SPACE}px` }}>
        <Header t={t} title="Settings" />

        <Overline t={t}>Connection</Overline>
        <Row
          t={t}
          index={i++}
          icon={<External size={19} />}
          title="Network"
          sub="Where this wallet reads and writes"
          value={
            <Chip t={t} tone="accent">
              {w.status?.network ?? "…"}
            </Chip>
          }
          onClick={() => w.openSheet("network")}
        />

        {/* testnet-only: friendbot funds a fresh account so it exists on the ledger.
            mainnet has no faucet, so this section is absent there entirely. */}
        {w.status?.network === "testnet" && (
          <div style={{ marginTop: space.lg }}>
            <Overline t={t}>Testnet</Overline>
            <Row
              t={t}
              index={i++}
              icon={<Coins size={19} />}
              title="Fund account"
              sub="Get free testnet XLM from friendbot"
              value={funding ? <Refresh size={17} className="pocket-spinner" /> : undefined}
              onClick={runFund}
            />
          </div>
        )}

        <div style={{ marginTop: space.lg }}>
          <Overline t={t}>Assets</Overline>
          <Row
            t={t}
            index={i++}
            icon={<Coins size={19} />}
            title="Manage assets"
            sub="Add or remove the assets this wallet holds"
            value={<ChevronRight size={17} />}
            onClick={() => w.openSheet("assets")}
          />
        </div>

        <div style={{ marginTop: space.lg }}>
          <Overline t={t}>Sites</Overline>
          <Row
            t={t}
            index={i++}
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
            testnet, including to wallets with no private pocket at all. */}
        {w.status?.privateAvailable && canRebuild(w.status.network) && (
          <div style={{ marginTop: space.lg }}>
            <Overline t={t}>Private pocket</Overline>
            <Row
              t={t}
              index={i++}
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
            index={i++}
            icon={<Clock size={19} />}
            title="Auto-lock"
            sub="Lock automatically after inactivity"
            value={
              <Chip t={t} tone="accent">
                {autoLockLabel(w.status?.autoLockMinutes)}
              </Chip>
            }
            onClick={() => w.openSheet("autolock")}
          />
          <Row
            t={t}
            index={i++}
            icon={<Lock size={19} />}
            title="Lock now"
            sub="Clears the keys from memory"
            onClick={() => void w.lock()}
          />
          <Row
            t={t}
            index={i++}
            icon={<Key size={19} />}
            title="Recovery phrase"
            sub="Show the words that back up this wallet"
            value={<ChevronRight size={17} />}
            onClick={() => w.openSheet("phrase")}
          />
          <Row
            t={t}
            index={i}
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
