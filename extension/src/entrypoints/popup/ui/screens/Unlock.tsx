import { useState } from "react";
import { call } from "../rpc";
import { Button, Field, Frame, Notice } from "../primitives";
import { text, type Theme } from "../theme";

export function Unlock({
  t,
  onUnlocked,
  onForgot,
}: {
  t: Theme;
  onUnlocked: () => void;
  onForgot: () => void;
}) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await call({ type: "unlock", password });
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPassword("");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Frame t={t}>
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 24,
        }}
      >
        <div style={{ ...text.hero, marginBottom: 6 }}>Pocket</div>
        <div style={{ ...text.body, color: t.sub, marginBottom: 26 }}>
          Locked. Enter your password to continue.
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <Field t={t} label="Password" type="password" value={password} onChange={setPassword} />
          {error && (
            <Notice tone="danger" t={t}>
              {error}
            </Notice>
          )}
          <Button t={t} disabled={busy || !password}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </form>
        {/* Without this, a forgotten password is a dead end even for someone
            holding their recovery phrase: the only way out would be removing
            the extension by hand, which silently discards the confidential
            openings too. */}
        <button
          onClick={onForgot}
          style={{
            ...text.caption,
            background: "none",
            border: "none",
            color: t.sub,
            cursor: "pointer",
            marginTop: 18,
            padding: 0,
            textAlign: "left",
          }}
        >
          Forgot your password?
        </button>
      </div>
    </Frame>
  );
}
