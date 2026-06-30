// T2's private build. Same extension, its own source dir and its own output.
//
// The shared `.output/chrome-mv3` is what nine other agents point their suites
// at, so writing it mid-pass makes somebody else's run fail for a reason that
// is not theirs. This config builds the same tree somewhere nobody reads, and
// the suite is pointed at it with POCKET_EXT_PATH.
//
// POCKET_MUT_SRC is how a mutant is built: copy src, edit the copy, build it
// here. Nothing under src/ is ever modified.
import base from "./wxt.config";
import { defineConfig } from "wxt";

export default defineConfig({
  ...base,
  srcDir: process.env.POCKET_MUT_SRC ?? "src",
  outDir: process.env.POCKET_OUT_DIR ?? ".output-t2",
});
