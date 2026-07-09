// The prover's one native-ESM import must name the EXTENSION, not the origin
// that happened to serve the module.
//
// bb.js is loaded with a dynamic `import()` rather than through the bundler,
// and a dynamic import's specifier is resolved against the URL of the module
// performing it. In the shipped package that module is
// chrome-extension://<id>/offscreen.js, so "/vendor/bb/index.js" resolved to
// the vendored bundle and everything worked. Under `wxt dev` the same module is
// served from http://localhost:3000, so the identical specifier resolved to the
// Vite dev server, which refuses to hand back a file it copies verbatim out of
// public/:
//
//   Failed to load url /vendor/bb/index.js (resolved id: /vendor/bb/index.js).
//   This file is in /public and will be copied as-is during build ...
//
// `init()` therefore threw, the private pocket could not be registered at all in
// a development build, and the wallet reported it as "Something went wrong. Try
// again, and check your connection." — a network problem, which it was not.
//
// `chrome.runtime.getURL` returns an absolute chrome-extension:// URL in both
// builds, so the file cannot be retargeted by where the code was served from.
// This is checked in the source rather than at runtime because the failure only
// appears under the dev server, which no test in this repository runs against:
// every browser suite loads the BUILT artifact, where the old specifier worked.
//
// `fetch()` in the same file is deliberately left alone. It resolves against the
// DOCUMENT's base URL, which is chrome-extension:// in both builds, so the SRS
// and circuit reads were never affected and rewriting them would be noise.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = readFileSync(
  fileURLToPath(new URL("../../src/entrypoints/offscreen/main.ts", import.meta.url)),
  "utf8",
);

describe("the offscreen prover's import of the vendored bb.js bundle", () => {
  it("resolves against the extension rather than the serving origin", () => {
    expect(
      SOURCE,
      "the vendored bundle must be addressed by chrome.runtime.getURL, or a dev build cannot prove",
    ).toContain('chrome.runtime.getURL("vendor/bb/index.js")');
  });

  it("uses no root-relative module specifier anywhere", () => {
    // A root-relative specifier is the exact shape of the defect: correct in the
    // package, wrong the moment the module is served from anywhere else.
    const rootRelativeImports = [...SOURCE.matchAll(/import\(\s*["'](\/[^"']*)["']/g)].map(
      (m) => m[1],
    );
    expect(
      rootRelativeImports,
      "a root-relative dynamic import resolves against whatever origin served this module",
    ).toEqual([]);
  });

  it("still imports it as native ESM rather than letting the bundler take it", () => {
    // The other half of the invariant. bb.js 0.87.0's browser build spawns its
    // worker from a webpackIgnore-marked import.meta.url; bundled, that resolves
    // to a chunk which does not exist and createMainWorker hangs with no error.
    // A static import would hand it to the bundler.
    expect(SOURCE).toMatch(/await import\(\s*\/\* @vite-ignore \*\/\s*BB_PATH\s*\)/);
    expect(SOURCE).not.toMatch(/^import .*vendor\/bb/m);
  });
});
