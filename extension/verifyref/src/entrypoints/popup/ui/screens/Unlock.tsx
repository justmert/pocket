import { useState } from "react";
import { call } from "../rpc";
import { Button, Field, Frame, Notice, TextButton } from "../primitives";
import { space, text, type Theme } from "../theme";

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
          padding: space.gutter,
        }}
      >
        <div style={{ ...text.hero, marginBottom: space.xs }}>Pocket</div>
        <div style={{ ...text.body, color: t.sub, marginBottom: space.xl }}>
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
          <Button t={t} type="submit" disabled={busy || !password}>
            {busy ? "Unlocking…" : "Unlock"}
          </Button>
        </form>
        {/* Without this, a forgotten password is a dead end even for someone
            holding their recovery phrase: the only way out would be removing
            the extension by hand, which silently discards the confidential
            openings too. */}
        <div style={{ marginTop: space.gutter }}>
          <TextButton t={t} onClick={onForgot}>
            Forgot your password?
          </TextButton>
        </div>
      </div>
    </Frame>
  );
}
