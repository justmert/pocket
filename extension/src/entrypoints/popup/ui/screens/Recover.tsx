import { useState } from "react";
import { call } from "../rpc";
import { useWallet } from "../WalletProvider";
import { Button, ButtonStack, Field, Header, Notice, Screen, TextButton } from "../primitives";
import { space, text, type Theme } from "../theme";
import { PHRASE_LENGTHS, phraseLengthList, privateLossAfterErase } from "../copy";

/**
 * the only way past a forgotten password, and it destroys the device's copy of
 * everything. the gate exists because the private pocket's openings are not on
 * the chain: whether they can be rebuilt depends on there being an archive, and
 * that answer comes from `copy.ts`, which reads the config, so this door and the
 * erase door cannot describe the same consequence differently.
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
  const network = useWallet().status?.network ?? "testnet";
  const [acknowledged, setAcknowledged] = useState(false);
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const words = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  // every BIP-39 length, because the worker underneath accepts every BIP-39
  // length. `doRecoverFromMnemonic` gates on `validateMnemonic`, which passes
  // 12, 15, 18, 21 and 24, and `import` does too, so this screen refused
  // phrases the same wallet had accepted at set-up. It is the ONLY
  // forgotten-password route, so a 15-word holder was locked out of their own
  // funds by a check the wallet did not actually need.
  const countOk = PHRASE_LENGTHS.includes(words);
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
      <Screen t={t} still>
        <Header t={t} title="Reset with your phrase" onBack={onCancel} />
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
            Your <strong>public pocket</strong> comes back in full from the phrase; its balance is
            on the ledger.
          </li>
          {/* the SHARED sentence, from the same place the erase sheet reads it.
              this wrote its own version and the docstring above claimed the
              rebuild fact was "read from config" in a file that imported no
              config: on a build with an archive configured the two doors to this
              consequence would have flatly contradicted each other, with the
              softer answer on the door more people reach, which is the failure
              `copy.ts` was created to end. */}
          <li>{privateLossAfterErase(network)}</li>
        </ul>

        <Notice t={t} tone="exposed">
          If your private pocket holds funds, do not continue. Unlock normally if you can, and move
          them out first.
        </Notice>

        <ButtonStack>
          {/* the safe exit is the loud accent button and states the outcome
              rather than a direction, matching the erase-wallet door in
              settings so the same act reads the same way from both places. */}
          <Button t={t} onClick={onCancel}>
            Keep this wallet
          </Button>
          <Button t={t} variant="danger" onClick={() => setAcknowledged(true)}>
            I understand, continue
          </Button>
        </ButtonStack>
      </Screen>
    );
  }

  return (
    <Screen t={t} still>
      <Header t={t} title="Reset with your phrase" onBack={() => setAcknowledged(false)} />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Field
          t={t}
          label={
            words
              ? `Recovery phrase (${words} ${words === 1 ? "word" : "words"})`
              : "Recovery phrase"
          }
          value={phrase}
          onChange={setPhrase}
          placeholder="your recovery phrase, words separated by spaces"
          multiline
          mono
          autoFocus
          invalid={words > 0 && !countOk}
          hint={
            words > 0 && !countOk
              ? `A recovery phrase is ${phraseLengthList()} words. This one has ${words}.`
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
        <Notice t={t}>This password unlocks this device. It is not a backup.</Notice>
        {error && (
          <Notice t={t} tone="danger">
            {error}
          </Notice>
        )}
        <ButtonStack>
          <Button t={t} type="submit" variant="danger" disabled={!ready} busy={busy}>
            {busy ? "Restoring" : "Erase and restore"}
          </Button>
          {/* the quiet abandon-step control is a text link, matching the "Back"
              affordance the onboarding create/import flows use for the same role. */}
          <TextButton t={t} tone="sub" onClick={onCancel}>
            Back
          </TextButton>
        </ButtonStack>
      </form>
    </Screen>
  );
}
