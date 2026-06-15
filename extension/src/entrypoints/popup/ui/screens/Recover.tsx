import { useState } from "react";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Frame, Header, Label, Notice } from "../primitives";
import { leading, space, text, type Theme } from "../theme";

/**
 * The route out of a forgotten password.
 *
 * `reset` cannot serve this: it asks for the password, which is the thing that
 * is lost. Authorisation comes from the recovery phrase instead, and the worker
 * checks that the phrase derives THIS wallet before erasing anything, so a
 * stranger's phrase cannot be used to wipe someone else's device.
 *
 * The warning is the important part of this screen. A recovery phrase restores
 * KEYS, not MONEY. Confidential balance openings are destroyed with the vault
 * and are not derivable from the phrase: only replaying the event history
 * rebuilds them, and that needs an archive. Anyone reaching here with a funded
 * private pocket needs to know that before they type twenty-four words.
 */
export function Recover({
  t,
  onDone,
  onCancel,
}: {
  t: Theme;
  onDone: () => void;
  onCancel: () => void;
}) {
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const words = phrase.trim().split(/\s+/).filter(Boolean).length;
  const ready =
    acknowledged && (words === 12 || words === 24) && password.length >= 8 && password === confirm;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call({ type: "recoverFromMnemonic", mnemonic: phrase, password });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!acknowledged) {
    return (
      <Frame t={t}>
        <Header title="Erase and restore" t={t} />
        <div style={{ padding: space.gutter, flex: 1, overflowY: "auto" }}>
          <Notice tone="danger" t={t}>
            This erases the wallet on this device. Everything it holds goes with it.
          </Notice>

          <div style={{ marginTop: space.gutter }}>
            <Label t={t}>What comes back, and what does not</Label>
          </div>
          <ul
            style={{
              ...text.body,
              color: t.text,
              paddingLeft: space.gutter,
              margin: 0,
              lineHeight: leading.relaxed,
            }}
          >
            <li>
              Your <strong>public pocket</strong> comes back in full. The phrase reproduces the same
              address and its balance is on the ledger.
            </li>
            <li>
              Your <strong>private pocket balances do not</strong>. The chain stores commitments;
              only this device knew what opens them, and that is destroyed here.
            </li>
            <li>
              Rebuilding them means replaying your event history from a durable archive. This build
              has none configured, so <strong>they cannot be rebuilt yet</strong>.
            </li>
          </ul>

          <div style={{ marginTop: space.lg }}>
            <Notice tone="exposed" t={t}>
              If your private pocket holds funds, do not continue. Unlock normally if you can, and
              move them out first.
            </Notice>
          </div>

          {/* The way out comes first and carries the weight. The destructive
              path is still one tap away, but it is not the loudest thing on a
              screen whose entire job is to talk you out of it. */}
          <ButtonStack>
            <Button t={t} onClick={onCancel}>
              Go back
            </Button>
            <Button t={t} variant="danger" onClick={() => setAcknowledged(true)}>
              I understand, continue
            </Button>
          </ButtonStack>
        </div>
      </Frame>
    );
  }

  return (
    <Frame t={t}>
      <Header title="Erase and restore" t={t} />
      <div style={{ padding: space.gutter, flex: 1, overflowY: "auto" }}>
        <div style={{ ...text.body, color: t.sub, marginBottom: space.lg }}>
          Enter the recovery phrase for this wallet, then choose a new password.
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field
            t={t}
            label={`Recovery phrase (${words} ${words === 1 ? "word" : "words"})`}
            value={phrase}
            onChange={setPhrase}
            placeholder="twelve or twenty-four words, separated by spaces"
            multiline
          />
          <Field
            t={t}
            label="New password"
            type="password"
            value={password}
            onChange={setPassword}
          />
          <Field
            t={t}
            label="Confirm new password"
            type="password"
            value={confirm}
            onChange={setConfirm}
          />

          {/* Every rule that keeps the button disabled says so. A control that
              refuses to work without explaining why is the same bug whether
              the rule is the word count or the password. */}
          {words > 0 && words !== 12 && words !== 24 && (
            <Notice t={t}>A recovery phrase is 12 or 24 words. This one has {words}.</Notice>
          )}
          {password.length > 0 && password.length < 8 && (
            <Notice t={t}>Use at least eight characters.</Notice>
          )}
          {confirm.length > 0 && password !== confirm && (
            <Notice t={t}>The two passwords do not match.</Notice>
          )}
          {error && (
            <Notice tone="danger" t={t}>
              {error}
            </Notice>
          )}

          {/* Cancel is explicitly type="button". A bare button inside a form
              submits it, so this one used to fire the erase as well as the
              cancel. */}
          <ButtonStack>
            <Button t={t} type="submit" variant="danger" disabled={busy || !ready}>
              {busy ? "Restoring…" : "Erase and restore"}
            </Button>
            <Button t={t} variant="quiet" onClick={onCancel}>
              Cancel
            </Button>
          </ButtonStack>
        </form>
      </div>
    </Frame>
  );
}
