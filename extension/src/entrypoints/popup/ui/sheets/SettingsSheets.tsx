import { useEffect, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Label, Notice, Row, Sheet, Skeleton } from "../primitives";
import { Check, External, Trash } from "../icons";
import { space, text } from "../theme";
import type { NetworkId } from "../../../../core/config";

const NETWORKS: { id: NetworkId; label: string; sub: string }[] = [
  { id: "testnet", label: "Testnet", sub: "Free test funds, reset periodically" },
  { id: "mainnet", label: "Mainnet", sub: "Real funds" },
];

export function NetworkSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<NetworkId | null>(null);

  const choose = async (network: NetworkId) => {
    if (network === w.status?.network) return;
    setBusy(network);
    setError(null);
    try {
      await call({ type: "setNetwork", network });
      await w.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Network">
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      {NETWORKS.map((n, i) => (
        <Row
          key={n.id}
          t={t}
          index={i}
          icon={<External size={19} />}
          title={n.label}
          sub={n.sub}
          value={
            w.status?.network === n.id ? (
              <Check size={19} sw={2.6} />
            ) : busy === n.id ? (
              <Skeleton width={19} height={19} />
            ) : undefined
          }
          onClick={() => void choose(n.id)}
        />
      ))}
      <Notice t={t}>
        A private pocket belongs to one deployment. Switching networks means setting one up again.
      </Notice>
    </Sheet>
  );
}

export function ConnectionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [sessions, setSessions] = useState<{ origin: string; connectedAt: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setSessions(await call({ type: "dappSessions" }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  const disconnect = async (origin: string) => {
    try {
      await call({ type: "disconnectDapp", origin });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Connected sites">
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      {sessions === null ? (
        <Skeleton width="100%" height={44} />
      ) : sessions.length === 0 ? (
        <div style={{ ...text.body, color: t.sub, lineHeight: 1.5 }}>
          No site is connected. A site asks to connect the first time it needs your address.
        </div>
      ) : (
        sessions.map((s, i) => (
          <Row
            key={s.origin}
            t={t}
            index={i}
            title={s.origin}
            sub={`Connected ${new Date(s.connectedAt).toLocaleDateString()}`}
            value={<Trash size={18} />}
            tone="danger"
            onClick={() => void disconnect(s.origin)}
          />
        ))
      )}
    </Sheet>
  );
}

export function RebuildSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await call({ type: "rebuildFromHistory" });
      await w.refresh();
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Rebuild from history">
      <Notice t={t}>
        Replays your event history and checks the result against what the contract holds. An
        incomplete history is refused rather than accepted.
      </Notice>
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      {done && (
        <Notice t={t} tone="positive">
          Rebuilt from history.
        </Notice>
      )}
      <ButtonStack>
        <Button t={t} busy={busy} onClick={() => void run()}>
          {busy ? "Replaying your history" : "Rebuild"}
        </Button>
      </ButtonStack>
    </Sheet>
  );
}

export function EraseSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call({ type: "reset", password });
      await w.reloadStatus();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Erase this wallet">
      <Notice t={t} tone="danger">
        This removes the wallet from this device. Without your recovery phrase it cannot come back.
      </Notice>

      {!confirmed ? (
        <>
          <Label t={t}>What survives</Label>
          <ul
            style={{
              ...text.body,
              color: t.text,
              paddingLeft: space.gutter,
              margin: `0 0 ${space.md}px`,
              lineHeight: 1.55,
            }}
          >
            <li style={{ marginBottom: 6 }}>
              Your public balance is on the ledger. The phrase brings it back.
            </li>
            <li>
              Your private balances are opened by keys held only here. Rebuilding them needs your
              history from an archive.
            </li>
          </ul>
          <ButtonStack>
            <Button t={t} variant="quiet" onClick={onClose}>
              Keep this wallet
            </Button>
            <Button t={t} variant="danger" onClick={() => setConfirmed(true)}>
              I understand, continue
            </Button>
          </ButtonStack>
        </>
      ) : (
        <>
          <Field
            t={t}
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoFocus
            onSubmit={() => void run()}
          />
          {error && (
            <Notice t={t} tone="danger">
              {error}
            </Notice>
          )}
          <ButtonStack>
            <Button t={t} variant="danger" disabled={!password} busy={busy} onClick={() => void run()}>
              {busy ? "Erasing" : "Erase this wallet"}
            </Button>
            <Button t={t} variant="quiet" onClick={onClose}>
              Cancel
            </Button>
          </ButtonStack>
        </>
      )}
    </Sheet>
  );
}
