import { useEffect, useState } from "react";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Notice, Screen, TextButton } from "../primitives";
import { Brand } from "../Brand";
import { fonts, radius, space, text, type Theme } from "../theme";

type Step = "choose" | "create" | "backup" | "import";

export function Onboarding({ t, onDone }: { t: Theme; onDone: () => void }) {
  const [step, setStep] = useState<Step>("choose");
  const [mnemonic, setMnemonic] = useState("");

  if (step === "backup") return <Backup t={t} mnemonic={mnemonic} onDone={onDone} />;

  return (
    <Screen t={t}>
      <div style={{ paddingTop: space.md, textAlign: "center", marginBottom: space.xl }}>
        <Brand t={t} size={64} />
        <h1
          style={{ ...text.screenTitle, color: t.text, margin: `${space.gutter}px 0 ${space.xs}px` }}
        >
          {step === "choose" ? "Pocket" : step === "create" ? "New wallet" : "Restore wallet"}
        </h1>
        <p style={{ ...text.body, color: t.sub, margin: 0, lineHeight: 1.5 }}>
          {step === "choose"
            ? "Two pockets on Stellar. One public, one private."
            : step === "create"
              ? "Choose a password for this device."
              : "Enter your recovery phrase."}
        </p>
      </div>

      {step === "choose" && (
        <Choose t={t} onCreate={() => setStep("create")} onImport={() => setStep("import")} />
      )}
      {step === "create" && (
        <Create
          t={t}
          onCreated={(phrase) => {
            setMnemonic(phrase);
            setStep("backup");
          }}
          onCancel={() => setStep("choose")}
        />
      )}
      {step === "import" && <Import t={t} onDone={onDone} onCancel={() => setStep("choose")} />}
    </Screen>
  );
}

function Choose({
  t,
  onCreate,
  onImport,
}: {
  t: Theme;
  onCreate: () => void;
  onImport: () => void;
}) {
  return (
    <>
      <Notice t={t}>
        Pocket hides <strong>amounts</strong>, not addresses. Who you pay stays public on the ledger.
      </Notice>
      <ButtonStack>
        <Button t={t} onClick={onCreate}>
          Create a new wallet
        </Button>
        <Button t={t} variant="quiet" onClick={onImport}>
          I have a recovery phrase
        </Button>
      </ButtonStack>
    </>
  );
}

function Create({
  t,
  onCreated,
  onCancel,
}: {
  t: Theme;
  onCreated: (mnemonic: string) => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const short = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;
  const ready = password.length >= 8 && password === confirm;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await call({ type: "create", password });
      onCreated(r.mnemonic);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        t={t}
        label="Password"
        type="password"
        value={password}
        onChange={setPassword}
        placeholder="At least 8 characters"
        autoFocus
        invalid={short}
        hint={short ? "Use at least eight characters." : undefined}
      />
      <Field
        t={t}
        label="Confirm password"
        type="password"
        value={confirm}
        onChange={setConfirm}
        invalid={mismatch}
        hint={mismatch ? "The two passwords do not match." : undefined}
        onSubmit={() => void submit()}
      />
      <Notice t={t}>This password unlocks this device. It is not a backup.</Notice>
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      <ButtonStack>
        <Button t={t} disabled={!ready} busy={busy} onClick={() => void submit()}>
          {busy ? "Creating" : "Create wallet"}
        </Button>
        <TextButton t={t} tone="sub" onClick={onCancel}>
          Back
        </TextButton>
      </ButtonStack>
    </>
  );
}

/**
 * the one time the phrase is ever on screen.
 *
 * the ordinal is unselectable and each word carries a trailing space, so a drag
 * selection and the copy button both produce a phrase that restores.
 */
function Backup({ t, mnemonic, onDone }: { t: Theme; mnemonic: string; onDone: () => void }) {
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const words = mnemonic.split(" ");

  useEffect(() => {
    if (copy === "idle") return;
    const id = setTimeout(() => setCopy("idle"), 2500);
    return () => clearTimeout(id);
  }, [copy]);

  return (
    <Screen t={t}>
      <h1 style={{ ...text.screenTitle, color: t.text, margin: `${space.sm}px 0 ${space.sm}px` }}>
        Write this down
      </h1>
      <Notice t={t} tone="exposed">
        These {words.length} words are the only way to recover this wallet. Anyone who has them owns
        your funds. Pocket cannot show them again.
      </Notice>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))",
          gap: space.xs,
          background: t.field,
          padding: space.md,
          borderRadius: radius.lg,
          marginBottom: space.md,
        }}
      >
        {words.map((word, i) => (
          <span
            key={i}
            style={{ ...text.body, fontFamily: fonts.mono, color: t.text, display: "flex", gap: 6 }}
          >
            <span style={{ color: t.faint, userSelect: "none" }}>{i + 1}.</span>{" "}
            {word}{" "}
          </span>
        ))}
      </div>

      {copy === "failed" && (
        <Notice t={t} tone="danger">
          Could not reach the clipboard. Select the words above, or write them down.
        </Notice>
      )}

      <ButtonStack>
        <Button
          t={t}
          variant="quiet"
          onClick={() =>
            void navigator.clipboard.writeText(mnemonic).then(
              () => setCopy("done"),
              () => setCopy("failed"),
            )
          }
        >
          {copy === "done" ? "Copied" : "Copy the phrase"}
        </Button>
        <Button t={t} onClick={onDone}>
          I have written it down
        </Button>
      </ButtonStack>
    </Screen>
  );
}

function Import({ t, onDone, onCancel }: { t: Theme; onDone: () => void; onCancel: () => void }) {
  const [phrase, setPhrase] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const words = phrase.trim() ? phrase.trim().split(/\s+/).length : 0;
  const short = password.length > 0 && password.length < 8;
  const ready = password.length >= 8 && words > 0;

  const submit = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call({ type: "import", password, mnemonic: phrase });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <Field
        t={t}
        label={
          words ? `Recovery phrase (${words} ${words === 1 ? "word" : "words"})` : "Recovery phrase"
        }
        value={phrase}
        onChange={setPhrase}
        placeholder="12 or 24 words, separated by spaces"
        multiline
        mono
        autoFocus
      />
      <Field
        t={t}
        label="New password"
        type="password"
        value={password}
        onChange={setPassword}
        placeholder="At least 8 characters"
        invalid={short}
        hint={short ? "Use at least eight characters." : undefined}
        onSubmit={() => void submit()}
      />
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      <ButtonStack>
        <Button t={t} disabled={!ready} busy={busy} onClick={() => void submit()}>
          {busy ? "Importing" : "Import wallet"}
        </Button>
        <TextButton t={t} tone="sub" onClick={onCancel}>
          Back
        </TextButton>
      </ButtonStack>
    </>
  );
}
