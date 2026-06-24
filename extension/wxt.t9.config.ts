// T9's private build. Same extension, a COPY of the source, its own output.
//
// Ten agents share this checkout and several of them build. A shared
// .output/chrome-mv3 changes underneath a timing run, which is fatal for
// measurements: T1 recorded a run reddened by another agent's mutant sitting in
// the shared output. Every number in _test/T9.md therefore comes from a build
// this file produced, pointed at with POCKET_EXT_PATH, and .output-mutant is
// left to whoever is using it.
import base from "./wxt.config";
import { defineConfig } from "wxt";

export default defineConfig({
  ...base,
  srcDir: process.env.POCKET_T9_SRC ?? "src",
  outDir: process.env.POCKET_T9_OUT ?? ".output-t9",
});
