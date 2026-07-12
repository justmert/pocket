import { useEffect, useState } from "react";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Notice, Screen, TextButton } from "../primitives";
import { clearOnboardingUnfinished, markOnboardingUnfinished } from "../onboardingTab";
import { Eye } from "../icons";
import { Brand } from "../Brand";
import { fonts, radius, space, text, type Theme } from "../theme";

type Step = "choose" | "create" | "backup" | "import";

export function Onboarding({
  t,
  onDone,
  /**
   * true when this flow is running somewhere that closes on blur.
   *
   * onboarding normally moves itself to a tab first, so this is false. it is not
   * cosmetic when it is true: it changes what the phrase screen promises.
   */
  ephemeral = false,
}: {
  t: Theme;
  onDone: () => void;
  ephemeral?: boolean;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [mnemonic, setMnemonic] = useState("");

  if (step === "backup")
    return <Backup t={t} mnemonic={mnemonic} onDone={onDone} ephemeral={ephemeral} />;

  return (
    <Screen t={t}>
      <div style={{ paddingTop: space.md, textAlign: "center", marginBottom: space.xl }}>
        <Brand t={t} size={64} />
        <h1
          style={{
            ...text.screenTitle,
            color: t.text,
            margin: `${space.gutter}px 0 ${space.xs}px`,
          }}
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
        Pocket hides <strong>amounts</strong>, not addresses. Who you pay stays public on the
        ledger.
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
      // the vault is on disk now and every other window will say so. mark the
      // flow unfinished before the words are drawn, so a second window raises
      // this one instead of presenting a wallet the user has not backed up.
      await markOnboardingUnfinished();
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
 * three things guard it, and each closes a way the phrase was being lost:
 *
 * the words start hidden, because they appeared unannounced in whatever room
 * the user was in and could not be shown again, so the user had to leave them
 * up for a minute rather than choose the moment;
 *
 * the acknowledgement is a question, not a press. it used to be a plain primary
 * button in the same screen position as the previous screen's primary button,
 * which meant a double press on a slow vault creation consumed it and the
 * phrase was gone;
 *
 * and the copy no longer says the phrase is gone after this. it said "Pocket
 * cannot show them to you again", on this screen, on the verify step and in the
 * other window's notice, and Settings has carried a "Recovery phrase" row behind
 * the password for some time. The sentence errs on the safe side, which is why
 * it survived, but it is still false and it is false about the one thing a user
 * cannot check: someone who loses the paper and believes the words are
 * unrecoverable concludes their funds are gone while the phrase sits two taps
 * away. Urgency is carried by "write them down now" instead, which is true.
 *
 * the ordinal is unselectable and each word carries a trailing space, so a drag
 * selection and the copy button both produce a phrase that restores.
 */
function Backup({
  t,
  mnemonic,
  onDone,
  ephemeral,
}: {
  t: Theme;
  mnemonic: string;
  onDone: () => void;
  ephemeral: boolean;
}) {
  const [shown, setShown] = useState(false);
  const [checking, setChecking] = useState(false);

  // the phrase exists in this component and nowhere else.
  //
  // `create` installs the vault before these words are ever drawn, so by now the
  // wallet is complete on disk and opens tomorrow whether or not anyone wrote
  // them down. moving onboarding to a tab closed the ACCIDENT of losing the
  // window to a blur; it does not close ctrl+w, a middle-click on the tab strip,
  // "close tabs to the right", quitting the browser for the night, or a crash.
  // every one of those is the same total loss, and none of them is a decision
  // about the phrase.
  //
  // chrome's own "leave site?" dialog is not the wallet's words, and it cannot
  // be made to be. what it does is convert an accidental close into a deliberate
  // one, which is exactly the line the escalation draws: what remains open is
  // the user who chooses to walk away, not the user whose hand slipped.
  useEffect(() => {
    const hold = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", hold);
    return () => window.removeEventListener("beforeunload", hold);
  }, []);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");
  const words = mnemonic.split(" ");

  useEffect(() => {
    if (copy === "idle") return;
    const id = setTimeout(() => setCopy("idle"), 2500);
    return () => clearTimeout(id);
  }, [copy]);

  if (checking) {
    return <Verify t={t} words={words} onBack={() => setChecking(false)} onDone={onDone} />;
  }

  return (
    <Screen t={t} still>
      <h1 style={{ ...text.screenTitle, color: t.text, margin: `${space.sm}px 0 ${space.sm}px` }}>
        Write this down
      </h1>
      <Notice t={t} tone="exposed">
        These {words.length} words are the only way to recover this wallet. Anyone who has them owns
        your funds. Write them down now
        {/* the flow runs in a tab precisely so the popup's warning is not true
            here. but the replacement promised more than the platform delivers:
            "this page stays open" is true of a blur and of nothing else, and a
            user who reads it as "the words are safe while i find a pen" has been
            told the opposite of what they need. so the tab branch names what the
            user must not do rather than what the page will do. */}
        {ephemeral
          ? ", and this window closes the moment you click anything outside it."
          : ". Do not close this tab until you have confirmed the words."}
      </Notice>

      <div style={{ position: "relative", marginBottom: space.md }}>
        <div
          aria-hidden={!shown}
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(88px, 1fr))",
            gap: space.xs,
            background: t.field,
            padding: space.md,
            borderRadius: radius.lg,
            filter: shown ? undefined : "blur(7px)",
            userSelect: shown ? undefined : "none",
          }}
        >
          {words.map((word, i) => (
            <span
              key={i}
              style={{
                ...text.body,
                fontFamily: fonts.mono,
                fontWeight: 500,
                color: t.text,
                display: "flex",
                gap: 6,
              }}
            >
              <span style={{ color: t.faint, userSelect: "none" }}>{i + 1}.</span> {word}{" "}
            </span>
          ))}
        </div>

        {!shown && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <button
              type="button"
              onClick={() => setShown(true)}
              style={{
                ...text.button,
                boxSizing: "border-box",
                cursor: "pointer",
                border: `1px solid ${t.line}`,
                background: t.surface,
                color: t.text,
                borderRadius: radius.pill,
                padding: `12px ${space.gutter}px`,
                display: "inline-flex",
                alignItems: "center",
                gap: space.sm,
              }}
            >
              <Eye size={18} />
              Show the phrase
            </button>
          </div>
        )}
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
          disabled={!shown}
          onClick={() =>
            void navigator.clipboard.writeText(mnemonic).then(
              () => setCopy("done"),
              () => setCopy("failed"),
            )
          }
        >
          {copy === "done" ? "Copied" : "Copy the phrase"}
        </Button>
        <Button t={t} disabled={!shown} onClick={() => setChecking(true)}>
          I have written it down
        </Button>
      </ButtonStack>
    </Screen>
  );
}

/**
 * the acknowledgement, asked rather than pressed.
 *
 * three ordinals chosen once per mount. the phrase is already in this
 * component's parent, so nothing crosses the trust boundary and nothing is
 * asked of the worker.
 */
function Verify({
  t,
  words,
  onBack,
  onDone,
}: {
  t: Theme;
  words: string[];
  onBack: () => void;
  onDone: () => void;
}) {
  const [asked] = useState(() => pickThree(words.length));
  const [given, setGiven] = useState<string[]>(["", "", ""]);
  const [wrong, setWrong] = useState(false);

  const correct = asked.every((n, i) => given[i]!.trim().toLowerCase() === words[n]);

  return (
    <Screen t={t} still>
      <h1 style={{ ...text.screenTitle, color: t.text, margin: `${space.sm}px 0 ${space.sm}px` }}>
        Check what you wrote
      </h1>
      <p style={{ ...text.body, color: t.sub, margin: `0 0 ${space.gutter}px`, lineHeight: 1.5 }}>
        Three words from the phrase you just wrote down, so the copy you made is checked against
        the real one before you rely on it.
      </p>

      {asked.map((n, i) => (
        <Field
          key={n}
          t={t}
          label={`Word ${n + 1}`}
          value={given[i]!}
          mono
          autoFocus={i === 0}
          onChange={(v) => {
            setWrong(false);
            setGiven((g) => g.map((old, j) => (j === i ? v : old)));
          }}
        />
      ))}

      {wrong && (
        <Notice t={t} tone="danger">
          That does not match what Pocket generated. Go back and read the phrase again.
        </Notice>
      )}

      <ButtonStack>
        <Button
          t={t}
          onClick={() => {
            if (correct) {
              // the words are confirmed: this is the first moment the wallet is
              // genuinely finished, and the only one at which another window may
              // say so.
              void clearOnboardingUnfinished().then(onDone);
            } else setWrong(true);
          }}
        >
          Confirm
        </Button>
        <Button t={t} variant="quiet" onClick={onBack}>
          Show me the phrase again
        </Button>
      </ButtonStack>
    </Screen>
  );
}

/** three distinct ordinals, in order, from a phrase of `n` words. */
function pickThree(n: number): number[] {
  const out = new Set<number>();
  while (out.size < 3) out.add(Math.floor(Math.random() * n));
  return [...out].sort((a, b) => a - b);
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
      <Notice t={t}>This password unlocks this device. It is not a backup.</Notice>
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
