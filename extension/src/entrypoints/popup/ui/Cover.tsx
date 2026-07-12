// The lock screen's background.
//
// A clean, static dual-accent wash: the sky (public) pocket glowing from the top, the
// teal (private) pocket from the bottom, so the front door carries both pockets. Four
// things stay true, now with plain CSS instead of a shader:
//
//   Nothing is fetched. It reads two theme colours and nothing else; the extension's
//   CSP would let a remote asset on the lock screen leak the time of every unlock.
//
//   Nothing moves. A lock screen is opened dozens of times a day and closed in
//   seconds; there is no motion to cost battery or to suppress for reduced-motion.
//
//   The intensity is low on purpose: it sits behind body text and the unlock form, so
//   the accents are a wash and the contrast of everything on top stays measured.
//
//   It is always available. This replaced a WebGL2 grain shader (@paper-design), which
//   was absent whenever hardware acceleration was off; a CSS gradient needs no GPU, so
//   there is no "flat fallback" branch and no probe to run before rendering.
import { accent } from "./theme";

export function Cover() {
  return (
    <div
      aria-hidden
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        pointerEvents: "none",
        background: [
          `radial-gradient(130% 58% at 50% -10%, color-mix(in srgb, ${accent.public} 18%, transparent) 0%, transparent 60%)`,
          `radial-gradient(130% 52% at 50% 110%, color-mix(in srgb, ${accent.private} 14%, transparent) 0%, transparent 58%)`,
        ].join(", "),
      }}
    />
  );
}
