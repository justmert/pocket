// the account mark: a little pocket with a face.
//
// flat, two-tone (a light face + a corner "swoosh" in the pocket colour) with dot
// eyes and a simple mouth, in the Boring-Avatars idiom. it lives in exactly ONE
// place, the top-left of the header, and nowhere else in the product.
//
// the colours are SWAPPED against the surface on purpose: the public pocket (a
// light, sky-accented surface) wears a TEAL avatar, the private pocket (a dark,
// teal-accented surface) wears a SKY avatar, so the mark always pops against its
// own background. the two hex pairs are the theme's own sky/teal ramp stops.
//
// the face REACTS to what the wallet is doing (see `useAvatarReaction`): a
// confirmed transaction, a copy, an in-flight proof, the hide-amounts toggle, and
// so on. every reaction is expressed through the face alone (eyes, mouth, a head
// motion), never a floating icon stuck on it. one-shots cross-fade over the idle
// face and back, so each begins and ends on idle with no snap; held states stay
// until the state ends; hover/press respond to the pointer. the motion classes
// live in style.css and are `!important` so the avatar keeps animating even under
// the app's global reduced-motion rule, which is deliberate here.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useWallet } from "./WalletProvider";
import type { Theme } from "./theme";

export type AvatarReaction =
  | "idle"
  | "confirmed"
  | "sent"
  | "swapped"
  | "shielded"
  | "unshielded"
  | "yield"
  | "unlocked"
  | "switch"
  | "copied"
  | "failed"
  | "working"
  | "refreshing"
  | "hidden";

// public surface -> teal avatar; private surface -> sky avatar. ink is a deep
// tone of the same hue so the eyes/mouth read on the light face.
const PAL = {
  public: { face: "#83c6e2", swoosh: "#0c6c95", ink: "#052a3b" },
  private: { face: "#b8eaff", swoosh: "#00b4ff", ink: "#053349" },
} as const;

type EyeShape = "dot" | "open" | "wide" | "arc" | "down" | "line" | "ast";
type MouthKind = "small" | "smile" | "big" | "worry" | "flat" | "shh";

function eyeShape(cx: number, shape: EyeShape, ink: string): ReactNode {
  switch (shape) {
    case "dot":
      return <ellipse cx={cx} cy={22} rx={1.6} ry={2} fill={ink} />;
    case "open":
      return <ellipse cx={cx} cy={21.9} rx={1.9} ry={2.35} fill={ink} />;
    case "wide":
      return <ellipse cx={cx} cy={21.8} rx={2.2} ry={2.55} fill={ink} />;
    case "arc":
      return (
        <path
          d={`M${cx - 2.2} 22.7 Q${cx} 19.3 ${cx + 2.2} 22.7`}
          fill="none"
          stroke={ink}
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      );
    case "down":
      return (
        <path
          d={`M${cx - 2.2} 21.5 Q${cx} 24.6 ${cx + 2.2} 21.5`}
          fill="none"
          stroke={ink}
          strokeWidth={1.8}
          strokeLinecap="round"
        />
      );
    case "line":
      return <path d={`M${cx - 2} 22 H${cx + 2}`} stroke={ink} strokeWidth={1.9} strokeLinecap="round" />;
    case "ast":
      return (
        <path
          d={`M${cx} 19.6 V24.4 M${cx - 2.2} 20.8 L${cx + 2.2} 23.2 M${cx - 2.2} 23.2 L${cx + 2.2} 20.8`}
          stroke={ink}
          strokeWidth={1.5}
          strokeLinecap="round"
        />
      );
  }
}

function mouth(kind: MouthKind, ink: string): ReactNode {
  switch (kind) {
    case "small":
      return (
        <path d="M19.4 29.6 Q22 31.3 24.6 29.6" fill="none" stroke={ink} strokeWidth={1.7} strokeLinecap="round" />
      );
    case "smile":
      return (
        <path
          d="M18.2 29.4 Q22 32.6 25.8 29.4"
          fill="none"
          stroke={ink}
          strokeWidth={1.9}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "big":
      return <path d="M18.2 29 Q22 30.4 25.8 29 Q24 34 22 34 Q20 34 18.2 29 Z" fill={ink} />;
    case "worry":
      return (
        <path
          d="M18.6 30.6 Q20 29.4 22 30.6 Q24 31.8 25.4 30.6"
          fill="none"
          stroke={ink}
          strokeWidth={1.7}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case "flat":
      return <path d="M19.6 30 H24.4" stroke={ink} strokeWidth={1.7} strokeLinecap="round" />;
    case "shh":
      return <path d="M22 29.3 V31.1" stroke={ink} strokeWidth={2} strokeLinecap="round" />;
  }
}

function Eyes({
  shape,
  ink,
  groupAnim,
  eyeAnim,
}: {
  shape: EyeShape;
  ink: string;
  groupAnim?: string;
  eyeAnim?: string;
}): ReactNode {
  const per = eyeAnim && eyeAnim !== "swap" ? `pk-av-${eyeAnim}` : "";
  const lCls = eyeAnim === "swap" ? "pk-av-swapL" : per;
  const rCls = eyeAnim === "swap" ? "pk-av-swapR" : per;
  return (
    <g className={`pk-av-eyes${groupAnim ? ` pk-av-${groupAnim}` : ""}`}>
      <g className={`pk-av-eye ${lCls}`}>{eyeShape(16.5, shape, ink)}</g>
      <g className={`pk-av-eye ${rCls}`}>{eyeShape(27.5, shape, ink)}</g>
    </g>
  );
}

type Cfg = {
  mode: "idle" | "state" | "once";
  root?: string;
  eyes: EyeShape;
  mouth: MouthKind;
  groupAnim?: string;
  eyeAnim?: string;
};

const CFG: Record<AvatarReaction, Cfg> = {
  idle: { mode: "idle", eyes: "dot", eyeAnim: "blink", mouth: "small" },
  confirmed: { mode: "once", root: "pk-cel", eyes: "arc", mouth: "big" },
  sent: { mode: "once", root: "pk-lean", eyes: "down", mouth: "small" },
  swapped: { mode: "once", eyes: "dot", eyeAnim: "swap", mouth: "small" },
  shielded: { mode: "once", root: "pk-tuck", eyes: "line", mouth: "shh" },
  unshielded: { mode: "once", root: "pk-pop", eyes: "open", groupAnim: "reveal", mouth: "smile" },
  yield: { mode: "once", root: "pk-grow", eyes: "arc", mouth: "small" },
  unlocked: { mode: "once", eyes: "dot", eyeAnim: "wake", mouth: "smile" },
  switch: { mode: "once", root: "pk-flip", eyes: "dot", mouth: "small" },
  copied: { mode: "once", root: "pk-nod", eyes: "dot", mouth: "smile" },
  failed: { mode: "once", root: "pk-shake", eyes: "wide", mouth: "worry" },
  working: { mode: "state", eyes: "dot", groupAnim: "lookLR", mouth: "flat" },
  refreshing: { mode: "state", root: "pk-wobble", eyes: "dot", groupAnim: "swirl", mouth: "small" },
  hidden: { mode: "state", eyes: "ast", eyeAnim: "twk", mouth: "flat" },
};

/**
 * `reaction` picks the face; `nonce` restarts a one-shot when the SAME reaction
 * fires twice (keying the svg forces the CSS animation to replay). Both come from
 * `useAvatarReaction`. `eyesClosed`/other legacy props are gone: the pocket now
 * shows through colour, not a shut-eye.
 */
export function Avatar({
  t,
  size = 44,
  reaction = "idle",
  nonce = 0,
}: {
  t: Theme;
  size?: number;
  reaction?: AvatarReaction;
  nonce?: number;
}) {
  const rawId = useId();
  const clip = "pkav-" + rawId.replace(/[^a-zA-Z0-9-]/g, "");
  const p = t.dark ? PAL.private : PAL.public;
  const cfg = CFG[reaction] ?? CFG.idle;

  const baseG = (
    <g clipPath={`url(#${clip})`}>
      <rect width={44} height={44} fill={p.face} />
      <path d="M0 0 H27 Q11 9 0 27 Z" fill={p.swoosh} />
    </g>
  );

  let content: ReactNode;
  if (cfg.mode === "once") {
    // the reaction cross-fades in over the idle face and back out, so it lands on
    // idle with no snap (see style.css pk-reactFade / pk-restFade, fill: forwards).
    content = (
      <g className={`pk-av${cfg.root ? ` ${cfg.root}` : ""}`}>
        {baseG}
        <g className="pk-av-react">
          <Eyes shape={cfg.eyes} ink={p.ink} groupAnim={cfg.groupAnim} eyeAnim={cfg.eyeAnim} />
          {mouth(cfg.mouth, p.ink)}
        </g>
        <g className="pk-av-rest">
          <Eyes shape="dot" ink={p.ink} />
          {mouth("small", p.ink)}
        </g>
      </g>
    );
  } else {
    content = (
      <g className={`pk-av${cfg.root ? ` ${cfg.root}` : ""}`}>
        {baseG}
        <Eyes shape={cfg.eyes} ink={p.ink} groupAnim={cfg.groupAnim} eyeAnim={cfg.eyeAnim} />
        {mouth(cfg.mouth, p.ink)}
      </g>
    );
  }

  return (
    <span
      aria-hidden
      className="pk-avatar"
      style={{ display: "inline-flex", flex: "0 0 auto", lineHeight: 0, width: size, height: size }}
    >
      <svg
        key={`${reaction}-${nonce}`}
        width={size}
        height={size}
        viewBox="0 0 44 44"
        shapeRendering="geometricPrecision"
        style={{ overflow: "visible" }}
      >
        <defs>
          <clipPath id={clip}>
            <circle cx={22} cy={22} r={22} />
          </clipPath>
        </defs>
        {content}
      </svg>
    </span>
  );
}

function verbReaction(verb: string): AvatarReaction {
  switch (verb) {
    case "Shield":
      return "shielded";
    case "Unshield":
      return "unshielded";
    case "Send":
    case "Send privately":
    case "Bridge": // CCTP send is an outbound bridge
      return "sent";
    case "Swap":
      return "swapped";
    case "Deposit": // a yield deposit
      return "yield";
    default:
      // Withdraw, Claim, Make spendable, Set up private pocket, ...: a plain happy
      // confirmation is the honest fallback for a verb with no dedicated face.
      return "confirmed";
  }
}

/**
 * Derives the avatar's current reaction from wallet state, in one place so the
 * priority is explicit and cannot drift:
 *
 *   input (hover/press, a CSS layer inside Avatar)
 *     > terminal one-shot (a submit that just landed: confirmed / failed / the
 *       op-specific flavour)   -- always shown, overrides a held state
 *     > held state (working / refreshing / hidden)
 *     > flavour one-shot (copied / switch / unlocked)  -- yields to a held state
 *     > idle
 *
 * A one-shot auto-clears after ~1.25s (a touch past the 1.1s animation) back to
 * whatever state is underneath. `nonce` changes on every fire so a repeat of the
 * same reaction replays.
 */
export function useAvatarReaction(): { reaction: AvatarReaction; nonce: number } {
  const w = useWallet();
  const [shot, setShot] = useState<{ r: AvatarReaction; terminal: boolean; nonce: number } | null>(null);
  const nonceRef = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const fire = useCallback((r: AvatarReaction, terminal: boolean) => {
    nonceRef.current += 1;
    setShot({ r, terminal, nonce: nonceRef.current });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setShot(null), 1250);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);

  // wake once when the popup opens (the wallet just came into view).
  useEffect(() => {
    fire("unlocked", false);
  }, [fire]);

  // copied the address
  const prevCopied = useRef(w.copied);
  useEffect(() => {
    if (w.copied && !prevCopied.current) fire("copied", false);
    prevCopied.current = w.copied;
  }, [w.copied, fire]);

  // switched pocket
  const prevPocket = useRef(w.pocket);
  useEffect(() => {
    if (w.pocket !== prevPocket.current) {
      prevPocket.current = w.pocket;
      fire("switch", false);
    }
  }, [w.pocket, fire]);

  // a watched operation reached a terminal status: pick the op-specific reaction.
  // seed the seen-map on first run so pre-existing ops do not fire on mount.
  const seen = useRef<Map<string, string>>(new Map());
  const primed = useRef(false);
  useEffect(() => {
    for (const op of w.backgroundOps) {
      const prev = seen.current.get(op.id);
      if (primed.current && prev !== undefined && prev !== op.status) {
        if (op.status === "done") fire(verbReaction(op.verb), true);
        else if (op.status === "failed") fire("failed", true);
      }
      seen.current.set(op.id, op.status);
    }
    primed.current = true;
  }, [w.backgroundOps, fire]);

  const held: AvatarReaction | null = w.backgroundOps.some((o) => o.status === "processing")
    ? "working"
    : w.refreshing
      ? "refreshing"
      : w.hidden
        ? "hidden"
        : null;

  const reaction: AvatarReaction = shot && (shot.terminal || !held) ? shot.r : (held ?? "idle");
  return { reaction, nonce: shot?.nonce ?? 0 };
}
