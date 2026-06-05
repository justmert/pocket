// Copies bb.js's prebuilt browser bundle into public/vendor/bb/ so it ships
// inside the extension package and loads as native ESM at runtime.
//
// It must NOT go through the bundler. The 0.87.0 bundle declares a top-level
// `var __webpack_exports__` (index.js:2401) that collides with a bundler's own
// runtime, and it spawns its worker via
//   new Worker(new URL("./main.worker.js", import.meta.url))
// marked webpackIgnore. Bundled, that URL resolves to a hashed chunk that does
// not exist, and `createMainWorker` awaits readiness with no timeout and no
// reject path, so proving hangs forever with no error.
//
// MV3 forbids remotely hosted code, so vendoring is also what makes this legal:
// every byte we execute is in the package.
import { cpSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../../node_modules/@aztec/bb.js/dest/browser");
const dest = join(here, "../public/vendor/bb");

mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });

let total = 0;
for (const f of readdirSync(dest)) total += statSync(join(dest, f)).size;
console.log(`vendored bb.js browser build -> public/vendor/bb (${(total / 1e6).toFixed(1)} MB)`);
