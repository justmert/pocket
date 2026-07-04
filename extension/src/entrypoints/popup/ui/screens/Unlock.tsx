import { useState } from "react";
import { call } from "../rpc";
import { Button, Field, Frame, Notice, ScrollArea, TextButton } from "../primitives";
import { BrandRow } from "../Brand";
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
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await call({ type: "unlock", password });
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // a wrong password leaves nothing worth keeping in the field.
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <Frame t={t}>
      <ScrollArea className="pocket-page" background={t.canvas}>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{
            minHeight: "100%",
            boxSizing: "border-box",
            padding: `${space.xl}px ${space.gutter}px ${space.gutter}px`,
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div style={{ textAlign: "center", marginTop: space.xl }}>
            <BrandRow t={t} size={56} />
            <h1
              style={{ ...text.screenTitle, color: t.text, margin: `${space.gutter}px 0 ${space.xs}px` }}
            >
              Locked
            </h1>
            <p style={{ ...text.body, color: t.sub, margin: 0 }}>
              Enter your password to continue.
            </p>
          </div>

          <div style={{ marginTop: "auto", paddingTop: space.xl }}>
            {error && (
              <Notice t={t} tone="danger">
                {error}
              </Notice>
            )}
            <Field
              t={t}
              label="Password"
              type="password"
              value={password}
              onChange={setPassword}
              autoFocus
            />
            <Button t={t} type="submit" disabled={!password} busy={busy}>
              {busy ? "Unlocking" : "Unlock"}
            </Button>
            <div style={{ textAlign: "center", marginTop: space.sm }}>
              <TextButton t={t} tone="sub" onClick={onForgot}>
                Forgot your password?
              </TextButton>
            </div>
          </div>
        </form>
      </ScrollArea>
    </Frame>
  );
}
