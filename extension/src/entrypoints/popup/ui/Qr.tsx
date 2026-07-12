// a qr code, drawn rather than fetched.
//
// modules are discs and the three finders are rounded frames, so the code reads
// as part of the product instead of a pasted-in bitmap. error correction is at
// level m, which tolerates the rounded corners without needing a larger code.
import qrcode from "qrcode-generator";
import { fixed, radius } from "./theme";

export function Qr({ value, size = 214 }: { value: string; size?: number }) {
  const qr = qrcode(0, "M");
  qr.addData(value);
  qr.make();

  const count = qr.getModuleCount();
  const margin = 1;
  const span = count + margin * 2;
  const cell = size / span;
  const r = cell * 0.42;

  const dots: string[] = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      if (inFinder(row, col, count)) continue;
      const cx = (col + margin + 0.5) * cell;
      const cy = (row + margin + 0.5) * cell;
      dots.push(`M${cx - r},${cy}a${r},${r} 0 1,0 ${r * 2},0a${r},${r} 0 1,0 ${-r * 2},0`);
    }
  }

  const finders: [number, number][] = [
    [0, 0],
    [0, count - 7],
    [count - 7, 0],
  ];

  return (
    <div
      style={{
        // the code keeps a light field of its own so a scanner still reads it
        // when the private pocket has taken the surface dark.
        background: fixed.qrBg,
        borderRadius: radius.lg,
        padding: 12,
        display: "inline-block",
        lineHeight: 0,
        // at 200% zoom and above the frame is narrower than the code's natural
        // 214px, and a truncated qr is not a qr: a scanner cannot decode it, and
        // the failure looks like the sender's camera being bad rather than the
        // wallet drawing something impossible. so the box gives way and the svg
        // scales with it.
        maxWidth: "100%",
        boxSizing: "border-box",
      }}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label="Your address as a QR code"
        style={{ maxWidth: "100%", height: "auto", display: "block" }}
      >
        <path d={dots.join(" ")} fill={fixed.qrFg} />
        {finders.map(([row, col], i) => {
          const x = (col + margin) * cell;
          const y = (row + margin) * cell;
          const s = cell * 7;
          return (
            <g key={i}>
              <rect x={x} y={y} width={s} height={s} rx={cell * 2.1} fill={fixed.qrFg} />
              <rect
                x={x + cell}
                y={y + cell}
                width={s - cell * 2}
                height={s - cell * 2}
                rx={cell * 1.5}
                fill={fixed.qrBg}
              />
              <rect
                x={x + cell * 2}
                y={y + cell * 2}
                width={s - cell * 4}
                height={s - cell * 4}
                rx={cell * 1.05}
                fill={fixed.qrFg}
              />
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** the three position markers are drawn as frames, so their modules are skipped. */
function inFinder(row: number, col: number, count: number): boolean {
  const near = (a: number, b: number) => a >= b && a < b + 7;
  return (
    (near(row, 0) && near(col, 0)) ||
    (near(row, 0) && near(col, count - 7)) ||
    (near(row, count - 7) && near(col, 0))
  );
}
