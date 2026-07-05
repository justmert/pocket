import { useState } from "react";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Header, Notice, Screen } from "../primitives";
import { space, text, type Theme } from "../theme";
import { NETWORKS } from "../../../../core/config";
import type { NetworkId } from "../../../../core/config";

/**
 * the only way past a forgotten password, and it destroys the device's copy of
 * everything. the gate exists because the private pocket's openings are not on
 * the chain: whether they can be rebuilt depends on there being an archive, so
 * that is read from config rather than asserted.
 */
export function Recover({
  t,
  network,
  onDone,
  onCancel,
}: {
  t: Theme;
  network: NetworkId;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const archived = Boolean(NETWORKS[network].archiveUrl);
  const words = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  const countOk = words === 12 || words === 24;
  const short = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = countOk && password.length >= 8 && password === confirm;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call({ type: "recoverFromMnemonic", mnemonic: phrase, password });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  if (!acknowledged) {
    return (
      <Screen t={t}>
        <Header t={t} title="Erase and restore" onBack={onCancel} />
        <Notice t={t} tone="danger">
          This erases the wallet on this device. Everything it holds goes with it.
        </Notice>

        <ul
          style={{
            ...text.body,
            color: t.text,
            paddingLeft: space.gutter,
            margin: `0 0 ${space.md}px`,
            lineHeight: 1.55,
          }}
        >
          <li style={{ marginBottom: space.xs }}>
            Your <strong>public pocket</strong> comes back in full. The phrase reproduces the same
            address, and its balance is on the ledger.
          </li>
          <li style={{ marginBottom: space.xs }}>
            Your <strong>private pocket balances do not</strong>. The chain holds commitments; only
            this device knew what opens them.
          </li>
          <li>
            {archived
              ? "They can be rebuilt afterwards by replaying your history from the archive."
              : "Rebuilding them needs a durable archive. This build has none configured, so they cannot be rebuilt yet."}
          </li>
        </ul>

        <Notice t={t} tone="exposed">
          If your private pocket holds funds, do not continue. Unlock normally if you can, and move
          them out first.
        </Notice>

        <ButtonStack>
          <Button t={t} onClick={onCancel}>
            Go back
          </Button>
          <Button t={t} variant="danger" onClick={() => setAcknowledged(true)}>
            I understand, continue
          </Button>
        </ButtonStack>
      </Screen>
    );
  }

  return (
    <Screen t={t}>
      <Header t={t} title="Erase and restore" onBack={() => setAcknowledged(false)} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          t={t}
          label={words ? `Recovery phrase (${words} ${words === 1 ? "word" : "words"})` : "Recovery phrase"}
          value={phrase}
          onChange={setPhrase}
          placeholder="12 or 24 words, separated by spaces"
          multiline
          mono
          autoFocus
          invalid={words > 0 && !countOk}
          hint={
            words > 0 && !countOk
              ? `A recovery phrase is 12 or 24 words. This one has ${words}.`
              : undefined
          }
        />
        <Field
          t={t}
          label="New password"
          type="password"
          value={password}
          onChange={setPassword}
          invalid={short}
          hint={short ? "Use at least eight characters." : undefined}
        />
        <Field
          t={t}
          label="Confirm new password"
          type="password"
          value={confirm}
          onChange={setConfirm}
          invalid={mismatch}
          hint={mismatch ? "The two passwords do not match." : undefined}
        />
        {error && (
          <Notice t={t} tone="danger">
            {error}
          </Notice>
        )}
        <ButtonStack>
          <Button t={t} type="submit" variant="danger" disabled={!ready} busy={busy}>
            {busy ? "Restoring" : "Erase and restore"}
          </Button>
          <Button t={t} variant="quiet" onClick={onCancel}>
            Cancel
          </Button>
        </ButtonStack>
      </form>
    </Screen>
  );
}
