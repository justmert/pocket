import { useState } from "react";
import { call } from "../rpc";
import { Button, Field, Frame, Header, Notice } from "../primitives";
import { mono, text, type Theme } from "../theme";

type Step = "choose" | "create" | "backup" | "import";

export function Onboarding({ t, onDone }: { t: Theme; onDone: () => void }) {
  const [step, setStep] = useState<Step>("choose");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [phrase, setPhrase] = useState("");
  const [mnemonic, setMnemonic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame t={t}>
      <Header title="Pocket" t={t} />
      <div style={{ padding: 18, flex: 1 }}>
        {step === "choose" && (
          <>
            <p style={{ ...text.body, color: t.sub, lineHeight: 1.55, marginTop: 0 }}>
              A Stellar wallet with two pockets. One public, one private.
            </p>
            <Notice t={t}>
              Pocket hides <strong>amounts</strong>, not addresses. Who you pay stays public on the
              ledger, always.
            </Notice>
            <div style={{ marginTop: 20, display: "grid", gap: 10 }}>
              <Button t={t} onClick={() => setStep("create")}>
                Create a new wallet
              </Button>
              <Button t={t} variant="quiet" onClick={() => setStep("import")}>
                I have a recovery phrase
              </Button>
            </div>
          </>
        )}

        {step === "create" && (
          <>
            <Field
              t={t}
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              placeholder="Unlocks this device only"
            />
            <Field
              t={t}
              label="Confirm password"
              type="password"
              value={confirm}
              onChange={setConfirm}
            />
            <Notice t={t}>
              This password encrypts your wallet on this device. It is not a backup: it cannot
              recover your funds on another machine.
            </Notice>
            {error && (
              <Notice tone="danger" t={t}>
                {error}
              </Notice>
            )}
            <Button
              t={t}
              disabled={busy || password.length < 8 || password !== confirm}
              onClick={() =>
                run(async () => {
                  const r = await call({ type: "create", password });
                  setMnemonic(r.mnemonic);
                  setStep("backup");
                })
              }
            >
              {busy ? "Creating…" : "Create wallet"}
            </Button>
          </>
        )}

        {step === "backup" && (
          <>
            <div style={{ ...text.title, marginBottom: 10 }}>Write this down</div>
            <Notice tone="exposed" t={t}>
              These 24 words are the only way to recover your wallet. Anyone who has them owns your
              funds. Pocket cannot show them to you again.
            </Notice>
            <div
              style={{
                fontFamily: mono,
                fontSize: 13,
                lineHeight: 1.9,
                background: t.field,
                border: `1px solid ${t.line}`,
                borderRadius: 10,
                padding: 12,
                marginBottom: 16,
                userSelect: "all",
              }}
            >
              {mnemonic.split(" ").map((w, i) => (
                <span key={i} style={{ display: "inline-block", width: "33%" }}>
                  <span style={{ color: t.faint }}>{i + 1}.</span> {w}
                </span>
              ))}
            </div>
            <Button t={t} onClick={onDone}>
              I have written it down
            </Button>
          </>
        )}

        {step === "import" && (
          <>
            <Field
              t={t}
              label="Recovery phrase"
              multiline
              value={phrase}
              onChange={setPhrase}
              placeholder="12 or 24 words, separated by spaces"
            />
            <Field
              t={t}
              label="New password"
              type="password"
              value={password}
              onChange={setPassword}
            />
            {error && (
              <Notice tone="danger" t={t}>
                {error}
              </Notice>
            )}
            <Button
              t={t}
              disabled={busy || password.length < 8 || phrase.trim().length === 0}
              onClick={() =>
                run(async () => {
                  await call({ type: "import", password, mnemonic: phrase });
                  onDone();
                })
              }
            >
              {busy ? "Importing…" : "Import wallet"}
            </Button>
          </>
        )}
      </div>
    </Frame>
  );
}
