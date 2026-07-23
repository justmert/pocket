import { useEffect, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import { call } from "../rpc";
import { Button, ButtonStack, Field, Notice, Screen, TextButton } from "../primitives";
import { clearOnboardingUnfinished, markOnboardingUnfinished } from "../onboardingTab";
import { Check, Eye } from "../icons";
import { Logo } from "../Brand";
import { fontSizes, COPY_HOLD_MS, fonts, radius, space, text, theme, type Theme } from "../theme";

type Step = "choose" | "create" | "backup" | "import" | "ready";

export function Onboarding({
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
  // onboarding wears the PRIVATE pocket's dark, teal identity end to end: it is the
  // front door of a privacy wallet and reads far better dark on a full page than the
  // near-white public surface. the theme the app hands in (public) is ignored here.
  const t = theme("private");
  const [step, setStep] = useState<Step>("choose");
  const [mnemonic, setMnemonic] = useState("");

  // in the TAB (the normal case) onboarding is a full page, not the 384px popup
  // squeezed into a white tab. the ephemeral popup fallback keeps the compact
  // Screen. `finish` is where a completed wallet lands: in the tab it shows the
  // "wallet is ready" screen and leaves the actual wallet to the toolbar popup,
  // rather than routing the tab to Home (which read as "the extension opened in a
  // web page"); in the ephemeral popup it hands back to the app as before.
  const fullPage = !ephemeral;
  const finish = fullPage ? () => setStep("ready") : onDone;

  if (step === "ready") return <Ready t={t} />;
  if (step === "backup")
    return <Backup t={t} mnemonic={mnemonic} onDone={finish} ephemeral={ephemeral} />;

  return (
    <Shell t={t} fullPage={fullPage}>
      <div style={{ textAlign: "center", marginBottom: space.xl }}>
        {fullPage && step === "choose" ? (
          // the front door leads with the real wordmark (packaged, so img-src 'self'
          // allows it) and what the product is FOR, not the small drawn tile and the
          // "two pockets" build detail. that line is a fact for later; this is the promise.
          <>
            {/* big: the tab has the room, and this is the brand's front door. */}
            <Logo t={t} width={320} />
            <h1
              style={{
                ...text.display,
                color: t.text,
                margin: `${space.lg}px 0 ${space.sm}px`,
                lineHeight: 1.15,
                textWrap: "balance",
              }}
            >
              {"Your balance is nobody's business."}
            </h1>
            <p style={{ ...text.heading, color: t.sub, margin: 0, fontWeight: 500 }}>
              So we built one that keeps quiet.
            </p>
          </>
        ) : (
          <>
            <Logo t={t} width={fullPage ? 168 : 120} />
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
          </>
        )}
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
      {step === "import" && <Import t={t} onDone={finish} onCancel={() => setStep("choose")} />}
    </Shell>
  );
}

/**
 * the onboarding tab is a real page, not the popup in a tab.
 *
 * it fills the viewport, paints the pocket's accent wash from the top like the
 * lock screen's cover, and centres the step content in a comfortable column. the
 * ephemeral popup fallback still uses `Screen`; everything routes through `Shell`
 * so a step does not have to know which one it is in.
 */
function FullPage({
  t,
  still = false,
  children,
}: {
  t: Theme;
  /** nothing inside moves while the phrase or a review is being read. */
  still?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={still ? "pocket-still" : undefined}
      style={
        {
          position: "fixed",
          inset: 0,
          overflowY: "auto",
          background: t.bg,
          color: t.text,
          fontFamily: fonts.body,
          // native controls (scrollbar, autofill) in this subtree render dark.
          colorScheme: t.dark ? "dark" : "light",
          // the onboarding subtree wears the private pocket's accent for its
          // CSS-driven interactions (button/field hover, field focus glow), which
          // read a var rather than the inline theme. without these the fields glowed
          // sky while everything else was teal.
          ["--pocket-accent" as string]: t.accent,
          ["--pocket-ring" as string]: t.ring,
          ["--pocket-quiet-hover" as string]: t.tint,
          ["--pocket-placeholder" as string]: t.sub,
        } as CSSProperties
      }
    >
      <div
        aria-hidden
        style={{
          position: "absolute",
          insetInline: 0,
          top: 0,
          height: "48vh",
          pointerEvents: "none",
          background: `radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, ${t.accent} 22%, transparent) 0%, transparent 62%)`,
        }}
      />
      <div
        style={{
          position: "relative",
          minHeight: "100%",
          boxSizing: "border-box",
          padding: `${space.xl * 2}px ${space.gutter}px ${space.xl}px`,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <div style={{ width: "100%", maxWidth: 440 }}>{children}</div>
      </div>
    </div>
  );
}

/** full page in the tab, the compact Screen in the ephemeral popup fallback. */
function Shell({
  t,
  fullPage,
  still = false,
  children,
}: {
  t: Theme;
  fullPage: boolean;
  still?: boolean;
  children: ReactNode;
}) {
  // `still` reaches BOTH branches. it was passed only to `Screen`, so the
  // `fullPage` branch, which is the branch every normal onboarding takes, silently
  // discarded it: the recovery-phrase step and the verify step were the two
  // screens in the product most deliberately frozen, and they were frozen only in
  // the degraded window state.
  return fullPage ? (
    <FullPage t={t} still={still}>
      {children}
    </FullPage>
  ) : (
    <Screen t={t} still={still}>
      {children}
    </Screen>
  );
}

/**
 * the tab's last screen. the wallet itself lives in the toolbar popup, so this
 * does NOT open it here; it says the setup is done and lets the tab close, which
 * is the whole reason onboarding ran in a tab in the first place.
 */
function Ready({ t }: { t: Theme }) {
  return (
    <FullPage t={t}>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        }}
      >
        <div
          style={{
            width: 84,
            height: 84,
            borderRadius: "50%",
            background: t.accentFill,
            color: t.onAccent,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: `0 16px 40px -18px ${t.accent}`,
            marginBottom: space.lg,
          }}
        >
          <Check size={40} sw={2.4} />
        </div>
        <h1 style={{ ...text.display, color: t.text, margin: `0 0 ${space.sm}px` }}>
          Your wallet is ready!
        </h1>
        <p
          style={{
            ...text.body,
            color: t.sub,
            margin: `0 0 ${space.xl}px`,
            lineHeight: 1.5,
            maxWidth: 360,
          }}
        >
          Open Pocket any time from your browser toolbar. You can close this tab now.
        </p>
        <div style={{ width: "100%", maxWidth: 320 }}>
          <ButtonStack>
            <Button
              t={t}
              onClick={() =>
                void chrome.tabs
                  .getCurrent()
                  .then((tab) => (tab?.id != null ? chrome.tabs.remove(tab.id) : undefined))
              }
            >
              Done
            </Button>
          </ButtonStack>
        </div>
      </div>
    </FullPage>
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
    <ButtonStack>
      <Button t={t} onClick={onCreate}>
        Create a new wallet
      </Button>
      <Button t={t} variant="quiet" onClick={onImport}>
        I have a recovery phrase
      </Button>
    </ButtonStack>
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
        <div style={{ textAlign: "center" }}>
          <TextButton t={t} tone="sub" onClick={onCancel}>
            Back
          </TextButton>
        </div>
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
    const id = setTimeout(() => setCopy("idle"), COPY_HOLD_MS);
    return () => clearTimeout(id);
  }, [copy]);

  if (checking) {
    return (
      <Verify
        t={t}
        words={words}
        fullPage={!ephemeral}
        onBack={() => setChecking(false)}
        onDone={onDone}
      />
    );
  }

  return (
    <Shell t={t} fullPage={!ephemeral} still>
      <h1 style={{ ...text.screenTitle, color: t.text, margin: `${space.sm}px 0 ${space.sm}px` }}>
        Save your recovery phrase
      </h1>
      {/* plain text under the heading, not a boxed notice: it reads as the screen's
          own instruction rather than an alert stacked above the words. */}
      <p style={{ ...text.body, color: t.sub, margin: `0 0 ${space.md}px`, lineHeight: 1.5 }}>
        These {words.length} words are the only way to recover this wallet. Anyone who has them owns
        your funds. Write them down now
        {/* the flow runs in a tab precisely so the popup's warning is not true
            here. but the replacement promised more than the platform delivers:
            "this page stays open" is true of a blur and of nothing else, and a
            user who reads it as "the words are safe while i find a pen" has been
            told the opposite of what they need. so the tab branch names what the
            user must not do rather than what the page will do. */}
        {ephemeral
          ? // ". " like the other branch. this joined a warning to an imperative
            // with ", and", which reads as one instruction rather than two facts.
            ". This window closes the moment you click anything outside it."
          : ". Do not close this tab until you have confirmed the words."}
      </p>
      {/* the SAME warnings the Settings sheet gives, on the screen that gives the
          phrase for the first time. "keep them offline", "never type them into a
          website or hand them to anyone, Pocket included" and "only where no one
          is watching" were all on the repeat path and none was here, in front of
          the reader who has never seen twelve words before. */}
      <p style={{ ...text.body, color: t.sub, margin: `0 0 ${space.md}px`, lineHeight: 1.5 }}>
        Keep them offline, and read them only where no one is watching. Never type them into a
        website or hand them to anyone, Pocket included.
      </p>

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
                // the ONE string in the product a user copies out by hand onto
                // paper, and it was set at the prose size (14) while an address at
                // a confirm step is 16. D4 chose that 16 for a string read
                // character by character before an irreversible act; a phrase
                // transcribed wrong is a wallet that never comes back.
                fontSize: fontSizes.body,
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
                // the browser's own chrome, off. this is the one button in the
                // product without the reset, so chrome's UA bevel and default
                // border painted over its fill, on the recovery-phrase step.
                // `primitives.tsx` records the same artefact from experience.
                all: "unset",
                appearance: "none",
                ...text.button,
                boxSizing: "border-box",
                cursor: "pointer",
                background: t.surface,
                color: t.text,
                boxShadow: t.shadow,
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
          {/* what copying actually does, on the control that does it: this puts a
              seed on the system clipboard, where every other application on the
              machine can read it, and the label said only "Copy the phrase". */}
          {copy === "done" ? "Copied" : "Copy to clipboard"}
        </Button>
        <Button t={t} disabled={!shown} onClick={() => setChecking(true)}>
          I have written it down
        </Button>
        {copy === "done" && (
          <div style={{ ...text.caption, color: t.sub, textAlign: "center" }}>
            Your phrase is on this machine&rsquo;s clipboard, where other applications can read it.
            Paste it where you are keeping it, then copy something else.
          </div>
        )}
      </ButtonStack>
    </Shell>
  );
}

/**
 * the acknowledgement, asked rather than pressed.
 *
 * three ordinals chosen once per mount. the phrase is already in this
 * component's parent, so nothing crosses the trust boundary and nothing is
 * asked of the worker.
 */
export function Verify({
  t,
  words,
  fullPage,
  onBack,
  onDone,
}: {
  t: Theme;
  words: string[];
  fullPage: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  // three positions to prove, in order, with the correct words for them shuffled
  // into a pool of chips. placing a chip into a blank checks that the user knows
  // which word sits where, without ever asking them to type the phrase back. the
  // phrase is already in this component's parent, so nothing crosses the trust
  // boundary and nothing is asked of the worker.
  const [asked] = useState(() => pickThree(words.length));
  // The pool held ONLY the three correct words, so the step asked the user to
  // put three chips in an order rather than to know anything: 3! = 6
  // arrangements, unlimited retries, and the answer visible on screen. Someone
  // who had written nothing down was through it in a few taps, and this is the
  // only gate asserting the phrase was written down at all, and the only caller
  // of `clearOnboardingUnfinished`.
  //
  // Decoys come from the SAME phrase, so every chip is plausible and no
  // dictionary is needed. Nine chips choosing three in order is 504
  // arrangements rather than 6, which makes guessing impractical without
  // locking out someone who really did write it down. Retries stay unlimited
  // for exactly that reason: a limit here would strand a user who has the paper
  // in front of them and mistyped.
  const [pool] = useState(() => shuffle(withDecoys(words, asked)));
  // per blank (in `asked` order), the POOL INDEX placed there, or null. indices,
  // not words, so a phrase that repeats a word still tracks each chip separately.
  const [placed, setPlaced] = useState<(number | null)[]>(() => asked.map(() => null));
  const [wrong, setWrong] = useState(false);

  const used = new Set(placed.filter((x): x is number => x !== null));
  const nextBlank = placed.indexOf(null);

  const tapChip = (poolIdx: number) => {
    if (used.has(poolIdx) || nextBlank === -1) return;
    setWrong(false);
    setPlaced((p) => p.map((old, i) => (i === nextBlank ? poolIdx : old)));
  };
  const tapBlank = (blankIdx: number) => {
    if (placed[blankIdx] === null) return;
    setWrong(false);
    setPlaced((p) => p.map((old, i) => (i === blankIdx ? null : old)));
  };
  const confirm = () => {
    const ok = asked.every((n, i) => placed[i] !== null && pool[placed[i]!] === words[n]);
    if (ok) void clearOnboardingUnfinished().then(onDone);
    else setWrong(true);
  };

  return (
    <Shell t={t} fullPage={fullPage} still>
      <h1 style={{ ...text.screenTitle, color: t.text, margin: `${space.sm}px 0 ${space.sm}px` }}>
        Confirm your recovery phrase
      </h1>
      <p style={{ ...text.body, color: t.sub, margin: `0 0 ${space.lg}px`, lineHeight: 1.5 }}>
        Select the missing words in the correct order.
      </p>

      {/* the whole phrase with its positions kept: the words you are not proving are
          shown as dots for context, and the three blanks are filled by tapping the
          chips below, in order. */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, 1fr)",
          gap: space.xs,
          marginBottom: space.lg,
        }}
      >
        {words.map((word, n) => {
          const blankIdx = asked.indexOf(n);
          const isBlank = blankIdx !== -1;
          const filled = isBlank && placed[blankIdx] !== null ? pool[placed[blankIdx]!] : null;
          const active = isBlank && blankIdx === nextBlank;
          return (
            <div
              key={n}
              // The browser tier drives this step, and it can only do that if it
              // can tell WHICH position each blank is asking for. Without it the
              // helper has to guess an order, which is how it came to type into
              // fields that no longer existed.
              {...(isBlank ? { "data-testid": "verify-blank", "data-position": n + 1 } : {})}
              onClick={filled != null ? () => tapBlank(blankIdx) : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                minHeight: 42,
                padding: "0 10px",
                borderRadius: radius.md,
                border: `1px solid ${active ? t.accent : t.line}`,
                background: isBlank ? t.field : "transparent",
                cursor: filled != null ? "pointer" : "default",
                overflow: "hidden",
              }}
            >
              <span
                style={{ ...text.rowSub, color: t.faint, userSelect: "none", flex: "0 0 auto" }}
              >
                {n + 1}.
              </span>
              {isBlank ? (
                filled != null ? (
                  <span
                    style={{
                      ...text.rowSub,
                      fontFamily: fonts.mono,
                      // only the 500 cut of DM Mono ships (`main.tsx` imports
                      // `dm-mono/500.css` and nothing else), so 600 made chrome
                      // SYNTHESISE a bold: it smears the glyphs of the face that
                      // was chosen because "a slip between two glyphs loses
                      // money", on the recovery-phrase screen. the same reset is
                      // already written out in `Address.tsx`.
                      fontWeight: 500,
                      color: t.accent,
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                    }}
                  >
                    {filled}
                  </span>
                ) : null
              ) : (
                <span
                  aria-hidden
                  style={{ color: t.faint, letterSpacing: 1.5, overflow: "hidden" }}
                >
                  {"•".repeat(Math.min(Math.max(word.length, 3), 7))}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* the candidate words, shuffled; tapping one drops it into the next blank. */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: space.sm,
          justifyContent: "center",
          marginBottom: space.lg,
        }}
      >
        {pool.map((word, j) => (
          <button
            key={j}
            type="button"
            className="pk-tap"
            disabled={used.has(j)}
            onClick={() => tapChip(j)}
            style={{
              all: "unset",
              boxSizing: "border-box",
              cursor: used.has(j) ? "default" : "pointer",
              ...text.button,
              fontFamily: fonts.mono,
              color: t.accent,
              background: "transparent",
              border: `1px solid ${t.accent}`,
              borderRadius: radius.pill,
              padding: "10px 20px",
              opacity: used.has(j) ? 0.35 : 1,
            }}
          >
            {word}
          </button>
        ))}
      </div>

      {wrong && (
        <Notice t={t} tone="danger">
          That is not the right order. Tap a word to clear it, then try again.
        </Notice>
      )}

      <ButtonStack>
        <Button t={t} disabled={nextBlank !== -1} onClick={confirm}>
          Confirm
        </Button>
        <Button t={t} variant="quiet" onClick={onBack}>
          Show me the phrase again
        </Button>
      </ButtonStack>
    </Shell>
  );
}

/** three distinct ordinals, in order, from a phrase of `n` words. */
function pickThree(n: number): number[] {
  const out = new Set<number>();
  while (out.size < 3) out.add(Math.floor(Math.random() * n));
  return [...out].sort((a, b) => a - b);
}

/** how many chips the pool offers: the three answers plus six decoys. */
export const VERIFY_POOL_SIZE = 9;

/**
 * The three words being asked for, plus decoys from the rest of the phrase.
 *
 * Decoys from the SAME phrase rather than a dictionary: every chip is then a
 * word the user has just been shown, so the step tests which word sits where
 * instead of which words look familiar, and nothing has to be imported.
 *
 * A phrase repeats a word rarely but legally, and two chips reading the same
 * word are indistinguishable to a user, so decoys are chosen by POSITION and
 * then filtered against the answers' TEXT. A short phrase that cannot supply
 * six distinct decoys simply yields a smaller pool rather than looping.
 */
export function withDecoys(words: string[], asked: number[]): string[] {
  const answers = asked.map((n) => words[n]!);
  const taken = new Set(answers);
  const candidates = words.filter((w) => !taken.has(w));
  const decoys: string[] = [];
  for (const w of shuffle(candidates)) {
    if (decoys.length >= VERIFY_POOL_SIZE - answers.length) break;
    if (decoys.includes(w)) continue;
    decoys.push(w);
  }
  return [...answers, ...decoys];
}

/** a shuffled copy (Fisher-Yates), so the chips do not sit in phrase order. */
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = a[i]!;
    a[i] = a[j]!;
    a[j] = tmp;
  }
  return a;
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
          {busy ? "Restoring" : "Restore wallet"}
        </Button>
        <div style={{ textAlign: "center" }}>
          <TextButton t={t} tone="sub" onClick={onCancel}>
            Back
          </TextButton>
        </div>
      </ButtonStack>
    </>
  );
}
