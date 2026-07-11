// The lock screen's two shader layers.
//
// `Cover` is the background: a grain gradient carrying both pocket accents.
// `Wordmark` is the logo, put through the halftone treatment Mert specified.
//
// Five things about them are constraints rather than taste:
//
//   Nothing is fetched from anywhere. Both layers read colours and a packaged
//   image. The extension's CSP is `img-src 'self' data:`, and a wallet that
//   pulled a remote asset onto its lock screen would tell that host the time of
//   every unlock.
//
//   Neither moves. `speed={0}` renders one frame and stops. A lock screen is
//   opened dozens of times a day and closed in seconds; a shader animating
//   behind it costs battery for something nobody watches long enough to see. It
//   also means there is no motion to suppress for someone who asked for less.
//
//   `Cover`'s intensity is low on purpose. It sits behind body text, so the
//   accents are a wash rather than blocks of colour and the contrast of
//   everything drawn on top stays where it was measured.
//
//   `Wordmark`'s background is TRANSPARENT, which is what lets the accent wash
//   show through it. The shader maps the source image's luminance between
//   `colorBack` and `colorFront`, so a transparent `colorBack` means "paint
//   only the dark parts": the letterforms are inked and everything around them
//   is left alone. That is also why the source image has an opaque light
//   background rather than the alpha padding the raw logo ships with — a
//   transparent pixel reads as black and would ink the entire box.
//
//   Both are allowed to be absent. They need WebGL2, which Chrome does not
//   provide when hardware acceleration is off or the GPU is blocklisted. The
//   caller draws the plain canvas and the plain logo underneath either way, so
//   a machine without WebGL2 gets a flat cover rather than a blank screen.
import { GrainGradient, HalftoneDots } from "@paper-design/shaders-react";
import { accent, type Theme } from "./theme";

/** True when this context can actually run the shaders. */
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

/**
 * The logo, halftoned.
 *
 * Every parameter below is the configuration Mert arrived at on
 * shaders.paper.design, unchanged. The one departure is `colorBack`, which is
 * transparent here rather than the paper colour he picked, because on this
 * screen the logo sits over the accent wash instead of over paper.
 */
export function Wordmark({ height }: { height: number }) {
  return (
    <HalftoneDots
      width="100%"
      height={height}
      image="/logo-field.png"
      colorBack="rgba(0,0,0,0)"
      colorFront="#2b2b2b"
      originalColors={false}
      type="gooey"
      grid="hex"
      inverted={false}
      size={0.01}
      radius={2}
      contrast={1}
      grainMixer={0.05}
      grainOverlay={0.14}
      grainSize={0.14}
      scale={1.2}
      fit="contain"
      speed={0}
      style={{ display: "block" }}
    />
  );
}
