// a friendly face that stands in for the account.
//
// there is only ever one account in this wallet, so a per-address generated
// avatar said nothing worth the dependency it cost. a small face is warmer, and
// it earns its place by doing one useful thing: it closes its eyes in the private
// pocket and opens them in the public one, so the mark itself carries which
// pocket you are in, alongside the accent it is wearing.
//
// drawn as inline svg on the device: nothing fetched, no dependency, and it
// recolours and blinks through the theme like everything else.
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import type { Theme } from "./theme";

/**
 * `aria-hidden` because it is decorative. the address next to it is the real
 * identity and is already announced; a face described aloud would add noise.
 */
export function Avatar({
  t,
  eyesClosed = false,
  size = 44,
  style,
}: {
  t: Theme;
  /** eyes shut in the private pocket, open in the public one. */
  eyesClosed?: boolean;
  size?: number;
  style?: CSSProperties;
}) {
  // an occasional idle blink keeps the face alive rather than a frozen mask. it is
  // skipped while the eyes are held shut (private) and for reduced-motion users.
  const [blink, setBlink] = useState(false);
  useEffect(() => {
    if (eyesClosed) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let alive = true;
    let wait: ReturnType<typeof setTimeout>;
    let hold: ReturnType<typeof setTimeout>;
    const loop = () => {
      wait = setTimeout(
        () => {
          if (!alive) return;
          setBlink(true);
          hold = setTimeout(() => {
            if (!alive) return;
            setBlink(false);
            loop();
          }, 150);
        },
        2600 + Math.random() * 3400,
      );
    };
    loop();
    return () => {
      alive = false;
      clearTimeout(wait);
      clearTimeout(hold);
    };
  }, [eyesClosed]);

  // squish the eyes shut around their own centre. a springy ease makes the open
  // read as a blink rather than a slide.
  const eye: CSSProperties = {
    transformBox: "fill-box",
    transformOrigin: "center",
    transform: eyesClosed || blink ? "scaleY(0.12)" : "scaleY(1)",
    transition: "transform 260ms cubic-bezier(0.34, 1.56, 0.64, 1)",
  };
  return (
    <span aria-hidden style={{ display: "inline-flex", flex: "0 0 auto", lineHeight: 0, ...style }}>
      <svg width={size} height={size} viewBox="0 0 44 44" fill="none">
        {/* the head wears the pocket's accent and crossfades when it changes. */}
        <circle cx={22} cy={22} r={22} fill={t.accent} style={{ transition: "fill 400ms ease" }} />
        <ellipse cx={15.5} cy={19} rx={2.7} ry={3.6} fill={t.onAccent} style={eye} />
        <ellipse cx={28.5} cy={19} rx={2.7} ry={3.6} fill={t.onAccent} style={eye} />
        <path
          d="M14.5 27.5 Q22 33.5 29.5 27.5"
          stroke={t.onAccent}
          strokeWidth={2.4}
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </span>
  );
}
