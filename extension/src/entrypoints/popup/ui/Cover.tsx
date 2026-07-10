// The lock screen's cover: a grain gradient carrying both pocket accents.
//
// The two accents are the product's whole visual argument — yellow is the
// public pocket, lilac is the private one — and the lock screen is the one
// place both can appear at once, because it sits in front of the choice rather
// than inside either pocket.
//
// Four things about it are constraints rather than taste:
//
//   Nothing is fetched. The shader is given colours, not a hosted image. The
//   extension's CSP is `img-src 'self' data:`, and a wallet that pulled a
//   remote asset onto its lock screen would tell that host the time of every
//   unlock.
//
//   It does not move. `speed={0}` renders one frame and stops. A lock screen is
//   opened dozens of times a day and closed in seconds; a shader animating
//   behind it costs battery for something nobody watches long enough to see. It
//   also means there is no motion to suppress for someone who asked for less.
//
//   `intensity` is low on purpose. This sits behind body text. The accents are
//   present as a wash rather than as blocks of colour, so the contrast of
//   everything drawn on top stays where it was measured.
//
//   It is allowed to be absent. The shader needs WebGL2, which Chrome does not
//   provide when hardware acceleration is off or the GPU is blocklisted. The
//   caller draws the plain canvas underneath either way, so a machine without
//   WebGL2 gets a flat cover rather than a blank screen.
import { GrainGradient } from "@paper-design/shaders-react";
import { accent, type Theme } from "./theme";

/** True when this context can actually run the shader. */
export function coverAvailable(): boolean {
  try {
    return document.createElement("canvas").getContext("webgl2") !== null;
  } catch {
    // Some environments throw rather than answer null.
    return false;
  }
}

export function Cover({ t, width, height }: { t: Theme; width: number; height: number }) {
  return (
    <div
      aria-hidden
      style={{ position: "absolute", inset: 0, overflow: "hidden", pointerEvents: "none" }}
    >
      <GrainGradient
        width={width}
        height={height}
        colorBack={t.bg}
        // Both accents, in the order the pockets appear in the product.
        colors={[accent.public, accent.private]}
        shape="wave"
        // The package's own `wave` preset values. Its intensity of 0.15 is the
        // reason this reads as a wash rather than as a pair of colour fields,
        // and its noise of 0.5 is the grain.
        softness={0.7}
        intensity={0.15}
        noise={0.5}
        speed={0}
        // Stopped, but not stopped at the beginning. These shaders develop
        // their field over time, so frame 0 is the least interesting frame
        // there is and can be close to flat. This picks one well into the
        // sequence and holds it.
        frame={9000}
      />
    </div>
  );
}
