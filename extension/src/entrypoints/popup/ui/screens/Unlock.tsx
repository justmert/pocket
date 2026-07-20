import { useState } from "react";
import { call } from "../rpc";
import { useWallet } from "../WalletProvider";
import { Button, Field, Frame, Notice, ScrollArea, TextButton } from "../primitives";
import { Eye, EyeOff } from "../icons";
import { Cover } from "../Cover";
import { radius, space, text, type Theme } from "../theme";

export function Unlock({
  t,
  onUnlocked,
  onForgot,
}: {
  t: Theme;
  onUnlocked: () => void;
  onForgot: () => void;
}) {
  const w = useWallet();
  const minutes = w.status?.autoLockMinutes ?? 0;
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reveal, setReveal] = useState(false);

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
      // and it stops being revealed: the next attempt starts covered.
      setReveal(false);
    }
  };

  return (
    <Frame t={t}>
      <ScrollArea className="pocket-page" background={t.canvas}>
        <Cover t={t} />
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          style={{
            position: "relative",
            minHeight: "100%",
            boxSizing: "border-box",
            padding: `${space.xl}px ${space.gutter}px ${space.gutter}px`,
            display: "flex",
            flexDirection: "column",
            // the lockup and the form read as ONE centred column, not a mark pinned
            // to the top and a card pinned to the bottom with a void between them.
            // centring the group is what fills the empty middle without decorating it.
            justifyContent: "center",
          }}
        >
          {/* The lockup is stacked rather than a row, and larger: this is the
              one screen with no other content competing for the eye, and it is
              the screen a returning user sees more often than any other. */}
          <div style={{ textAlign: "center" }}>
            {/* The wordmark, decorative: the product's name is already spoken by
                the sentence under the heading, so announcing it here would say
                "Pocket" twice to a screen reader and add nothing.

                The drawn logo itself, packaged. The accent wash lives in the
                `Cover` behind it, so the mark stays the mark.

                Root-relative, which resolves against the DOCUMENT (the popup at
                chrome-extension://<id>/popup.html) in both a development and a
                shipped build. `img-src 'self'` allows it precisely because it is
                packaged rather than fetched. */}
            <img
              src="/logo.svg"
              alt=""
              aria-hidden
              // capped rather than fixed, so it gives way at Chrome's maximum
              // zoom, where the frame is 160px wide.
              style={{
                width: "min(240px, 76%)",
                height: "auto",
                display: "block",
                margin: "0 auto",
                // logo.svg is dark vector artwork; the lock screen runs the private (dark)
                // pocket now, so it inverts to white like the Home wordmark.
                filter: t.dark ? "invert(1)" : "none",
              }}
            />
            <h1
              style={{
                ...text.screenTitle,
                color: t.text,
                margin: `${space.gutter}px 0 ${space.xs}px`,
              }}
            >
              Welcome back
            </h1>
            {/* "Locked" was the old heading. It is a state, not a greeting, and
                it read as an error on a screen that is simply the front door. */}
            <p style={{ ...text.body, color: t.sub, margin: 0 }}>
              Enter your password to unlock Pocket.
            </p>
            {/* a wallet that locked ITSELF mid-task used to reappear as a bare
                password prompt: the screen the user was on was gone, anything
                they had typed was cleared, and nothing on screen said either had
                happened or why. the minutes come from `status`, so the sentence
                cannot drift from the setting. */}
            {w.autoLocked && (
              <p style={{ ...text.body, color: t.sub, margin: `${space.xs}px 0 0` }}>
                {`Pocket locked itself after ${minutes} ${minutes === 1 ? "minute" : "minutes"} of inactivity, so anything you had typed was cleared.`}
              </p>
            )}
          </div>

          <div style={{ marginTop: space.xl }}>
            {/* The form sits on its own surface. Without it the field and the
                button float on the cover with nothing holding them, and the
                dot field reads straight through the input. */}
            <div
              style={{
                background: t.surface,
                borderRadius: radius.xl,
                // a hairline pairs with the shadow so the card reads as a deliberate
                // panel rather than a white blob floating on the wash.
                border: `1px solid ${t.line}`,
                // narrows with the frame: at 160px a fixed 16px each side is 32px
                // of the 124px available, taken from the one control that needs it.
                padding: "clamp(6px, 4vw, 16px)",
                boxShadow: t.shadow,
              }}
            >
              <Field
                t={t}
                label="Password"
                type={reveal ? "text" : "password"}
                value={password}
                onChange={setPassword}
                autoFocus
                trailing={
                  <button
                    type="button"
                    onClick={() => setReveal((v) => !v)}
                    aria-label={reveal ? "Hide password" : "Show password"}
                    aria-pressed={reveal}
                    style={{
                      all: "unset",
                      boxSizing: "border-box",
                      cursor: "pointer",
                      color: t.sub,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      // 44px so it is a real target, not a glyph you aim at.
                      minWidth: 44,
                      minHeight: 44,
                      borderRadius: radius.sm,
                    }}
                  >
                    {reveal ? <EyeOff size={20} /> : <Eye size={20} />}
                  </button>
                }
              />
              {/* AFTER the field, which is where every other password form in this
                  product puts it, and where the eye already is. above the card it
                  landed 95px from the field and pushed the field and the button
                  down 27px as it appeared, so the second attempt began by moving
                  the target: measured at 384x600, the input went 329 -> 356 and
                  the button 391 -> 418. this is also the one screen that clears
                  the field on failure, so a second attempt is guaranteed. */}
              {error && (
                <Notice t={t} tone="danger">
                  {error}
                </Notice>
              )}
              <Button t={t} type="submit" disabled={!password} busy={busy}>
                {busy ? "Unlocking" : "Unlock"}
              </Button>
            </div>
            <div style={{ textAlign: "center", marginTop: space.md }}>
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
