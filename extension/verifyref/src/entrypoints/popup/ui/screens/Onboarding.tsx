import { useEffect, useState } from "react";
import { call } from "../rpc";
import { Button, ButtonStack, Content, Field, Frame, Header, Notice } from "../primitives";
import { leading, mono, radius, space, text, type Theme } from "../theme";

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

  // The same two rules as the erase-and-restore screen, stated the same way.
  // A disabled button that will not say what it is waiting for is the defect,
  // not the rule.
  const short = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && password !== confirm;

  return (
    <Frame t={t}>
      <Header title="Pocket" t={t} />
      <Content>
        {step === "choose" && (
          <>
            <p style={{ ...text.body, color: t.sub, lineHeight: leading.normal, marginTop: 0 }}>
              A Stellar wallet with two pockets. One public, one private.
            </p>
            <Notice t={t}>
              Pocket hides <strong>amounts</strong>, not addresses. Who you pay stays public on the
              ledger, always.
            </Notice>
            <ButtonStack>
              <Button t={t} onClick={() => setStep("create")}>
                Create a new wallet
              </Button>
              <Button t={t} variant="quiet" onClick={() => setStep("import")}>
                I have a recovery phrase
              </Button>
            </ButtonStack>
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
            {short && <Notice t={t}>Use at least eight characters.</Notice>}
            {mismatch && <Notice t={t}>The two passwords do not match.</Notice>}
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

        {step === "backup" && <Backup t={t} mnemonic={mnemonic} onDone={onDone} />}

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
            {short && <Notice t={t}>Use at least eight characters.</Notice>}
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
      </Content>
    </Frame>
  );
}

/**
 * The one time the recovery phrase is ever on screen.
 *
 * What the user takes away from here has to be a phrase that restores the
 * wallet. It did not used to be: the numbers were part of the same text as the
 * words and the cells carried no whitespace, so copying the block produced
 * "1. elevator2. surround3. noble", which fails BIP-39 validation on the first
 * token and cannot be pasted into the import field. The phrase is shown once,
 * so nobody would have found out until the day they needed it.
 *
 * Two paths now produce the same 24 words separated by single spaces: the copy
 * button, and an ordinary drag-select, because each number is marked
 * unselectable and each cell ends in a space.
 */
function Backup({ t, mnemonic, onDone }: { t: Theme; mnemonic: string; onDone: () => void }) {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");

  useEffect(() => {
    if (copied === "idle") return;
    const id = setTimeout(() => setCopied("idle"), 2500);
    return () => clearTimeout(id);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard.writeText(mnemonic).then(
      () => setCopied("done"),
      () => setCopied("failed"),
    );
  };

  return (
    <>
      <div style={{ ...text.title, marginBottom: space.md }}>Write this down</div>
      <Notice tone="exposed" t={t}>
        These 24 words are the only way to recover your wallet. Anyone who has them owns your funds.
        Pocket cannot show them to you again.
      </Notice>
      <div
        style={{
          display: "grid",
          // `auto-fit` with a floor, not a fixed three. This is the screen
          // that is shown ONCE and never again, and below about 210px the
          // three fixed columns ran the words into each other and cut the last
          // one off. A user copying by eye from a clipped grid writes down a
          // phrase that does not work, and finds out when they need it.
          gridTemplateColumns: "repeat(auto-fit, minmax(84px, 1fr))",
          rowGap: space.xs,
          fontFamily: mono,
          fontSize: 13,
          background: t.field,
          border: `1px solid ${t.line}`,
          borderRadius: radius.md,
          padding: space.md,
          marginBottom: space.lg,
          userSelect: "text",
        }}
      >
        {mnemonic.split(" ").map((w, i) => (
          // The trailing space is what separates the words in a copied
          // selection; the number is excluded from one.
          <span key={i}>
            <span style={{ color: t.faint, userSelect: "none" }}>{i + 1}.</span> {w}{" "}
          </span>
        ))}
      </div>
      {copied === "failed" && (
        <Notice tone="danger" t={t}>
          Could not reach the clipboard. Select the words above, or write them down.
        </Notice>
      )}
      <ButtonStack>
        <Button t={t} variant="quiet" onClick={copy}>
          {copied === "done" ? "Copied" : "Copy the phrase"}
        </Button>
        <Button t={t} onClick={onDone}>
          I have written it down
        </Button>
      </ButtonStack>
    </>
  );
}
