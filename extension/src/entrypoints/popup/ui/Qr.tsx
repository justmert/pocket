// a qr code, drawn rather than fetched.
//
// modules are discs and the three finders are rounded frames, so the code reads
// as part of the product instead of a pasted-in bitmap. error correction is at
// level m, which tolerates the rounded corners without needing a larger code.
import qrcode from "qrcode-generator";
import { radius, type Theme } from "./theme";

export function Qr({ t, value, size = 214 }: { t: Theme; value: string; size?: number }) {
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
        background: "#FFFFFF",
        borderRadius: radius.lg,
        padding: 12,
        display: "inline-block",
        lineHeight: 0,
      }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label="Your address as a QR code">
        <path d={dots.join(" ")} fill="#14151A" />
        {finders.map(([row, col], i) => {
          const x = (col + margin) * cell;
          const y = (row + margin) * cell;
          const s = cell * 7;
          return (
            <g key={i}>
              <rect x={x} y={y} width={s} height={s} rx={cell * 2.1} fill="#14151A" />
              <rect
                x={x + cell}
                y={y + cell}
                width={s - cell * 2}
                height={s - cell * 2}
                rx={cell * 1.5}
                fill="#FFFFFF"
              />
              <rect
                x={x + cell * 2}
                y={y + cell * 2}
                width={s - cell * 4}
                height={s - cell * 4}
                rx={cell * 1.05}
                fill={t.dark ? "#14151A" : "#14151A"}
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
