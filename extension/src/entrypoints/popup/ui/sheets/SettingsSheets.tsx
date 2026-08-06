import { useEffect, useRef, useState } from "react";
import { useWallet } from "../WalletProvider";
import { call } from "../rpc";
import {
  Button,
  ButtonRow,
  ButtonStack,
  Chip,
  Field,
  Notice,
  Row,
  Sheet,
  Skeleton,
  Spinner,
} from "../primitives";
import { Check, External, Lock, Trash } from "../icons";
import { InfoTip } from "../Tooltip";
import { fontSizes, COPY_HOLD_MS, fonts, radius, space, text } from "../theme";
import { privateLossAfterErase, archiveReadiness, canRebuild } from "../copy";
import type { NetworkId } from "../../../../core/config";

const NETWORKS: { id: NetworkId; label: string }[] = [
  { id: "testnet", label: "Testnet" },
  { id: "mainnet", label: "Mainnet" },
];

export function NetworkSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<NetworkId | null>(null);

  const choose = async (network: NetworkId) => {
    if (network === w.status?.network) return;
    setBusy(network);
    setError(null);
    try {
      await call({ type: "setNetwork", network });
      await w.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet
      t={t}
      open={open}
      onClose={onClose}
      title="Network"
      info={
        <InfoTip t={t} label="About switching networks">
          A private pocket belongs to one deployment. Switching networks means setting one up again.
        </InfoTip>
      }
    >
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      {NETWORKS.map((n, i) => {
        // mainnet always refuses (the controller throws for it), so it was a live
        // row whose only outcome was an error, on the ONE surface that tells a
        // user this build is testnet-only, and only after they pressed it. `Row`
        // carries `tone: "inert"` documented for exactly this: present, explained,
        // not pressable. the chip is what says why, in the value slot where the
        // live row shows its tick.
        const usable = n.id === "testnet";
        return (
          <Row
            key={n.id}
            t={t}
            index={i}
            tone={usable ? "plain" : "inert"}
            icon={<External size={19} />}
            title={n.label}
            value={
              !usable ? (
                <Chip t={t}>Soon</Chip>
              ) : w.status?.network === n.id ? (
                <Check size={19} sw={2.4} />
              ) : busy === n.id ? (
                // an action in progress reads as motion, not as an absent value:
                // Skeleton is reserved for "this has not arrived yet".
                <Spinner size={17} color={t.accent} />
              ) : undefined
            }
            {...(usable ? { onClick: () => void choose(n.id) } : {})}
          />
        );
      })}
    </Sheet>
  );
}

/**
 * The idle-lock windows on offer. Bounded on both ends, no "never": a funded
 * wallet that never idle-locks is the one thing this timer exists to prevent, and
 * the controller clamps to 1 minute .. 8 hours regardless of what is sent.
 */
const AUTO_LOCK_OPTIONS: { minutes: number; label: string }[] = [
  { minutes: 1, label: "1 minute" },
  { minutes: 5, label: "5 minutes" },
  { minutes: 15, label: "15 minutes" },
  { minutes: 30, label: "30 minutes" },
  { minutes: 60, label: "1 hour" },
  { minutes: 240, label: "4 hours" },
  { minutes: 480, label: "8 hours" },
];

/** The current window in words, for the Settings row and anywhere else. */
export function autoLockLabel(minutes: number | undefined): string {
  if (minutes == null) return "…";
  const opt = AUTO_LOCK_OPTIONS.find((o) => o.minutes === minutes);
  if (opt) return opt.label;
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function AutoLockSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const current = w.status?.autoLockMinutes;

  const choose = async (minutes: number) => {
    if (minutes === current) {
      onClose();
      return;
    }
    setBusy(minutes);
    setError(null);
    try {
      await call({ type: "setAutoLock", minutes });
      await w.refresh();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Auto-lock">
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      {AUTO_LOCK_OPTIONS.map((o, i) => (
        <Row
          key={o.minutes}
          t={t}
          index={i}
          icon={<Lock size={19} />}
          title={o.label}
          value={
            current === o.minutes ? (
              <Check size={19} sw={2.4} />
            ) : busy === o.minutes ? (
              // an action in progress reads as motion, not as an absent value:
              // Skeleton is reserved for "this has not arrived yet".
              <Spinner size={17} color={t.accent} />
            ) : undefined
          }
          onClick={() => void choose(o.minutes)}
        />
      ))}
    </Sheet>
  );
}

export function ConnectionsSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [sessions, setSessions] = useState<{ origin: string; connectedAt: number }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setSessions(await call({ type: "dappSessions" }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (open) void load();
  }, [open]);

  const disconnect = async (origin: string) => {
    try {
      await call({ type: "disconnectDapp", origin });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Connected sites">
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      {/* the skeleton is for a read still in FLIGHT. with an error already drawn
          above it, this rendered both at once and then shimmered forever, because
          `sessions` stays null on a failure. the correct guard exists twice
          elsewhere (`ManageAssets`, `ChooseAsset`); this is that guard. */}
      {sessions === null && !error ? (
        <Skeleton width="100%" height={44} />
      ) : sessions === null ? null : sessions.length === 0 ? (
        <div style={{ ...text.body, color: t.sub, lineHeight: 1.5 }}>No sites connected.</div>
      ) : (
        sessions.map((s, i) => (
          <Row
            key={s.origin}
            t={t}
            index={i}
            title={s.origin}
            value={<Trash size={17} />}
            tone="danger"
            onClick={() => void disconnect(s.origin)}
          />
        ))
      )}
    </Sheet>
  );
}

export function RebuildSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      // a settings-level rebuild restores the WHOLE private pocket, so it replays
      // every configured asset in turn, not just the primary. one asset (or an
      // older worker) takes the plain call and behaves exactly as before.
      const assets = w.status?.privateAssets ?? [];
      if (assets.length > 1) {
        for (const a of assets) {
          await call({ type: "rebuildFromHistory", asset: a.token });
        }
      } else {
        await call({ type: "rebuildFromHistory" });
      }
      await w.refresh();
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Rebuild from history">
      {error && (
        <Notice t={t} tone="danger">
          {error}
        </Notice>
      )}
      {done && (
        <Notice t={t} tone="positive">
          Rebuilt from history.
        </Notice>
      )}
      <ButtonStack>
        {done ? (
          // the replay is finished; the button both marks that and offers the way
          // out, rather than staying live and inviting a pointless second run.
          <Button t={t} variant="quiet" onClick={onClose}>
            Done
          </Button>
        ) : (
          <Button t={t} busy={busy} onClick={() => void run()}>
            {busy ? "Replaying your history" : "Rebuild"}
          </Button>
        )}
      </ButtonStack>
    </Sheet>
  );
}

export function EraseSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  // the same sentence the locked screen's erase door says, read from the same
  // place, because these two doors reach the same irreversible act.
  const network = w.status?.network ?? "testnet";
  const [password, setPassword] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What the archive actually reports, read when the sheet OPENS rather than at
  // render: it is a network call, and the answer only means anything at the
  // moment the user is deciding.
  const [readiness, setReadiness] = useState<{ ok: boolean; sentence: string } | null>(null);

  // clear everything the moment the sheet closes, exactly as PhraseSheet does.
  //
  // `Sheet` unmounts its own subtree when it closes, but this state does not
  // live there: it lives here, in the component App renders unconditionally, so
  // closing the sheet left the vault password sitting in a useState cell and
  // `confirmed` still true. Reopening then skipped the first step entirely and
  // arrived with the field pre-filled and focused, one Enter from
  // erasing the wallet. The two-step gate exists precisely because this is the
  // one irreversible act in the product, and it was only ever asked once.
  // the same opening generation PhraseSheet keeps, for the same reason: the reset
  // below is an await away from landing, and a result that arrives after the
  // sheet has closed would repopulate state the close had just cleared.
  const opening = useRef(0);

  useEffect(() => {
    if (open) return;
    opening.current++;
    setPassword("");
    setConfirmed(false);
    setBusy(false);
    setError(null);
    setReadiness(null);
  }, [open]);

  useEffect(() => {
    if (!open || !canRebuild(network)) return;
    let live = true;
    void call({ type: "archiveReadiness" })
      .then((r) => {
        if (live) setReadiness(archiveReadiness(r.reachable ? r : null, r.chainLedger));
      })
      .catch(() => {
        // A failure IS the answer here, and it is the one that matters most.
        if (live) setReadiness(archiveReadiness(null, null));
      });
    return () => {
      live = false;
    };
  }, [open, network]);

  const run = async () => {
    if (!password || busy) return;
    const mine = opening.current;
    setBusy(true);
    setError(null);
    try {
      await call({ type: "reset", password });
      // `refresh`, NOT `reloadStatus`. everything that forgets the popup's own
      // memory of the erased wallet (the address book, the mask, the watched
      // ops, the balances) lives inside `refresh`'s `!next.initialised` branch,
      // and `reloadStatus` is four lines that do not run it. it mattered on the
      // real path: in the recorded `stuck` window state, onboarding runs in THIS
      // document, so the previous owner's saved recipients were offered as chips
      // to the wallet created next.
      await w.refresh();
      onClose();
    } catch (e) {
      if (opening.current !== mine) return;
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Sheet t={t} open={open} onClose={onClose} title="Erase this wallet">
      <Notice t={t} tone="danger">
        This removes the wallet from this device. Without your recovery phrase it cannot come back.
      </Notice>

      {!confirmed ? (
        <>
          {/* both halves. this screen stated only what is LOST, and read as
              though erasing loses everything: the public balance is on the
              ledger and the phrase brings it back on any wallet, which is the
              fact the decision is actually made on. the private half is the
              only one that does not survive. */}
          <div
            style={{
              ...text.body,
              color: t.text,
              lineHeight: 1.55,
              marginBottom: space.sm,
            }}
          >
            Your public balance is on the ledger. Your recovery phrase brings it back on any wallet.
          </div>
          <div
            style={{
              ...text.body,
              color: t.text,
              lineHeight: 1.55,
              marginBottom: space.sm,
            }}
          >
            {privateLossAfterErase(network)}
          </div>
          {/* what the archive ACTUALLY reports, read live. the line above
              states a dependency and this is the only thing that can say
              whether it holds: a configured URL is not a reachable archive,
              and a reachable one is not a current one. all three end the same
              way, with the rebuild refusing after the keys are gone. ready is a
              tick chip rather than a sentence: on the normal path it is saying
              that nothing changes. */}
          {canRebuild(network) && (
            <div
              style={{ ...text.body, color: t.danger, lineHeight: 1.55, marginBottom: space.md }}
            >
              {readiness === null ? (
                <Skeleton width="100%" height={16} />
              ) : readiness.ok ? (
                <Chip t={t}>
                  <Check size={13} sw={2.6} />
                  {readiness.sentence}
                </Chip>
              ) : (
                readiness.sentence
              )}
            </div>
          )}
          <ButtonStack>
            {/* the safe exit is the recommended action on a destructive confirm,
                so it carries the primary weight, matching the erase-and-recover
                door so two paths to the same act do not disagree on emphasis. */}
            <Button t={t} variant="primary" onClick={onClose}>
              Keep this wallet
            </Button>
            <Button t={t} variant="danger" onClick={() => setConfirmed(true)}>
              I understand, continue
            </Button>
          </ButtonStack>
        </>
      ) : (
        <>
          <Field
            t={t}
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoFocus
            onSubmit={() => void run()}
          />
          {error && (
            <Notice t={t} tone="danger">
              {error}
            </Notice>
          )}
          <ButtonStack>
            <Button
              t={t}
              variant="danger"
              disabled={!password}
              busy={busy}
              onClick={() => void run()}
            >
              {busy ? "Erasing" : "Erase this wallet"}
            </Button>
            <Button t={t} variant="quiet" onClick={onClose}>
              Cancel
            </Button>
          </ButtonStack>
        </>
      )}
    </Sheet>
  );
}

/**
 * Show the recovery phrase again, password-gated.
 *
 * The phrase IS the seed, so the door is the password and not merely the lock:
 * an unlocked wallet still has to prove it to see its own words. The controller
 * re-derives the DEK from the password on every reveal (`revealPhrase`), and a
 * locked wallet refuses the request outright, so an idle-locked screen left open
 * cannot be talked into showing the words.
 *
 * The words are fetched only after the password clears, live in this component
 * and nowhere else, and are dropped the instant the sheet closes: the secrets
 * sweep reads DOM values and the accessibility tree whether or not a sheet is
 * visible, so a mounted-but-hidden sheet must hold nothing. `still` because the
 * reader is reading secret material and nothing should move under their eyes.
 */
export function PhraseSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const w = useWallet();
  const t = w.t;
  const [password, setPassword] = useState("");
  const [mnemonic, setMnemonic] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copy, setCopy] = useState<"idle" | "done" | "failed">("idle");

  // which OPENING of the sheet a reveal belongs to.
  //
  // the reset below runs on close, but `reveal` is an await away from landing:
  // close the sheet while the button still reads "Checking" and the reset runs
  // first, the phrase resolves into state after it, and because `Shell` mounts
  // this sheet unconditionally that state survives the close. the next open found
  // `mnemonic !== null` and drew the twenty-four words with no password step at
  // all. the window is the scrypt cost this sheet exists to spend (`KDF_PARAMS`
  // is measured at ~250ms) plus a message round trip, which is exactly what the
  // "Checking" state is there to cover.
  const opening = useRef(0);

  // clear everything the moment the sheet closes. the phrase, and the password
  // that unlocked it, must not survive in a hidden-but-mounted sheet.
  useEffect(() => {
    if (open) return;
    opening.current++;
    setPassword("");
    setMnemonic(null);
    setBusy(false);
    setError(null);
    setCopy("idle");
  }, [open]);

  // the "Copied" echo is transient, like every other copy affordance here.
  useEffect(() => {
    if (copy === "idle") return;
    const id = setTimeout(() => setCopy("idle"), COPY_HOLD_MS);
    return () => clearTimeout(id);
  }, [copy]);

  const reveal = async () => {
    if (!password || busy) return;
    const mine = opening.current;
    setBusy(true);
    setError(null);
    try {
      const phrase = await call({ type: "revealPhrase", password });
      // the sheet was closed while this was in flight, so this answer belongs to
      // an opening that is over. dropping it is the whole guard: setting it here
      // is what let the next open show the words ungated.
      if (opening.current !== mine) return;
      setMnemonic(phrase);
      // the password has done its job; drop it rather than leave it in a field,
      // where it is itself a needle the secrets sweep hunts for.
      setPassword("");
    } catch (e) {
      if (opening.current !== mine) return;
      setError(e instanceof Error ? e.message : String(e));
      setPassword("");
    } finally {
      if (opening.current === mine) setBusy(false);
    }
  };

  const words = mnemonic ? mnemonic.split(" ") : [];

  return (
    <Sheet
      t={t}
      open={open}
      onClose={onClose}
      title="Recovery phrase"
      still
      focusKey={mnemonic ? "shown" : "gate"}
    >
      {mnemonic === null ? (
        <>
          {/* plain intro copy, not a boxed Notice: this is the calm setup, and the
              boxed warning is saved for the reveal step where the words are on
              screen. a filled panel here read as an alert before anything was
              shown. */}
          <div style={{ ...text.body, color: t.sub, lineHeight: 1.5, marginBottom: space.md }}>
            Anyone who reads your phrase can take your funds.
          </div>
          <Field
            t={t}
            label="Password"
            type="password"
            value={password}
            onChange={setPassword}
            autoFocus
            onSubmit={() => void reveal()}
          />
          {error && (
            <Notice t={t} tone="danger">
              {error}
            </Notice>
          )}
          <ButtonStack>
            <Button t={t} disabled={!password} busy={busy} onClick={() => void reveal()}>
              {busy ? "Checking" : "Show recovery phrase"}
            </Button>
            <Button t={t} variant="quiet" onClick={onClose}>
              Cancel
            </Button>
          </ButtonStack>
        </>
      ) : (
        <>
          {/* plain prose, not a boxed Notice: the words are already on screen in
              the grid below, so the warning reads beside them rather than a filled
              panel competing with them for the eye. */}
          <div style={{ ...text.body, color: t.sub, lineHeight: 1.5, marginBottom: space.md }}>
            Write these {words.length} words down and keep them offline. Never hand them to anyone,
            Pocket included.
          </div>
          {/* the same numbered mono grid the onboarding backup screen draws, so a
              user re-reads their phrase in exactly the shape they first saw it.
              each word carries a trailing space so a drag-select or copy yields a
              restorable phrase, and the ordinal is not selectable. */}
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
                style={{
                  ...text.body,
                  // the ONE string in the product a user copies out by hand onto
                  // paper, at the prose size (14) while an address at a confirm
                  // step is 16. D4 set that 16 for a string read character by
                  // character before an irreversible act, and this is the same
                  // kind of reading with a worse failure: a phrase transcribed
                  // wrong is a wallet that never comes back.
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
          {copy === "failed" && (
            <Notice t={t} tone="danger">
              Copy failed. Select the words instead.
            </Notice>
          )}
          {/* copy and done side by side: the same quiet+primary pair every confirm
              screen uses, so copy reads as the secondary option next to the primary
              rather than a washed pill stacked directly under it. */}
          <ButtonRow>
            {/* only writes on an explicit press, and nothing auto-copies: the
                secrets sweep asserts the clipboard is clean when nobody asked. */}
            <Button
              t={t}
              variant="quiet"
              onClick={() =>
                void navigator.clipboard.writeText(words.join(" ")).then(
                  () => setCopy("done"),
                  () => setCopy("failed"),
                )
              }
            >
              {copy === "done" ? "Copied" : "Copy the phrase"}
            </Button>
            <Button t={t} onClick={onClose}>
              Done
            </Button>
          </ButtonRow>
        </>
      )}
    </Sheet>
  );
}
